import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { eventDto } from "./events";
import { createRelaySession } from "./session";
import { keypair, message, metadata, roster, signed } from "./testing";
import type { RelayEvent, ReadFilter } from "./events";
import type { LiveCallbacks } from "./live";
import { byteSize } from "./budget";
import { createInboxFeed } from "./inbox-feed";

// General #e reads return an empty terminal page. The ordinary #p response is
// still explicitly gated by each test; no incidental timer orders admission.
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function setup(attributed = false) {
  const viewer = keypair(),
    relay = keypair(),
    alice = keypair();
  let live!: LiveCallbacks;
  const calls: {
    filters: readonly ReadFilter[];
    pending: ReturnType<typeof deferred<RelayEvent[]>>;
  }[] = [];
  const query = vi.fn((filters: readonly ReadFilter[]) => {
    if (filters[0]?.["#e"] || filters[0]?.authors)
      return Promise.resolve([] as RelayEvent[]);
    const pending = deferred<RelayEvent[]>();
    calls.push({ filters, pending });
    return pending.promise;
  });
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    ...(attributed ? { archiveAuthority: relay.pubkey } : {}),
    query,
    media: () => undefined,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  const admit = (members: string[], at = 10) =>
    live.receive([
      roster(relay, "room", members, at),
      metadata(relay, "room", "Room", at),
    ]);
  return { ...owner, viewer, alice, relay, admit, calls, live, query };
}
async function take(h: ReturnType<typeof setup>, kind: number) {
  await vi.waitFor(() =>
    expect(h.calls.some((call) => call.filters[0]?.kinds?.includes(kind))).toBe(
      true,
    ),
  );
  const index = h.calls.findIndex((call) =>
    call.filters[0]?.kinds?.includes(kind),
  );
  const call = h.calls.splice(index, 1)[0];
  if (!call) throw new Error("Missing expected feed query");
  return call.pending;
}
it("reads addressed history independently of the retained unread window, never a fake complete archive", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const addressed = message(h.alice, "room", "older mention", 20, [
    ["p", h.viewer.pubkey],
  ]);
  const other = message(h.alice, "room", "not addressed", 21);
  const work = h.session.inboxFeed.ensure();
  const mentions = await take(h, 9);
  expect(mentions.promise).toBeDefined();
  mentions.resolve([addressed, other]);
  await work;
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "ready",
    incomplete: [],
  });
  // The session reconciles authorized history into shared unread evidence, not a shadow store.
  expect(h.session.unread.inbox().items.map((item) => item.messageId)).toEqual([
    addressed.id,
  ]);
  expect(h.session.channels.window("room").rows).toEqual([]);
  expect(h.query).toHaveBeenCalledTimes(3); // addressed #p and exact #e terminal page
  expect(h.query.mock.calls[1]?.[0]).toEqual([
    {
      kinds: [40003, 5, 9005],
      "#e": [addressed.id],
      limit: 500,
    },
  ]);
  expect(h.query.mock.calls[0]?.[0]).toEqual([
    { kinds: [40002, 9], "#p": [h.viewer.pubkey], limit: 50 },
  ]);
});
it("reconciles live addressed updates and drops membership-revoked history before listeners", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const work = h.session.inboxFeed.ensure();
  const mentions = await take(h, 9);
  const first = addressed(h, "first", 20);
  mentions.resolve([first]);
  await work;
  expect(rows(h).map((row) => row.messageId)).toEqual([first.id]);
  const updates: string[][] = [];
  h.session.unread.subscribeInbox(() =>
    updates.push(rows(h).map((row) => row.messageId)),
  );
  const later = addressed(h, "later", 22);
  h.live.receive([later]);
  expect(rows(h).map((row) => row.messageId)).toEqual([later.id, first.id]);
  expect(updates).toEqual([[later.id, first.id]]);
  h.admit([h.alice.pubkey], 30);
  expect(rows(h)).toEqual([]);
  // The revocation notification itself must already expose empty rows.
  expect(updates).toEqual([[later.id, first.id], []]);
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "idle",
    incomplete: [],
  });
});
it("cache clear fences late completions; fresh demand recovers", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey]);
  const old = addressed(h, "old", 20);
  h.live.receive([old]);
  expect(rows(h).map((row) => row.messageId)).toEqual([old.id]);
  const work = h.session.inboxFeed.ensure();
  const mentions = await take(h, 9);
  await h.clearCache();
  expect(rows(h)).toEqual([]);
  mentions.resolve([old]);
  await work;
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "idle",
    incomplete: [],
  });
  expect(rows(h)).toEqual([]);
  expect(h.query).toHaveBeenCalledTimes(1);
  const again = h.session.inboxFeed.ensure();
  (await take(h, 9)).resolve([]);
  await again;
  expect(h.session.inboxFeed.snapshot().status).toBe("ready");
});
it("surfaces read denial without treating it as empty, then retries", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey]);
  const work = h.session.inboxFeed.ensure();
  (await take(h, 9)).reject(new Error("restricted: feed unavailable"));
  await work;
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "error",
    error: "restricted: feed unavailable",
  });
  const again = h.session.inboxFeed.refresh();
  (await take(h, 9)).resolve([]);
  await again;
  expect(h.session.inboxFeed.snapshot().status).toBe("ready");
});

async function discover(h: ReturnType<typeof setup>) {
  h.session.channels.ensureList();
  (await take(h, 39002)).resolve([
    roster(h.relay, "room", [h.viewer.pubkey, h.alice.pubkey], 10),
    metadata(h.relay, "room", "Room", 10),
  ]);
  await vi.waitFor(() =>
    expect(h.session.channels.list().status).toBe("ready"),
  );
}
const rows = (h: ReturnType<typeof setup>) => h.session.unread.inbox().items;
const addressed = (h: ReturnType<typeof setup>, text: string, at: number) =>
  message(h.alice, "room", text, at, [["p", h.viewer.pubkey]]);
it("complete initial roster remains lazy; first demand, invalidation and fresh demand really read", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const h = setup();
  await discover(h);
  expect(
    h.query.mock.calls.some(([filters]) =>
      filters.some((filter) => !!filter["#p"] && filter.kinds?.includes(9)),
    ),
  ).toBe(false);
  expect(h.session.inboxFeed.snapshot().status).toBe("idle");
  const first = h.session.inboxFeed.ensure();
  const gate = await take(h, 9);
  expect(h.session.inboxFeed.snapshot().status).toBe("loading");
  const issue = addressed(h, "historical mention", 15);
  gate.resolve([issue]);
  await first;
  expect(rows(h).map((row) => row.preview)).toContain("historical mention");
  const addressedReads = () =>
    h.query.mock.calls.filter(([filters]) =>
      filters.some((filter) => !!filter["#p"] && filter.kinds?.includes(9)),
    ).length;
  const count = addressedReads();
  expect(count).toBe(1);
  h.admit([h.alice.pubkey], 30);
  expect(rows(h)).toEqual([]);
  // Admission/listeners run synchronously; drain microtasks and the existing
  // zero-delay scheduling boundary before granting any fresh Inbox demand.
  await vi.advanceTimersByTimeAsync(0);
  expect(addressedReads()).toBe(count);
  expect(h.session.inboxFeed.snapshot().status).toBe("idle");
  const next = h.session.inboxFeed.ensure();
  const fresh = await take(h, 9);
  expect(addressedReads()).toBe(count + 1);
  fresh.resolve([issue]);
  await next;
  expect(h.session.inboxFeed.snapshot().status).toBe("ready");
  expect(rows(h)).toEqual([]);
});
it("reconnect recovers demanded feed but never starts an unopened feed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const h = setup();
  await discover(h);
  h.live.state({ status: "connected", routes: [] });
  h.live.state({ status: "retrying", routes: [] });
  h.live.state({ status: "connected", routes: [] });
  h.live.established();
  await vi.advanceTimersByTimeAsync(0);
  // Complete the roster and the existing zero-delay reconnect callback explicitly.
  (await take(h, 39002)).resolve([
    roster(h.relay, "room", [h.viewer.pubkey, h.alice.pubkey], 10),
    metadata(h.relay, "room", "Room", 10),
  ]);
  await vi.waitFor(() =>
    expect(h.session.channels.list().status).toBe("ready"),
  );
  expect(h.session.inboxFeed.snapshot().status).toBe("idle");
  const first = h.session.inboxFeed.ensure();
  (await take(h, 9)).resolve([]);
  await first;
  h.live.state({ status: "retrying", routes: [] });
  expect(h.session.inboxFeed.snapshot().status).toBe("idle");
  h.live.state({ status: "connected", routes: [] });
  h.live.established();
  await vi.advanceTimersByTimeAsync(0);
  (await take(h, 39002)).resolve([
    roster(h.relay, "room", [h.viewer.pubkey, h.alice.pubkey], 10),
    metadata(h.relay, "room", "Room", 10),
  ]);
  (await take(h, 9)).resolve([addressed(h, "reconnected mention", 30)]);
  await vi.waitFor(() =>
    expect(h.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  expect(rows(h).map((row) => row.preview)).toContain("reconnected mention");
});
it("finite completion merges concurrent live chat arrivals and author deletions", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const old = addressed(h, "old", 20),
    live = addressed(h, "live", 30);
  // Establish deletion admission before holding the finite mention read.
  h.live.receive([old]);
  const first = h.session.inboxFeed.ensure();
  const mention = await take(h, 9);
  try {
    h.live.receive([live]);
    expect(rows(h).map((row) => row.preview)).toContain("live");
    h.live.receive([
      signed(h.alice, {
        kind: 5,
        tags: [["e", old.id]],
        content: "",
        created_at: 31,
      }),
    ]);
  } finally {
    mention.resolve([old]);
  }
  await first;
  expect(rows(h).map((row) => row.preview)).toEqual(["live"]);
  const again = h.session.inboxFeed.refresh();
  const stale = await take(h, 9);
  h.admit([h.alice.pubkey], 40);
  stale.resolve([old, live]);
  await again;
  expect(rows(h)).toEqual([]);
});
it("71 admitted author deletions keep shared rows deleted without aborting a held finite attempt", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const chats = Array.from({ length: 71 }, (_, i) =>
    addressed(h, `delete ${i}`, 20 + i),
  );
  // Establish every target's actual row and shared reference admission first.
  h.live.receive(chats);
  expect(
    rows(h)
      .map((row) => row.messageId)
      .sort(),
  ).toEqual(chats.map((chat) => chat.id).sort());
  const feed = h.session.inboxFeed;
  const work = feed.ensure();
  const held = await take(h, 9);
  const deletions = chats.map((chat, i) =>
    signed(h.alice, {
      kind: i % 2 ? 9005 : 5,
      tags: [["e", chat.id]],
      content: "",
      created_at: 100 + i,
    }),
  );
  expect(new Set(deletions.map((event) => event.id)).size).toBe(71);
  try {
    h.live.receive(deletions);
    expect(rows(h)).toEqual([]);
    // The retired guard failed here on deletion 71 despite remaining well
    // inside shared unread and finite auxiliary budgets.
    expect(feed.snapshot().status).toBe("loading");
  } finally {
    held.resolve(chats.slice(0, 50));
    await work;
  }
  expect(feed.snapshot()).toMatchObject({
    status: "ready",
    incomplete: [],
    error: undefined,
  });
  expect(rows(h)).toEqual([]); // Late addressed history cannot resurrect them.
  expect(h.query).toHaveBeenCalledTimes(3);
  expect(h.query.mock.calls[1]?.[0]).toEqual([
    {
      kinds: [40003, 5, 9005],
      "#e": chats
        .slice(0, 50)
        .map((chat) => chat.id)
        .sort(),
      limit: 500,
    },
  ]);
});
it("channel feed history uses the shared fold: own/deleted rows stay absent and unresolved roots never duplicate", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const root = message(h.viewer, "room", "root", 15);
  const reply = message(h.alice, "room", "reply", 20, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  const own = message(h.viewer, "room", "own addressed", 21, [
    ["p", h.viewer.pubkey],
  ]);
  const work = h.session.inboxFeed.ensure();
  (await take(h, 9)).resolve([reply, own]);
  await work;
  expect(rows(h).map((row) => row.id)).toEqual([`room:${reply.id}`]);
  h.live.receive([root]);
  expect(rows(h).map((row) => row.id)).toEqual([`room:${root.id}`]);
  h.live.receive([
    signed(h.alice, {
      kind: 5,
      tags: [
        ["h", "room"],
        ["e", reply.id],
      ],
      content: "",
      created_at: 30,
    }),
  ]);
  expect(rows(h)).toEqual([]);
  const refresh = h.session.inboxFeed.refresh();
  (await take(h, 9)).resolve([reply, own]);
  await refresh;
  expect(rows(h)).toEqual([]);
});

it("a live deletion arriving before a held finite result suppresses its late row even while loading", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const chat = addressed(h, "late deleted", 20);
  // Establish shared target visibility first; orphan reference-only deletions
  // are deliberately not admitted by the session access owner.
  h.live.receive([chat]);
  const work = h.session.inboxFeed.ensure();
  const mention = await take(h, 9);
  h.live.receive([
    signed(h.alice, {
      kind: 5,
      tags: [["e", chat.id]],
      content: "",
      created_at: 30,
    }),
  ]);
  mention.resolve([chat]);
  await work;
  expect(rows(h)).toEqual([]);
});

it.each([false, true])(
  "disposal erases populated unread rows and feed metadata and rejects late completion (pending=%s)",
  async (pending) => {
    const h = setup();
    h.admit([h.viewer.pubkey, h.alice.pubkey]);
    const feed = h.session.inboxFeed;
    const unread = h.session.unread;
    const mention = addressed(h, "retired mention", 20);
    const initial = feed.ensure();
    (await take(h, 9)).resolve([mention]);
    await initial;
    expect(feed.snapshot()).toMatchObject({
      status: "ready",
      incomplete: [],
    });
    expect(unread.inbox().items.map((row) => row.messageId)).toEqual([
      mention.id,
    ]);
    const work = pending ? feed.refresh() : undefined;
    const held = pending ? await take(h, 9) : undefined;
    const notify = vi.fn();
    const notifyRows = vi.fn();
    feed.subscribe(notify);
    unread.subscribeInbox(notifyRows);
    try {
      h.dispose();
      expect(feed.snapshot()).toMatchObject({
        status: "idle",
        incomplete: [],
      });
      expect(unread.inbox().items).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
      expect(notifyRows).not.toHaveBeenCalled();
    } finally {
      held?.resolve([mention]);
      await work;
    }
    expect(feed.snapshot()).toMatchObject({
      status: "idle",
      incomplete: [],
    });
    expect(unread.inbox().items).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(notifyRows).not.toHaveBeenCalled();
  },
);

it("joining after public pre-membership history needs fresh shared admission, not another feed read", async () => {
  const h = setup();
  h.live.receive([
    roster(h.relay, "room", [h.alice.pubkey], 10),
    metadata(h.relay, "room", "Room", 10, [["public"]]),
  ]);
  const chat = addressed(h, "Addressed chat", 20);
  const work = h.session.inboxFeed.ensure();
  (await take(h, 9)).resolve([chat]);
  await work;
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "ready",
    incomplete: [],
  });
  expect(rows(h)).toEqual([]);
  const reads = h.query.mock.calls.length;
  expect(reads).toBe(1);
  expect(h.query.mock.calls.some(([filters]) => filters[0]?.["#e"])).toBe(
    false,
  );
  h.admit([h.viewer.pubkey, h.alice.pubkey], 30);
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "ready",
    incomplete: [],
  });
  // Unread never admitted the pre-membership chat. Joining alone cannot create
  // a row or completeness obligation from that unretained evidence.
  expect(rows(h)).toEqual([]);
  await h.session.inboxFeed.ensure();
  expect(h.query).toHaveBeenCalledTimes(reads);
  h.live.receive([chat]);
  expect(rows(h).map((row) => row.messageId)).toEqual([chat.id]);
});
it("excludes nonchat and approvals from unread rows and completeness targets and coalesces one bounded chat request", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const chat = addressed(h, "Chat mention", 20);
  const nonchat = [
    1, 45001, 45003, 1618, 1619, 1621, 1630, 1631, 1632, 1633, 46010, 46011,
    46012,
  ].map((kind) =>
    signed(h.alice, {
      kind,
      content: `Excluded ${kind}`,
      created_at: 21,
      tags: [
        ["h", "room"],
        ["p", h.viewer.pubkey],
        ["a", `30617:${h.alice.pubkey}:repo`],
      ],
    }),
  );
  const first = h.session.inboxFeed.ensure(),
    second = h.session.inboxFeed.refresh();
  (await take(h, 9)).resolve([chat, ...nonchat]);
  await Promise.all([first, second]);
  expect(h.query).toHaveBeenCalledTimes(3); // one coalesced #p, one #e closure
  expect(h.query.mock.calls[1]?.[0]).toEqual([
    { kinds: [40003, 5, 9005], "#e": [chat.id], limit: 500 },
  ]);
  expect(rows(h).map((row) => row.messageId)).toEqual([chat.id]);
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "ready",
    incomplete: [],
  });
  const before = h.session.unread.inbox();
  h.live.receive(nonchat);
  expect(h.session.unread.inbox()).toBe(before);
  expect(rows(h).map((row) => row.messageId)).toEqual([chat.id]);
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "ready",
    incomplete: [],
  });
});

it("first verified admission marks exact target incomplete before unread subscribers see original", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const old = addressed(h, "OLD BODY", 20);
  const sequence: {
    preview: string | undefined;
    status: string;
    incomplete: readonly string[];
  }[] = [];
  const observe = () =>
    sequence.push({
      preview: rows(h)[0]?.preview,
      status: h.session.inboxFeed.snapshot().status,
      incomplete: h.session.inboxFeed.snapshot().incomplete,
    });
  const stop = h.session.unread.subscribeInbox(observe);
  const stopFeed = h.session.inboxFeed.subscribe(observe);
  try {
    const work = h.session.inboxFeed.ensure();
    (await take(h, 9)).resolve([old]);
    await work;
    expect(sequence.filter(({ preview }) => preview === "OLD BODY")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "loading",
          incomplete: [old.id],
        }),
      ]),
    );
    expect(h.session.inboxFeed.snapshot()).toMatchObject({
      status: "ready",
      incomplete: [],
    });
  } finally {
    stop();
    stopFeed();
  }
});

it("settles a signed old addressed edit after 500 newer ordinary rows without opening detail or live replay", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const old = addressed(h, "OLD BODY", 20);
  const edit = signed(h.alice, {
    kind: 40003,
    created_at: 21,
    content: "CURRENT BODY",
    tags: [
      ["h", "room"],
      ["e", old.id],
    ],
  });
  const newer = Array.from({ length: 500 }, (_, i) =>
    message(h.alice, "room", `ordinary ${i}`, 100 + i),
  );
  const addressedQuery = deferred<RelayEvent[]>();
  const filters: ReadFilter[] = [];
  h.query.mockImplementation(async ([filter]) => {
    if (!filter) return [];
    filters.push(filter);
    if (filter["#p"]) return addressedQuery.promise;
    if (filter.authors) return [];
    if (filter["#h"]) return newer;
    if (filter["#e"]?.includes(old.id)) {
      // General #e, not include_aux on #p, returns author edits of exact IDs.
      return filter.until === undefined ? [edit] : [];
    }
    if (filter["#e"]?.includes(edit.id)) return [];
    return [];
  });
  const unread = h.session.unread.ensure();
  await unread;
  expect(rows(h)).toEqual([]);
  const work = h.session.inboxFeed.ensure();
  await vi.waitFor(() =>
    expect(filters.some((filter) => !!filter["#p"])).toBe(true),
  );
  addressedQuery.resolve([old]);
  await work;
  expect(rows(h).map((item) => item.preview)).toEqual(["CURRENT BODY"]);
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "ready",
    incomplete: [],
  });
  expect(filters.filter((filter) => filter["#e"])).toEqual([
    { kinds: [40003, 5, 9005], "#e": [old.id], limit: 500 },
    {
      kinds: [40003, 5, 9005],
      "#e": [old.id],
      limit: 500,
      until: 21,
      before_id: edit.id,
    },
    { kinds: [5, 9005], "#e": [edit.id], limit: 500 },
  ]);
  expect(filters.find((filter) => filter["#p"])).toEqual({
    kinds: [40002, 9],
    "#p": [h.viewer.pubkey],
    limit: 50,
  });
  expect(h.session.channels.window("room").rows).toEqual([]);
});

it("keeps exact incomplete evidence across held edit and deletion reads, failed retry and recovery", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const old = addressed(h, "OLD BODY", 20);
  const edit = signed(h.alice, {
    kind: 40003,
    created_at: 21,
    content: "CURRENT BODY",
    tags: [
      ["h", "room"],
      ["e", old.id],
    ],
  });
  const hold = deferred<RelayEvent[]>();
  let editReads = 0;
  const tombstone = deferred<RelayEvent[]>();
  const retry = deferred<RelayEvent[]>();
  const retryTombstone = deferred<RelayEvent[]>();
  const deletion = signed(h.alice, {
    kind: 5,
    created_at: 22,
    content: "",
    tags: [["e", edit.id]],
  });
  let tombstoneReads = 0;
  h.query.mockImplementation(async ([filter]) => {
    if (filter?.["#p"]) return [old];
    if (filter?.["#e"]?.includes(old.id)) {
      if (filter.until !== undefined) return [];
      editReads++;
      return editReads === 1 ? hold.promise : retry.promise;
    }
    if (filter?.["#e"]?.includes(edit.id)) {
      if (filter.until !== undefined) return [];
      tombstoneReads++;
      return tombstoneReads === 1 ? tombstone.promise : retryTombstone.promise;
    }
    return [];
  });
  const feed = h.session.inboxFeed;
  const work = feed.ensure();
  try {
    await vi.waitFor(() => expect(editReads).toBe(1));
    expect(feed.snapshot()).toMatchObject({
      status: "loading",
      incomplete: [old.id],
    });
    expect(rows(h)[0]?.preview).toBe("OLD BODY"); // PR4 must show placeholder instead
    hold.resolve([edit]);
    await vi.waitFor(() => expect(rows(h)[0]?.preview).toBe("CURRENT BODY"));
    expect(feed.snapshot()).toMatchObject({
      status: "loading",
      incomplete: [old.id],
    });
    tombstone.reject(new Error("edit tombstones unavailable"));
    await work;
    expect(feed.snapshot()).toMatchObject({
      status: "error",
      incomplete: [old.id],
      error: "edit tombstones unavailable",
    });
    const next = feed.refresh();
    await vi.waitFor(() => expect(editReads).toBe(2));
    expect(feed.snapshot()).toMatchObject({
      status: "loading",
      incomplete: [old.id],
    });
    retry.resolve([]); // Soft-deleted edits are absent from ordinary relay queries.
    await vi.waitFor(() => expect(tombstoneReads).toBe(2));
    expect(feed.snapshot()).toMatchObject({
      status: "loading",
      incomplete: [old.id],
    });
    expect(rows(h)[0]?.preview).toBe("CURRENT BODY");
    retryTombstone.resolve([deletion]);
    await next;
    expect(rows(h)[0]?.preview).toBe("OLD BODY");
    expect(feed.snapshot()).toMatchObject({ status: "ready", incomplete: [] });
  } finally {
    hold.resolve([]);
    retry.resolve([]);
    tombstone.resolve([]);
    retryTombstone.resolve([]);
  }
});

it("tombstones a stored edit, then restores its original target body only after closure settles", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const target = addressed(h, "original", 20);
  const edit = signed(h.alice, {
    kind: 40003,
    created_at: 21,
    content: "superseded",
    tags: [
      ["h", "room"],
      ["e", target.id],
    ],
  });
  const deletion = signed(h.alice, {
    kind: 5,
    created_at: 22,
    content: "",
    tags: [["e", edit.id]],
  });
  let release!: (events: RelayEvent[]) => void;
  const held = new Promise<RelayEvent[]>((resolve) => {
    release = resolve;
  });
  h.query.mockImplementation(async ([filter]) => {
    if (filter?.["#p"]) return [target];
    if (filter?.["#e"]?.includes(target.id))
      return filter.until === undefined ? [edit] : [];
    if (filter?.["#e"]?.includes(edit.id))
      return filter.until === undefined ? held : [];
    return [];
  });
  const work = h.session.inboxFeed.ensure();
  try {
    await vi.waitFor(() => expect(rows(h)[0]?.preview).toBe("superseded"));
    expect(h.session.inboxFeed.snapshot()).toMatchObject({
      status: "loading",
      incomplete: [target.id],
    });
    release([deletion]);
    await work;
    expect(rows(h)[0]?.preview).toBe("original");
    expect(h.session.inboxFeed.snapshot()).toMatchObject({
      status: "ready",
      incomplete: [],
    });
  } finally {
    release([]);
  }
});

it("access removal while pre-admission subscriber runs cannot admit the pending target", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const target = addressed(h, "must not appear", 20);
  const stop = h.session.inboxFeed.subscribe(() => {
    if (h.session.inboxFeed.snapshot().incomplete.includes(target.id))
      h.admit([h.alice.pubkey], 30);
  });
  try {
    const work = h.session.inboxFeed.ensure();
    (await take(h, 9)).resolve([target]);
    await work;
    expect(rows(h)).toEqual([]);
    expect(h.session.inboxFeed.snapshot()).toMatchObject({
      status: "idle",
      incomplete: [],
    });
    expect(h.query.mock.calls.some(([filters]) => filters[0]?.["#e"])).toBe(
      false,
    );
  } finally {
    stop();
  }
});

it("a cache reset fences an old pending edit read and its late result", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const target = addressed(h, "old", 20);
  let release!: (events: RelayEvent[]) => void;
  const held = new Promise<RelayEvent[]>((resolve) => {
    release = resolve;
  });
  h.query.mockImplementation(async ([filter]) => {
    if (filter?.["#p"]) return [target];
    if (filter?.["#e"]) return held;
    return [];
  });
  const work = h.session.inboxFeed.ensure();
  try {
    await vi.waitFor(() =>
      expect(h.session.inboxFeed.snapshot().incomplete).toEqual([target.id]),
    );
    expect(h.session.inboxFeed.snapshot().status).toBe("loading");
    expect(rows(h)[0]?.preview).toBe("old");
    await h.clearCache();
    release([
      signed(h.alice, {
        kind: 40003,
        content: "late",
        created_at: 21,
        tags: [
          ["h", "room"],
          ["e", target.id],
        ],
      }),
    ]);
    await work;
    expect(h.session.inboxFeed.snapshot()).toMatchObject({
      status: "idle",
      incomplete: [],
    });
    expect(rows(h)).toEqual([]);
  } finally {
    release([]);
  }
});

it("pending exact group member survives verified root regrouping and representative changes", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const root = message(h.viewer, "room", "my root", 15);
  const reply = message(h.alice, "room", "old reply", 20, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  let release!: (events: RelayEvent[]) => void;
  const held = new Promise<RelayEvent[]>((resolve) => {
    release = resolve;
  });
  h.query.mockImplementation(async ([filter]) => {
    if (filter?.["#p"]) return [reply];
    if (filter?.["#e"]) return held;
    return [];
  });
  const work = h.session.inboxFeed.ensure();
  try {
    await vi.waitFor(() =>
      expect(h.session.inboxFeed.snapshot().incomplete).toEqual([reply.id]),
    );
    expect(rows(h)[0]).toMatchObject({
      id: `room:${reply.id}`,
      messageIds: [reply.id],
    });
    h.live.receive([root]);
    expect(rows(h)[0]).toMatchObject({
      id: `room:${root.id}`,
      messageId: reply.id,
      messageIds: [reply.id],
    });
    expect(
      rows(h)[0]?.messageIds.some((id) =>
        h.session.inboxFeed.snapshot().incomplete.includes(id),
      ),
    ).toBe(true);
  } finally {
    release([]);
    await work;
  }
});

it("a synchronous loading subscriber clears demand without stranding a stale work promise", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  let once = true;
  const feed = h.session.inboxFeed;
  const stop = feed.subscribe(() => {
    if (once && feed.snapshot().status === "loading") {
      once = false;
      feed.clear();
    }
  });
  try {
    const cancelled = feed.ensure();
    // Explicitly settle the fixture's aborted request, without a test timeout.
    (await take(h, 9)).resolve([]);
    await cancelled;
    expect(feed.snapshot()).toMatchObject({ status: "idle", incomplete: [] });
    const fresh = feed.ensure();
    (await take(h, 9)).resolve([]);
    await fresh;
    expect(feed.snapshot().status).toBe("ready");
  } finally {
    stop();
  }
});

it("retry verifies an old incomplete target even if a new addressed page excludes it", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const old = addressed(h, "old", 20);
  const newer = Array.from({ length: 50 }, (_, i) =>
    addressed(h, `new ${i}`, 100 + i),
  );
  let attempt = 0;
  const exactReads: readonly string[][] = [];
  h.query.mockImplementation(async ([filter]) => {
    if (filter?.["#p"]) return ++attempt === 1 ? [old] : newer;
    if (filter?.["#e"] && filter.until === undefined) {
      (exactReads as string[][]).push([...filter["#e"]]);
      if (attempt === 1) throw new Error("overlays unavailable");
    }
    return [];
  });
  await h.session.inboxFeed.ensure();
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "error",
    incomplete: [old.id],
  });
  await h.session.inboxFeed.refresh();
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "ready",
    incomplete: [],
  });
  expect(exactReads[1]).toContain(old.id);
  expect(exactReads[1]).toHaveLength(51);
});

it("a non-advancing edit page remains retryable instead of clearing incomplete evidence", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const target = addressed(h, "original", 20);
  const edits = Array.from({ length: 2 }, (_, i) =>
    signed(h.alice, {
      kind: 40003,
      created_at: 30 + i,
      content: `revision ${i}`,
      tags: [
        ["h", "room"],
        ["e", target.id],
      ],
    }),
  );
  h.query.mockImplementation(async ([filter]) => {
    if (filter?.["#p"]) return [target];
    if (filter?.["#e"]?.includes(target.id)) return edits;
    return [];
  });
  await h.session.inboxFeed.ensure();
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "error",
    incomplete: [target.id],
  });
  expect(h.session.inboxFeed.snapshot().error).toBe(
    "Inbox message updates did not advance. Retry inbox.",
  );
  expect(h.session.inboxFeed.snapshot().status).not.toBe("ready");
});

it("ordinary live receive after cache clearing does not throw from the finite callback fence", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  await h.clearCache();
  expect(() => h.live.receive([addressed(h, "ordinary", 20)])).not.toThrow();
});

it("a reentrant feed clear during exact pre-admission never publishes the old body", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const target = addressed(h, "never publish", 20);
  const feed = h.session.inboxFeed;
  const observed: string[] = [];
  const stopUnread = h.session.unread.subscribeInbox(() => {
    observed.push(...rows(h).map((row) => row.preview));
  });
  const stop = feed.subscribe(() => {
    if (feed.snapshot().incomplete.includes(target.id)) feed.clear();
  });
  try {
    const work = feed.ensure();
    (await take(h, 9)).resolve([target]);
    await work;
    expect(observed).not.toContain("never publish");
    expect(rows(h)).toEqual([]);
    expect(feed.snapshot()).toMatchObject({ status: "idle", incomplete: [] });
  } finally {
    stop();
    stopUnread();
  }
});

it.each(["disconnect", "unrelated revocation"] as const)(
  "%s preserves unresolved retained targets and retries them outside the next addressed page",
  async (change) => {
    const h = setup();
    h.admit([h.viewer.pubkey, h.alice.pubkey]);
    h.live.receive([
      roster(h.relay, "other", [h.viewer.pubkey], 10),
      metadata(h.relay, "other", "Other", 10),
    ]);
    h.live.state({ status: "connected", routes: [] });
    const old = addressed(h, "unsettled", 20);
    const newer = Array.from({ length: 50 }, (_, i) =>
      addressed(h, `new ${i}`, 100 + i),
    );
    const initial = deferred<RelayEvent[]>();
    const retry = deferred<RelayEvent[]>();
    const exactReads: readonly string[][] = [];
    let attempt = 0;
    h.query.mockImplementation(async ([filter]) => {
      if (filter?.["#p"]) return ++attempt === 1 ? [old] : newer;
      if (filter?.["#e"]) {
        (exactReads as string[][]).push([...filter["#e"]]);
        return attempt === 1 ? initial.promise : retry.promise;
      }
      return [];
    });
    const feed = h.session.inboxFeed;
    const snapshots: { retained: boolean; incomplete: readonly string[] }[] =
      [];
    const observe = () =>
      snapshots.push({
        retained: rows(h).some((row) => row.messageIds.includes(old.id)),
        incomplete: feed.snapshot().incomplete,
      });
    const stopUnread = h.session.unread.subscribeInbox(observe);
    const stopFeed = feed.subscribe(observe);
    const first = feed.ensure();
    try {
      await vi.waitFor(() => expect(exactReads).toHaveLength(1));
      expect(rows(h).map((row) => row.preview)).toContain("unsettled");
      if (change === "disconnect")
        h.live.state({ status: "retrying", routes: [] });
      else h.live.receive([roster(h.relay, "other", [], 30)]);
      initial.resolve([]);
      await first;
      expect(feed.snapshot()).toMatchObject({
        status: "idle",
        incomplete: [old.id],
      });
      expect(rows(h).map((row) => row.preview)).toContain("unsettled");
      expect(
        snapshots.filter(({ retained }) => retained).length,
      ).toBeGreaterThan(0);
      expect(
        snapshots.filter(
          ({ retained, incomplete }) =>
            retained && !incomplete.includes(old.id),
        ),
      ).toEqual([]);
      if (change === "disconnect")
        h.live.state({ status: "connected", routes: [] });
      const next = feed.refresh();
      await vi.waitFor(() => expect(exactReads).toHaveLength(2));
      expect(exactReads[1]).toContain(old.id);
      expect(exactReads[1]).toHaveLength(51);
      expect(feed.snapshot().incomplete).toContain(old.id);
      retry.resolve([]);
      await next;
      expect(feed.snapshot()).toMatchObject({
        status: "ready",
        incomplete: [],
      });
    } finally {
      stopUnread();
      stopFeed();
      initial.resolve([]);
      retry.resolve([]);
    }
  },
);

it.each([
  ["author", false],
  ["owner", false],
  ["actor", false],
  ["p", false],
  ["owner", true],
  ["actor", true],
  ["p", true],
] as const)(
  "refresh checks a retained %s edit omitted after disconnect (ownership pending=%s)",
  async (authority, pendingOwnership) => {
    const attributed = authority === "actor" || authority === "p";
    const h = setup(attributed);
    h.admit([h.viewer.pubkey, h.alice.pubkey]);
    h.live.state({ status: "connected", routes: [] });
    const target = attributed
      ? signed(h.relay, {
          kind: 9,
          created_at: 20,
          content: "original",
          tags: [
            [authority, h.alice.pubkey],
            ["h", "room"],
            ["p", h.viewer.pubkey],
          ],
        })
      : addressed(h, "original", 20);
    const editor = authority === "author" ? h.alice : h.viewer;
    const profile = (at: number) =>
      eventDto(
        signed(h.alice, {
          kind: 0,
          created_at: at,
          content: "{}",
          tags: [
            [
              "auth",
              h.viewer.pubkey,
              "",
              bytesToHex(
                schnorr.sign(
                  createHash("sha256")
                    .update(`nostr:agent-auth:${h.alice.pubkey}:`)
                    .digest(),
                  h.viewer.secret,
                ),
              ),
            ],
          ],
        }),
      );
    if (authority !== "author") {
      h.live.receive([profile(10)]);
      await vi.waitFor(() =>
        expect(h.session.profiles.owner?.(h.alice.pubkey)).toBe(
          h.viewer.pubkey,
        ),
      );
    }
    const edit = signed(editor, {
      kind: 40003,
      created_at: 21,
      content: "deleted edit",
      tags: [
        ["h", "room"],
        ["e", target.id],
      ],
    });
    const deletion = signed(editor, {
      kind: 9005,
      created_at: 22,
      content: "",
      tags: [["e", edit.id]],
    });
    const held = deferred<RelayEvent[]>();
    let attempt = 0;
    let tombstoneReads = 0;
    h.query.mockImplementation(async ([filter]) => {
      if (filter?.["#p"]) {
        attempt++;
        return [target];
      }
      if (filter?.until !== undefined) return [];
      if (filter?.["#e"]?.includes(target.id))
        return attempt === 1 ? [edit] : [];
      if (filter?.["#e"]?.includes(edit.id)) {
        tombstoneReads++;
        return attempt === 1 ? [] : held.promise;
      }
      return [];
    });
    const feed = h.session.inboxFeed;
    await feed.ensure();
    expect(feed.snapshot()).toMatchObject({ status: "ready", incomplete: [] });
    expect(rows(h)[0]?.preview).toBe("deleted edit");
    const verification = deferred<ArrayBuffer>();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`nostr:agent-auth:${h.alice.pubkey}:`),
    );
    const heldDigest = pendingOwnership
      ? vi
          .spyOn(crypto.subtle, "digest")
          .mockImplementationOnce(() => verification.promise)
      : undefined;
    try {
      if (pendingOwnership) {
        h.live.receive([profile(23)]);
        expect(h.session.profiles.owner?.(h.alice.pubkey)).toBeUndefined();
      }
      h.live.state({ status: "retrying", routes: [] });
      h.live.state({ status: "connected", routes: [] });
      const next = feed.refresh();
      await vi.waitFor(() => expect(tombstoneReads).toBe(2));
      expect(feed.snapshot()).toMatchObject({
        status: "loading",
        incomplete: [target.id],
      });
      held.resolve([deletion]);
      await next;
      verification.resolve(digest);
      if (pendingOwnership)
        await vi.waitFor(() =>
          expect(h.session.profiles.owner?.(h.alice.pubkey)).toBe(
            h.viewer.pubkey,
          ),
        );
      expect(rows(h)[0]?.preview).toBe("original");
      expect(feed.snapshot()).toMatchObject({
        status: "ready",
        incomplete: [],
      });
    } finally {
      held.resolve([]);
      verification.resolve(digest);
      heldDigest?.mockRestore();
    }
  },
);

it("a fully visibility-filtered auxiliary page is incomplete, not a false terminal page", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const target = addressed(h, "original", 20);
  const unretained = message(h.alice, "room", "another removal target", 21);
  const deletion = signed(h.alice, {
    kind: 5,
    created_at: 30,
    content: "",
    tags: [
      ["h", "room"],
      ["e", target.id],
      ["e", unretained.id],
    ],
  });
  const olderEdit = signed(h.alice, {
    kind: 40003,
    created_at: 25,
    content: "older applicable update",
    tags: [
      ["h", "room"],
      ["e", target.id],
    ],
  });
  const mentions = deferred<RelayEvent[]>();
  const auxiliary: ReadFilter[] = [];
  h.query.mockImplementation(async ([filter]) => {
    if (filter?.["#p"]) return mentions.promise;
    if (filter?.["#e"]?.includes(target.id)) {
      auxiliary.push(filter);
      if (filter.until === undefined) return [deletion];
      return filter.until === 30 ? [olderEdit] : [];
    }
    return [];
  });
  const feed = h.session.inboxFeed;
  const work = feed.ensure();
  try {
    await vi.waitFor(() => expect(h.query).toHaveBeenCalledTimes(1));
    expect(rows(h)).toEqual([]);
    mentions.resolve([target]);
    await work;
    // Fail closed rather than claiming the unadmitted page proved exhaustion.
    expect(feed.snapshot()).toMatchObject({
      status: "error",
      incomplete: [target.id],
      error:
        "Inbox message updates could not be verified for current access. Retry inbox.",
    });
    expect(rows(h)[0]?.preview).toBe("original");
    expect(auxiliary).toHaveLength(1);
    // Existing shared admission can later supply the missing reference. Retry
    // must then traverse the older applicable update and a real empty terminal.
    h.live.receive([unretained]);
    await feed.refresh();
    expect(auxiliary.map((filter) => filter.until)).toEqual([
      undefined,
      undefined,
      30,
      25,
    ]);
    expect(feed.snapshot()).toMatchObject({ status: "ready", incomplete: [] });
    expect(rows(h)).toEqual([]); // Author's bulk deletion is now fully admitted.
  } finally {
    mentions.resolve([]);
  }
});

it("a signed short-page walk settles edits and checks their deletion dependencies", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const target = addressed(h, "original", 20);
  const edits = Array.from({ length: 3 }, (_, i) =>
    signed(h.alice, {
      kind: 40003,
      created_at: 33 - i,
      content: `revision ${i}`,
      tags: [
        ["h", "room"],
        ["e", target.id],
      ],
    }),
  );
  const pages: ReadFilter[] = [];
  h.query.mockImplementation(async ([filter]) => {
    if (filter?.["#p"]) return [target];
    if (filter?.["#e"]?.includes(target.id)) {
      pages.push(filter);
      return edits
        .filter(
          (edit) =>
            filter.until === undefined || edit.created_at < filter.until,
        )
        .slice(0, 1);
    }
    return [];
  });
  await h.session.inboxFeed.ensure();
  expect(pages.map((filter) => filter.until)).toEqual([undefined, 33, 32, 31]);
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "ready",
    incomplete: [],
  });
  expect(rows(h)[0]?.preview).toBe("revision 0");
  expect(
    h.query.mock.calls.some(
      ([filters]) =>
        filters[0]?.kinds?.join(",") === "5,9005" &&
        filters[0]?.["#e"]?.length === 3,
    ),
  ).toBe(true);
});

// Retention budgets belong to the feed, not signing/session folding. Synthetic
// DTOs model the already-verified reader boundary here; signed admission, edits,
// and short-page closure remain covered through the real session above.
it.each(["events", "bytes"] as const)(
  "walks advancing auxiliary pages with a discriminating %s budget outcome",
  async (budget) => {
    const h = setup();
    h.admit([h.viewer.pubkey, h.alice.pubkey]);
    const target = addressed(h, "original", 20);
    const count = budget === "events" ? 2001 : 9;
    const edits: RelayEvent[] = Array.from({ length: count }, (_, i) => ({
      ...target,
      id: (i + 1).toString(16).padStart(64, "0"),
      kind: 40003,
      created_at: 30 + count - i,
      content: budget === "bytes" ? "x".repeat(512 * 1024) : `revision ${i}`,
      tags: [
        ["h", "room"],
        ["e", target.id],
      ],
    }));
    expect(edits.length > 2000).toBe(budget === "events");
    expect(byteSize(edits) > 4 * 1024 * 1024).toBe(budget === "bytes");
    const pageSize = budget === "events" ? 500 : 3;
    const pages: ReadFilter[] = [];
    const reader = {
      read: vi.fn(async (filters: readonly ReadFilter[]) => {
        const filter = filters[0];
        if (!filter?.["#e"]?.includes(target.id)) return [];
        pages.push(filter);
        return edits
          .filter(
            (edit) =>
              filter.until === undefined || edit.created_at < filter.until,
          )
          .slice(0, pageSize);
      }),
    };
    const feed = createInboxFeed({
      viewer: h.viewer.pubkey,
      channels: h.session.channels,
      reader,
      async addressedRead(_filter, _signal, prepare) {
        prepare([target]);
        return [target];
      },
      retainedEvent: (id) => (id === target.id ? target : undefined),
      retainedEditIds: () => [],
    });
    try {
      await feed.ensure();
      expect(pages.length).toBe(budget === "events" ? 5 : 3);
      expect(feed.snapshot()).toMatchObject({
        status: "error",
        incomplete: [target.id],
        error: "Inbox message updates exceed the read budget. Retry inbox.",
      });
      // Failure must be retryable; no blanket pagination rejection may pass.
      pages.length = 0;
      const first = edits[0];
      if (!first) throw Error("Missing budget fixture edit");
      edits.splice(0, edits.length, { ...first, content: "bounded retry" });
      await feed.refresh();
      expect(pages).toHaveLength(2);
      expect(feed.snapshot()).toMatchObject({
        status: "ready",
        incomplete: [],
      });
      expect(reader.read.mock.calls.at(-1)?.[0][0]?.["#e"]).toEqual([first.id]);
    } finally {
      feed.dispose();
    }
  },
);

it("access purge drops denied obligations but retains the still-readable target", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  h.live.receive([
    roster(h.relay, "other", [h.viewer.pubkey], 10),
    metadata(h.relay, "other", "Other", 10),
  ]);
  const kept = addressed(h, "kept", 20);
  const denied = message(h.alice, "other", "denied", 21, [
    ["p", h.viewer.pubkey],
  ]);
  const held = deferred<RelayEvent[]>();
  let reads = 0;
  h.query.mockImplementation(async ([filter]) => {
    if (filter?.["#p"]) return [kept, denied];
    if (filter?.["#e"]) {
      reads++;
      return held.promise;
    }
    return [];
  });
  const feed = h.session.inboxFeed;
  const work = feed.ensure();
  try {
    await vi.waitFor(() => expect(reads).toBe(1));
    expect(feed.snapshot().incomplete).toEqual(
      expect.arrayContaining([kept.id, denied.id]),
    );
    expect(rows(h)).toHaveLength(2);
    h.live.receive([roster(h.relay, "other", [], 30)]);
    held.resolve([]);
    await work;
    expect(rows(h).map((row) => row.messageId)).toEqual([kept.id]);
    expect(feed.snapshot()).toMatchObject({
      status: "idle",
      incomplete: [kept.id],
    });
    await h.clearCache();
    expect(rows(h)).toEqual([]);
    expect(feed.snapshot().incomplete).toEqual([]);
  } finally {
    held.resolve([]);
  }
});

it.each(["revoke-regrant", "dispose"] as const)(
  "an auxiliary response cannot re-admit evidence after %s",
  async (change) => {
    const h = setup();
    h.admit([h.viewer.pubkey, h.alice.pubkey]);
    const target = addressed(h, "original", 20);
    const edit = signed(h.alice, {
      kind: 40003,
      created_at: 21,
      content: "stale update",
      tags: [
        ["h", "room"],
        ["e", target.id],
      ],
    });
    const held = deferred<RelayEvent[]>();
    let reads = 0;
    h.query.mockImplementation(async ([filter]) => {
      if (filter?.["#p"]) return [target];
      if (filter?.["#e"]) {
        reads++;
        return held.promise;
      }
      return [];
    });
    const feed = h.session.inboxFeed;
    const work = feed.ensure();
    try {
      await vi.waitFor(() => expect(reads).toBe(1));
      expect(rows(h)[0]?.preview).toBe("original");
      if (change === "revoke-regrant") {
        h.admit([h.alice.pubkey], 30);
        h.admit([h.viewer.pubkey, h.alice.pubkey], 31);
      } else await h[change]();
      held.resolve([edit]);
      await work;
      expect(rows(h)).toEqual([]);
      expect(feed.snapshot()).toMatchObject({
        status: "idle",
        incomplete: [],
      });
      expect(reads).toBe(1);
    } finally {
      held.resolve([]);
    }
  },
);

it("retained dependency closure checks live same-channel edit candidates of the exact addressed target", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const target = addressed(h, "original", 20);
  const unrelated = message(h.alice, "room", "not addressed", 21);
  const edit = (
    author: typeof h.alice,
    id: string,
    content: string,
    at: number,
  ) =>
    signed(author, {
      kind: 40003,
      created_at: at,
      content,
      tags: [
        ["h", "room"],
        ["e", id],
      ],
    });
  const originalEdit = edit(h.alice, target.id, "surviving older edit", 22);
  const newestEdit = edit(h.alice, target.id, "newest edit", 23);
  const removedEdit = edit(h.alice, target.id, "already deleted", 24);
  const wrongAuthor = edit(h.viewer, target.id, "not an author edit", 25);
  const unrelatedEdit = edit(h.alice, unrelated.id, "another target", 26);
  const deletion = signed(h.alice, {
    kind: 5,
    created_at: 27,
    content: "",
    tags: [["e", removedEdit.id]],
  });
  // All are already retained; the relay omits them from this finite query.
  h.live.receive([
    target,
    unrelated,
    originalEdit,
    newestEdit,
    removedEdit,
    wrongAuthor,
    unrelatedEdit,
    deletion,
  ]);
  expect(rows(h)[0]?.preview).toBe("newest edit");
  const filters: ReadFilter[] = [];
  h.query.mockImplementation(async ([filter]) => {
    if (!filter) return [];
    filters.push(filter);
    return filter["#p"] ? [target] : [];
  });
  await h.session.inboxFeed.ensure();
  expect(filters.filter((filter) => filter["#e"])).toEqual([
    { kinds: [40003, 5, 9005], "#e": [target.id], limit: 500 },
    {
      kinds: [5, 9005],
      "#e": [originalEdit.id, newestEdit.id, wrongAuthor.id].sort(),
      limit: 500,
    },
  ]);
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "ready",
    incomplete: [],
  });
  expect(rows(h)[0]?.preview).toBe("newest edit");
});

it.each(["edit", "delete"] as const)(
  "settles a pending-metadata mention's %s before revealing ordinary history",
  async (operation) => {
    const h = setup();
    const old = addressed(h, "OLD BODY", 20);
    const update = signed(h.alice, {
      kind: operation === "edit" ? 40003 : 5,
      created_at: 21,
      content: operation === "edit" ? "CURRENT BODY" : "",
      tags: [
        ["h", "room"],
        ["e", old.id],
      ],
    });
    const hold = deferred<RelayEvent[]>();
    let overlayReads = 0;
    h.query.mockImplementation(async ([filter]) => {
      if (filter?.["#p"]) return [old];
      if (filter?.["#e"]?.includes(old.id) && filter.until === undefined) {
        overlayReads++;
        return hold.promise;
      }
      return [];
    });
    h.live.receive([
      roster(h.relay, "room", [h.viewer.pubkey, h.alice.pubkey]),
    ]);
    expect(h.session.channels.get?.("room")?.metadataPending).toBe(true);
    const feed = h.session.inboxFeed;
    const work = feed.ensure();
    try {
      await vi.waitFor(() => expect(overlayReads).toBe(1));
      expect(feed.snapshot().incomplete).toContain(old.id);
      hold.resolve([update]);
      await work;
      expect(feed.snapshot()).toMatchObject({
        status: "ready",
        incomplete: [],
      });
      // A complete feed must not reveal stale content when metadata arrives later.
      h.live.receive([metadata(h.relay, "room", "Room")]);
      expect(rows(h).map((item) => item.preview)).toEqual(
        operation === "edit" ? ["CURRENT BODY"] : [],
      );
    } finally {
      hold.resolve([]);
      await work;
    }
  },
);

it("discovers ordinary replies to an old authored thread outside channel catch-up", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const root = message(h.viewer, "room", "old own thread", 20);
  const reply = message(h.alice, "room", "ordinary reply", 21, [
    ["e", root.id, "", "root"],
    ["e", root.id, "", "reply"],
  ]);
  const { matchesEvent } = await import("./projection");
  const history = [root, reply];
  h.query.mockImplementation(async (filters) =>
    history.filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    ),
  );
  // Only unrelated recent channel traffic is retained at startup.
  h.live.receive([message(h.alice, "room", "unrelated channel head", 1000)]);
  expect(rows(h)).toEqual([]);
  await h.session.inboxFeed.ensure();
  expect(rows(h).map((row) => row.messageId)).toContain(reply.id);
  expect(rows(h).find((row) => row.messageId === reply.id)).toMatchObject({
    thread: true,
    mentioned: false,
    unreadCount: 1,
  });
});

it("keeps completed thread rows usable when later discovery fails", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const root = message(h.viewer, "room", "own root", 20);
  const reply = message(h.alice, "room", "reply", 21, [
    ["e", root.id, "", "reply"],
  ]);
  const { matchesEvent } = await import("./projection");
  h.query.mockImplementation(async ([filter]) => {
    if (!filter) return [];
    if (filter.authors && filter.before_id)
      throw new Error("Older history unavailable");
    return [root, reply].filter((event) => matchesEvent(event, filter));
  });
  await h.session.inboxFeed.ensure();
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "error",
    incomplete: [],
    error: "Older history unavailable",
  });
  expect(rows(h).map((row) => row.messageId)).toContain(reply.id);
});

it("discovers participation in someone else's thread without a mention", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const root = message(h.alice, "room", "root", 10);
  const tags = [["e", root.id, "", "reply"]];
  const own = message(h.viewer, "room", "joined", 11, tags);
  const reply = message(h.alice, "room", "later reply", 12, tags);
  const { matchesEvent } = await import("./projection");
  h.query.mockImplementation(async ([filter]) =>
    filter
      ? [root, own, reply].filter((event) => matchesEvent(event, filter))
      : [],
  );
  await h.session.inboxFeed.ensure();
  expect(rows(h).map((row) => row.messageId)).toContain(reply.id);
});

it("discovers an explicit follow added after the feed settled", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const root = message(h.alice, "room", "root", 10);
  const reply = message(h.alice, "room", "reply", 12, [
    ["e", root.id, "", "reply"],
  ]);
  const { matchesEvent } = await import("./projection");
  h.query.mockImplementation(async ([filter]) =>
    filter ? [root, reply].filter((event) => matchesEvent(event, filter)) : [],
  );
  await h.session.inboxFeed.ensure();
  expect(rows(h)).toEqual([]);
  h.session.unread.follow("room", root.id, true);
  await h.session.inboxFeed.ensure();
  expect(h.session.inboxFeed.snapshot().status).toBe("ready");
  expect(rows(h).map((row) => row.messageId)).toContain(reply.id);
});

it("pages past deleted recent replies to find surviving thread activity", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  const root = message(h.viewer, "room", "root", 1);
  const tags = [["e", root.id, "", "reply"]];
  const survivor = message(h.alice, "room", "surviving reply", 2, tags);
  const deleted = Array.from({ length: 100 }, (_, i) =>
    message(h.alice, "room", `deleted ${i}`, 3 + i, tags),
  );
  const tombstone = signed(h.alice, {
    kind: 5,
    created_at: 200,
    content: "",
    tags: [["h", "room"], ...deleted.map((event) => ["e", event.id])],
  });
  const { matchesEvent } = await import("./projection");
  h.query.mockImplementation(async ([filter]) =>
    filter
      ? [root, survivor, ...deleted, tombstone]
          .filter((event) => matchesEvent(event, filter))
          .sort(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, filter.limit)
      : [],
  );
  await h.session.inboxFeed.ensure();
  expect(h.session.inboxFeed.snapshot()).toMatchObject({
    status: "ready",
    incomplete: [],
  });
  expect(rows(h).map((row) => row.messageId)).toEqual([survivor.id]);
});

it.each(["clear", "revoke", "unfollow"] as const)(
  "fences a late discovery reply after %s",
  async (action) => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
    const h = setup();
    h.admit([h.viewer.pubkey, h.alice.pubkey]);
    const root = message(h.viewer, "room", "root", 1);
    const reply = message(h.alice, "room", "late", 2, [
      ["e", root.id, "", "reply"],
    ]);
    const hold = deferred<RelayEvent[]>();
    let started = false;
    h.query.mockImplementation(async ([filter]) => {
      if (filter?.authors) return filter.before_id ? [] : [root];
      if (filter?.kinds?.includes(9) && filter["#e"]) {
        started = true;
        return hold.promise;
      }
      return [];
    });
    const work = h.session.inboxFeed.ensure();
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      if (action === "clear") await h.clearCache();
      else if (action === "revoke") h.admit([h.alice.pubkey], 30);
      else h.session.unread.follow("room", root.id, false);
      hold.resolve([reply]);
      await work;
      if (action === "unfollow") await h.session.inboxFeed.ensure();
      expect(rows(h)).toEqual([]);
    } finally {
      hold.resolve([]);
      await work;
    }
  },
);

it("discovers ordinary Solo activity outside catch-up without self or agent-only messages", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  h.live.receive([
    metadata(h.relay, "room", "Solo", 11, [
      ["t", "stream"],
      ["t", "buzz.solo"],
      ["private"],
    ]),
  ]);
  const incoming = message(h.alice, "room", "ordinary Solo response", 20);
  const own = message(h.viewer, "room", "my answer", 21);
  const quiet = message(h.alice, "room", "coordination", 22, [
    ["audience", "agents"],
  ]);
  const { matchesEvent } = await import("./projection");
  const history = [incoming, own, quiet];
  h.query.mockImplementation(async (filters) =>
    history.filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    ),
  );
  expect(rows(h)).toEqual([]);
  await h.session.inboxFeed.ensure();
  expect(h.session.inboxFeed.snapshot().status).toBe("ready");
  expect(rows(h)).toEqual([
    expect.objectContaining({
      id: "room:room",
      preview: incoming.content,
      messageIds: [incoming.id],
      unreadCount: 1,
      thread: false,
    }),
  ]);
});

it("pages past a Solo root belonging to a nested row to discover older flat activity", async () => {
  const h = setup();
  h.admit([h.viewer.pubkey, h.alice.pubkey]);
  h.live.receive([
    metadata(h.relay, "room", "Solo", 11, [
      ["t", "stream"],
      ["t", "buzz.solo"],
      ["private"],
    ]),
  ]);
  const flat = message(h.alice, "room", "older flat response", 20);
  const root = message(h.alice, "room", "nested root", 21);
  const reply = message(h.alice, "room", "nested mention", 200, [
    ["e", root.id, "", "reply"],
    ["p", h.viewer.pubkey],
  ]);
  const history = [
    flat,
    root,
    ...Array.from({ length: 99 }, (_, i) =>
      message(h.alice, "room", `quiet ${i}`, 22 + i, [["audience", "agents"]]),
    ),
  ];
  const { matchesEvent } = await import("./projection");
  h.query.mockImplementation(async (filters) =>
    history
      .filter((event) => filters.some((filter) => matchesEvent(event, filter)))
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
      .slice(0, filters[0]?.limit),
  );
  h.live.receive([reply]);
  await h.session.inboxFeed.ensure();
  expect(h.session.inboxFeed.snapshot().status).toBe("ready");
  expect(rows(h).find((item) => item.id === "room:room")).toMatchObject({
    messageIds: [flat.id],
    thread: false,
  });
  expect(
    rows(h).find((item) => item.id === `room:${root.id}`)?.messageIds,
  ).toContain(root.id);
});
