import { conversationHistory } from "../../bundled/codex/history";
import { createMessages } from "./messages";
import type { Outbox } from "./outbox";
import type { ProfileQueries } from "./profile-directory";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { assert, expect, it, vi } from "vitest";
import { eventDto, type RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import { createRelaySession } from "./session";
import { createProfileDirectory } from "./profile-directory";
import { createRelayReader } from "./reader";
import { foldMessages } from "./fold";
import { MessageProjection } from "./message-projection";
import { createRelayProfiler } from "./profiling";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

vi.mock("./fold", async (actual) => {
  const fold = await actual<typeof import("./fold")>();
  return { ...fold, foldMessages: vi.fn(fold.foldMessages) };
});
/** Unread previews fold with no viewer; other projections pass one. */
const unreadFolds = () =>
  vi.mocked(foldMessages).mock.calls.filter(([, author]) => author === "");

it("admits owner edits only after verifying the current signed profile, and revokes replaced evidence", async () => {
  const owner = keypair(),
    agent = keypair(),
    stranger = keypair(),
    relay = keypair();
  const wire = scriptedTransport(owner.pubkey, relay.pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  const auth = (key = owner) => [
    "auth",
    key.pubkey,
    "",
    bytesToHex(
      schnorr.sign(
        createHash("sha256")
          .update(`nostr:agent-auth:${agent.pubkey}:`)
          .digest(),
        key.secret,
      ),
    ),
  ];
  const profile = eventDto(
    signed(agent, { kind: 0, created_at: 10, content: "{}", tags: [auth()] }),
  );
  const original = message(agent, "c", "Whole answer", 11);
  const edit = signed(owner, {
    kind: 40003,
    content: "Spoken",
    created_at: 12,
    tags: [
      ["h", "c"],
      ["e", original.id],
    ],
  });
  const projection = new MessageProjection(
    "c",
    relay.pubkey,
    createRelayProfiler(),
    undefined,
    undefined,
    directory.queries.owner,
  );
  const rows = () => projection.reconcile([original, edit], []);
  try {
    expect(rows()[0]?.content).toBe("Whole answer");
    directory.accept([profile]);
    await vi.waitFor(() =>
      expect(directory.queries.owner?.(agent.pubkey)).toBe(owner.pubkey),
    );
    expect(rows()[0]?.content).toBe("Spoken");
    expect(
      foldMessages(
        "c",
        relay.pubkey,
        [
          original,
          signed(stranger, {
            kind: 40003,
            content: "Forged",
            created_at: 14,
            tags: [
              ["h", "c"],
              ["e", original.id],
            ],
          }),
        ],
        { agentOwner: directory.queries.owner },
      )[0]?.content,
    ).toBe("Whole answer");
    directory.accept([
      eventDto(
        signed(agent, { kind: 0, created_at: 13, content: "{}", tags: [] }),
      ),
    ]);
    expect(rows()[0]?.content).toBe("Whole answer");
    directory.accept([profile]);
    expect(rows()[0]?.content).toBe("Whole answer");
  } finally {
    directory.dispose();
    reader.dispose();
  }
});

it.each(["member", "guest"])(
  "publishes a %s owner's agent edit through the real session and refuses a foreign agent",
  async (role) => {
    const owner = keypair(),
      agent = keypair(),
      stranger = keypair(),
      relay = keypair();
    const wire = scriptedTransport(owner.pubkey, relay.pubkey);
    const published: RelayEvent[] = [];
    let live!: LiveCallbacks;
    const connection = createRelaySession(
      {
        ...wire.transport,
        archiveAuthority: relay.pubkey,
        writer: {
          sign: async (template) => signed(owner, template),
          publish: async (event) => {
            published.push(event);
          },
        },
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { outboxStorage: { load: () => [], save() {} } },
    );
    const profile = (author: typeof agent, controller: typeof owner) =>
      eventDto(
        signed(author, {
          kind: 0,
          created_at: 10,
          content: "{}",
          tags: [
            [
              "auth",
              controller.pubkey,
              "",
              bytesToHex(
                schnorr.sign(
                  createHash("sha256")
                    .update(`nostr:agent-auth:${author.pubkey}:`)
                    .digest(),
                  controller.secret,
                ),
              ),
            ],
          ],
        }),
      );
    const original = message(agent, "c", "Whole answer", 11);
    const foreign = message(stranger, "c", "Foreign answer", 11);
    try {
      connection.session.channels.ensure("c");
      live.receive([
        signed(relay, {
          kind: 39002,
          created_at: 1,
          content: "",
          tags: [
            ["d", "c"],
            ["p", owner.pubkey, "", role],
            ["p", agent.pubkey, "", "bot"],
            ["p", stranger.pubkey, "", "bot"],
          ],
        }),
        original,
        foreign,
        profile(agent, owner),
        profile(stranger, stranger),
      ]);
      await connection.session.outbox?.ready();
      // A guest's edit is signed only once the directory's own attestation
      // names its owner; editOwnedAgent's check can settle first.
      await vi.waitFor(() =>
        expect(connection.session.profiles.owner?.(agent.pubkey)).toBe(
          owner.pubkey,
        ),
      );
      await expect(
        connection.session.messages.editOwnedAgent(
          foreign.id,
          "Forged",
          foreign.id,
        ),
      ).rejects.toThrow("verified owner");
      expect(published.filter((event) => event.kind === 40003)).toEqual([]);
      const id = await connection.session.messages.editOwnedAgent(
        original.id,
        "Spoken",
        original.id,
      );
      await vi.waitFor(() =>
        expect(published.some((event) => event.id === id)).toBe(true),
      );
      const edit = published.find((event) => event.id === id);
      if (!edit) throw new Error("Missing owner edit");
      expect(edit).toMatchObject({
        kind: 40003,
        pubkey: owner.pubkey,
        content: "Spoken",
      });
      expect(edit.tags).toContainEqual(["e", original.id]);
      live.receive([edit]);
      await vi.waitFor(() =>
        expect(
          connection.session.channels
            .window("c")
            .rows.find((row) => row.id === original.id)?.content,
        ).toBe("Spoken"),
      );
      const removed = await connection.session.messages.editOwnedAgent(
        original.id,
        "",
        original.id,
      );
      await vi.waitFor(() =>
        expect(
          published.some((event) => event.id === removed && event.kind === 5),
        ).toBe(true),
      );
    } finally {
      connection.dispose();
    }
  },
);

it("lets the original author preserve attachments from a verified owner edit", () => {
  const author = keypair(),
    owner = keypair();
  const media = ["imeta", "url https://example.test/image.png", "m image/png"];
  const original = signed(author, {
    kind: 9,
    content: "Original",
    tags: [["h", "c"], media],
  });
  const source = signed(owner, {
    kind: 40003,
    content: "Spoken",
    tags: [["h", "c"], ["e", original.id], media],
  });
  const send = vi.fn(() => "operation");
  const messages = createMessages(
    { supports: () => true, send } as unknown as Outbox,
    author.pubkey,
    (id) => [original, source].find((event) => event.id === id),
    () => [],
    () => {},
    () => true,
    undefined,
    undefined,
    undefined,
    { owner: () => owner.pubkey } as unknown as ProfileQueries,
  );
  expect(messages.edit(original.id, "Revised", source.id)).toBe("operation");
  expect(send).toHaveBeenCalledWith({
    kind: 40003,
    content: "Revised",
    tags: [["h", "c"], ["e", original.id], media],
  });
});

it("lets the original agent forward a reply with verified owner-edited media", () => {
  const author = keypair(),
    owner = keypair();
  const media = ["imeta", "url https://example.test/image.png", "m image/png"];
  const original = signed(author, {
    kind: 9,
    created_at: 10,
    content: "Original",
    tags: [["h", "c"], ["e", "f".repeat(64), "", "reply"], media],
  });
  const source = signed(owner, {
    kind: 40003,
    created_at: 11,
    content: "Spoken",
    tags: [["h", "c"], ["e", original.id], media],
  });
  const send = vi.fn(() => "forwarded");
  let verified = true;
  const messages = createMessages(
    { supports: () => true, send } as unknown as Outbox,
    author.pubkey,
    (id) => [original, source].find((event) => event.id === id),
    () => [],
    () => {},
    () => true,
    undefined,
    undefined,
    undefined,
    {
      owner: () => (verified ? owner.pubkey : undefined),
    } as unknown as ProfileQueries,
  );
  const row = foldMessages("c", "", [original, source], {
    includeReplies: true,
    agentOwner: () => owner.pubkey,
  })[0];
  assert(row);
  expect(row.attachmentSourceId).toBe(source.id);
  expect(messages.sendToChannel(row)).toBe("forwarded");
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 9,
      content: "Spoken",
      tags: expect.arrayContaining([media]),
    }),
  );
  verified = false;
  expect(() => messages.sendToChannel(row)).toThrow(
    "Reload the message attachments",
  );
});

it.each(["head", "tail"])(
  "refolds an unopened channel's %s on owner verification and revocation",
  async (mode) => {
    const owner = keypair(),
      agent = keypair(),
      relay = keypair();
    const wire = scriptedTransport(owner.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const connection = createRelaySession(
      {
        ...wire.transport,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { prepared: true },
    );
    const original = message(agent, "c", "Whole answer", 11);
    const edit = signed(owner, {
      kind: 40003,
      created_at: 12,
      content: "Spoken",
      tags: [
        ["h", "c"],
        ["e", original.id],
      ],
    });
    const profile = eventDto(
      signed(agent, {
        kind: 0,
        created_at: 10,
        content: "{}",
        tags: [
          [
            "auth",
            owner.pubkey,
            "",
            bytesToHex(
              schnorr.sign(
                createHash("sha256")
                  .update(`nostr:agent-auth:${agent.pubkey}:`)
                  .digest(),
                owner.secret,
              ),
            ),
          ],
        ],
      }),
    );
    const channels = connection.session.channels;
    const preview = () =>
      channels.list().channels.find((channel) => channel.id === "c")?.preview;
    try {
      live.receive([roster(relay, "c", [owner.pubkey, agent.pubkey], 1)]);
      if (mode === "head") {
        channels.prepare?.("c");
        wire
          .next()
          .respond([
            original,
            edit,
            bounds(relay, "c", "head", { has_more: false, next_cursor: null }),
          ]);
        await flush();
      } else live.receive([original, edit]);
      expect(connection.retainedChannels()).toEqual([]);
      expect(preview()).toBe("Whole answer");
      live.receive([profile]);
      await vi.waitFor(() => expect(preview()).toBe("Spoken"));
      live.receive([
        eventDto(
          signed(agent, { kind: 0, created_at: 13, content: "{}", tags: [] }),
        ),
      ]);
      await vi.waitFor(() => expect(preview()).toBe("Whole answer"));
    } finally {
      connection.dispose();
    }
  },
);

it("refreshes an unopened channel's tail preview after its head changes", async () => {
  const author = keypair(),
    relay = keypair();
  const wire = scriptedTransport(author.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const connection = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { prepared: true },
  );
  const original = message(author, "c", "Original", 11);
  const edit = signed(author, {
    kind: 40003,
    created_at: 12,
    content: "Edited",
    tags: [
      ["h", "c"],
      ["e", original.id],
    ],
  });
  const channels = connection.session.channels;
  const preview = () =>
    channels.list().channels.find((channel) => channel.id === "c")?.preview;
  try {
    live.receive([roster(relay, "c", [author.pubkey], 1), original]);
    live.receive([eventDto(profile(keypair(), { name: "First" }))]);
    await flush();
    expect(preview()).toBe("Original");
    channels.prepare?.("c");
    wire
      .next()
      .respond([
        original,
        edit,
        bounds(relay, "c", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    live.receive([eventDto(profile(keypair(), { name: "Second" }))]);
    await vi.waitFor(() => expect(preview()).toBe("Edited"));
  } finally {
    connection.dispose();
  }
});

it.each(["actor", "p"])(
  "fetches a cold %s-attributed agent profile for owner-edited unread previews",
  async (attribution) => {
    const owner = keypair(),
      agent = keypair(),
      relay = keypair();
    const wire = scriptedTransport(owner.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const connection = createRelaySession(
      {
        ...wire.transport,
        archiveAuthority: relay.pubkey,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { readStateFloor: () => 0 },
    );
    const root = message(owner, "c", "Question", 10);
    const original = signed(relay, {
      kind: 9,
      created_at: 11,
      content: "Whole answer",
      tags: [
        [attribution, agent.pubkey],
        ["h", "c"],
        ["e", root.id, "", "reply"],
      ],
    });
    const edit = signed(owner, {
      kind: 40003,
      created_at: 12,
      content: "Spoken",
      tags: [
        ["h", "c"],
        ["e", original.id],
      ],
    });
    const profile = signed(agent, {
      kind: 0,
      created_at: 10,
      content: "{}",
      tags: [
        [
          "auth",
          owner.pubkey,
          "",
          bytesToHex(
            schnorr.sign(
              createHash("sha256")
                .update(`nostr:agent-auth:${agent.pubkey}:`)
                .digest(),
              owner.secret,
            ),
          ),
        ],
      ],
    });
    const { unread, profiles } = connection.session;
    try {
      live.receive([
        roster(relay, "c", [owner.pubkey, agent.pubkey], 1),
        metadata(relay, "c", "c", 1),
        root,
        original,
      ]);
      expect(profiles.owner?.(agent.pubkey)).toBeUndefined();
      expect(unread.activity("c").items?.[0]?.preview).toBe("Whole answer");
      expect(unread.inbox().items?.[0]?.preview).toBe("Whole answer");
      live.receive([edit]);
      await vi.waitFor(() => {
        const request = wire.pending.find(({ filters }) =>
          filters.some(
            (filter) =>
              filter.kinds?.includes(0) &&
              filter.authors?.includes(agent.pubkey),
          ),
        );
        assert(
          request,
          "Expected ownership profile request for attributed agent",
        );
        request.respond([eventDto(profile)]);
      });
      await vi.waitFor(() => {
        expect(unread.activity("c").items?.[0]?.preview).toBe("Spoken");
        expect(unread.inbox().items?.[0]?.preview).toBe("Spoken");
      });
      expect(connection.retainedChannels()).toEqual([]);
    } finally {
      connection.dispose();
    }
  },
);

it("uses the same verified owner edit in the conversation, prompt history and unread previews", async () => {
  const owner = keypair(),
    agent = keypair(),
    relay = keypair();
  const wire = scriptedTransport(owner.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const connection = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { readStateFloor: () => 0 },
  );
  const root = message(owner, "c", "Question", 10);
  const original = signed(agent, {
    kind: 9,
    created_at: 11,
    content: "Whole answer",
    tags: [
      ["h", "c"],
      ["e", root.id, "", "reply"],
      ["p", owner.pubkey],
    ],
  });
  const edit = signed(owner, {
    kind: 40003,
    created_at: 12,
    content: "Spoken",
    tags: [
      ["h", "c"],
      ["e", original.id],
    ],
  });
  let profile = eventDto(
    signed(agent, {
      kind: 0,
      created_at: 10,
      content: "{}",
      tags: [
        [
          "auth",
          owner.pubkey,
          "",
          bytesToHex(
            schnorr.sign(
              createHash("sha256")
                .update(`nostr:agent-auth:${agent.pubkey}:`)
                .digest(),
              owner.secret,
            ),
          ),
        ],
      ],
    }),
  );
  const history = () =>
    conversationHistory(
      message(owner, "c", "Next question", 20),
      { channelId: "c", name: "c", root: root.id },
      async (filters) =>
        filters[0]?.kinds?.includes(40003) ? [edit] : [root, original],
      { profiles: async () => {}, profile: () => profile },
    );
  const { unread, channels } = connection.session;
  const changed = vi.fn();
  try {
    channels.ensure("c");
    live.receive([
      roster(relay, "c", [owner.pubkey, agent.pubkey], 1),
      metadata(relay, "c", "c", 1),
      root,
      original,
      edit,
    ]);
    const view = connection.session.thread("c", root.id);
    expect(unread.activity("c").items?.[0]?.preview).toBe("Whole answer");
    expect(unread.inbox().items?.[0]?.preview).toBe("Whole answer");
    unread.subscribeActivity("c", changed);
    unread.subscribeInbox(changed);
    live.receive([profile]);
    await vi.waitFor(() =>
      expect(
        view.snapshot().replies.find((row) => row.id === original.id)?.content,
      ).toBe("Spoken"),
    );
    expect(await history()).toContain('"content":"Spoken"');
    expect(unread.activity("c").items?.[0]?.preview).toBe("Spoken");
    expect(unread.inbox().items?.[0]?.preview).toBe("Spoken");
    expect(changed).toHaveBeenCalled();
    // A profile no fold read cannot change the previews: no refold.
    vi.mocked(foldMessages).mockClear();
    const stranger = keypair();
    live.receive([
      signed(stranger, {
        kind: 0,
        created_at: 12,
        content: '{"name":"Stranger"}',
        tags: [],
      }),
    ]);
    await vi.waitFor(() =>
      expect(
        connection.session.profiles.snapshot().get(stranger.pubkey)?.name,
      ).toBe("Stranger"),
    );
    expect(unreadFolds()).toHaveLength(0);
    profile = eventDto(
      signed(agent, { kind: 0, created_at: 13, content: "{}", tags: [] }),
    );
    live.receive([profile]);
    await vi.waitFor(() =>
      expect(unread.activity("c").items?.[0]?.preview).toBe("Whole answer"),
    );
    expect(unread.inbox().items?.[0]?.preview).toBe("Whole answer");
    expect(
      view.snapshot().replies.find((row) => row.id === original.id)?.content,
    ).toBe("Whole answer");
    expect(await history()).toContain('"content":"Whole answer"');
  } finally {
    connection.dispose();
  }
});
