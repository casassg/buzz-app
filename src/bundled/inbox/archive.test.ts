// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InboxItem } from "../../features/relay/inbox";
import { keypair, message } from "../../features/relay/testing";
import { viewRevision } from "../../shared/view-state";
import {
  archiveKey,
  archiveIndex,
  isArchived,
  readArchives,
  reopenArchives,
  updateArchive,
} from "./archive";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const viewer = keypair(),
    alice = keypair();
  const mention = message(alice, "room", "Please review", 20, [
    ["p", viewer.pubkey],
  ]);
  const events = new Map([[mention.id, mention]]);
  const item: InboxItem = {
    id: `room:${mention.id}`,
    channelId: "room",
    target: { kind: "message", channelId: "room", messageId: mention.id },
    messageId: mention.id,
    latestMessageId: mention.id,
    messageIds: [mention.id],
    authorId: alice.pubkey,
    preview: mention.content,
    createdAt: 20,
    mentioned: true,
    messages: [
      { id: mention.id, createdAt: mention.created_at, mentioned: true },
    ],
    thread: false,
    unreadCount: 1,
    manual: false,
    readThrough: [],
  };
  const scope = `https://relay.test:${viewer.pubkey}`;
  const archived = (row = item) =>
    isArchived(
      archiveIndex(readArchives(viewRevision(scope, archiveKey))),
      row,
    );
  vi.spyOn(Date, "now").mockReturnValue(30_000);
  return { viewer, alice, events, item, scope, archived };
}

it("cuts off an archive at its evidence, not at a later displayed message", () => {
  const h = fixture();
  // A Solo chat row can show a newer, even future-dated, message that is not
  // evidence.
  const shown = { ...h.item, createdAt: 90 };
  updateArchive(h.scope, shown, true);
  expect(h.archived(shown)).toBe(true);
  const mention = {
    ...shown,
    messageIds: [...shown.messageIds, "b".repeat(64)],
    messages: [
      ...shown.messages,
      { id: "b".repeat(64), createdAt: 40, mentioned: true },
    ],
  };
  expect(h.archived(mention)).toBe(false);
});

it("keeps non-participating replies and older mentions archived, but reopens for a same-second new tag", () => {
  const h = fixture();
  updateArchive(h.scope, h.item, true);
  expect(h.archived()).toBe(true);
  const add = (at: number, tag: boolean) => {
    const event = message(
      h.alice,
      "room",
      `Update at ${at}`,
      at,
      tag ? [["p", h.viewer.pubkey]] : [],
    );
    h.events.set(event.id, event);
    return {
      ...h.item,
      latestMessageId: event.id,
      messageIds: [...h.item.messageIds, event.id],
      createdAt: at,
      messages: [
        ...h.item.messages,
        { id: event.id, createdAt: at, mentioned: tag },
      ],
    };
  };
  expect(h.archived(add(40, false))).toBe(true);
  expect(h.archived(add(29, true))).toBe(true);
  const reopened = add(30, true);
  expect(h.archived(reopened)).toBe(false);
  reopenArchives(h.scope, [reopened]);
  expect(readArchives(viewRevision(h.scope, archiveKey))).toEqual([]);
  expect(h.archived()).toBe(false);
});

it.each([false, true])(
  "reopens ordinary DM arrivals durably without resurfacing old mentions (thread: %s)",
  (thread) => {
    const h = fixture();
    const dm: InboxItem = {
      ...h.item,
      target: { kind: "channel", channelId: h.item.channelId },
      thread,
    };
    updateArchive(h.scope, dm, true);
    const revision = viewRevision(h.scope, archiveKey);
    const index = archiveIndex(readArchives(revision));
    const delayed = {
      ...dm,
      messageIds: [...dm.messageIds, "d".repeat(64)],
      messages: [
        ...dm.messages,
        { id: "d".repeat(64), createdAt: 29, mentioned: false },
      ],
    };
    expect(isArchived(index, delayed)).toBe(true);
    reopenArchives(h.scope, [delayed]);
    expect(viewRevision(h.scope, archiveKey)).toBe(revision);
    const fresh = {
      ...dm,
      messageIds: [...dm.messageIds, "b".repeat(64)],
      messages: [
        ...dm.messages,
        { id: "b".repeat(64), createdAt: 30, mentioned: false },
      ],
    };
    expect(isArchived(index, fresh)).toBe(false);
    expect(isArchived(index, fresh, true)).toBe(true);
    reopenArchives(h.scope, [fresh]);
    const saved = readArchives(viewRevision(h.scope, archiveKey));
    expect(saved).toEqual([{ ...readArchives(revision)[0], reopened: true }]);
    const persisted = archiveIndex(saved);
    // Reopening survives bounded evidence eviction; the old tag stays archived.
    expect(isArchived(persisted, dm)).toBe(false);
    expect(isArchived(persisted, dm, true)).toBe(true);
    updateArchive(h.scope, fresh, true, 31);
    expect(h.archived(fresh)).toBe(true);
    const mention = {
      ...fresh,
      messageIds: [...fresh.messageIds, "c".repeat(64)],
      messages: [
        ...fresh.messages,
        { id: "c".repeat(64), createdAt: 31, mentioned: true },
      ],
    };
    expect(
      isArchived(
        archiveIndex(readArchives(viewRevision(h.scope, archiveKey))),
        mention,
        true,
      ),
    ).toBe(false);
    reopenArchives(h.scope, [mention]);
    expect(readArchives(viewRevision(h.scope, archiveKey))).toEqual([]);
  },
);

it("reopens participating replies durably without resurfacing an old mention", () => {
  const h = fixture();
  const thread = { ...h.item, thread: true };
  updateArchive(h.scope, thread, true);
  const original = viewRevision(h.scope, archiveKey);
  const observed = {
    ...thread,
    messages: thread.messages.map((event) => ({ ...event, createdAt: 40 })),
  };
  const delayed = {
    ...thread,
    messageIds: [...thread.messageIds, "d".repeat(64)],
    messages: [
      ...thread.messages,
      { id: "d".repeat(64), createdAt: 29, mentioned: false },
    ],
  };
  expect(h.archived(observed)).toBe(true);
  expect(h.archived(delayed)).toBe(true);
  reopenArchives(h.scope, [observed, delayed]);
  expect(viewRevision(h.scope, archiveKey)).toBe(original);
  const replyId = "b".repeat(64);
  const reply = {
    ...thread,
    messageIds: [...thread.messageIds, replyId],
    messages: [
      ...thread.messages,
      { id: replyId, createdAt: 30, mentioned: false },
    ],
  };
  const archivedMention = (item: InboxItem) =>
    isArchived(
      archiveIndex(readArchives(viewRevision(h.scope, archiveKey))),
      item,
      true,
    );
  expect(h.archived(reply)).toBe(false);
  expect(archivedMention(reply)).toBe(true);
  reopenArchives(h.scope, [reply]);
  expect(readArchives(viewRevision(h.scope, archiveKey))).toEqual([
    {
      id: thread.id,
      channelId: thread.channelId,
      through: 30,
      messageIds: thread.messageIds,
      reopened: true,
    },
  ]);
  expect(h.archived(thread)).toBe(false);
  expect(archivedMention(thread)).toBe(true);
  const writes = vi.spyOn(Storage.prototype, "setItem");
  reopenArchives(h.scope, [reply, thread]);
  expect(writes).not.toHaveBeenCalled();
  const freshMention = {
    ...reply,
    messageIds: [...reply.messageIds, "c".repeat(64)],
    messages: [
      ...reply.messages,
      { id: "c".repeat(64), createdAt: 31, mentioned: true },
    ],
  };
  expect(archivedMention(freshMention)).toBe(false);
  reopenArchives(h.scope, [freshMention]);
  expect(readArchives(viewRevision(h.scope, archiveKey))).toEqual([]);
  expect(h.archived(thread)).toBe(false);
  expect(archivedMention(thread)).toBe(false);
});

it("rearchiving replaces the reply reopening cutoff and manual Restore clears mention intent", () => {
  const h = fixture();
  const thread = { ...h.item, thread: true };
  updateArchive(h.scope, thread, true);
  const reply = {
    ...thread,
    messageIds: [...thread.messageIds, "b".repeat(64)],
    messages: [
      ...thread.messages,
      { id: "b".repeat(64), createdAt: 30, mentioned: false },
    ],
  };
  reopenArchives(h.scope, [reply]);
  updateArchive(h.scope, reply, true, 31);
  expect(h.archived(reply)).toBe(true);
  expect(
    readArchives(viewRevision(h.scope, archiveKey))[0]?.reopened,
  ).toBeUndefined();
  updateArchive(h.scope, reply, false);
  expect(readArchives(viewRevision(h.scope, archiveKey))).toEqual([]);
});

it("preserves archive intent when exact conversation evidence regroups and restores it", () => {
  const h = fixture();
  updateArchive(h.scope, h.item, true);
  const regrouped = { ...h.item, id: "room:root" };
  expect(h.archived(regrouped)).toBe(true);
  expect(h.archived({ ...regrouped, channelId: "another-room" })).toBe(false);
  updateArchive(h.scope, regrouped, false);
  expect(h.archived(regrouped)).toBe(false);
});

it("keeps a Solo chat mention visible when an earlier archive covers only part of its merged row", () => {
  const h = fixture();
  const row = (created: number): InboxItem => {
    const event = message(h.alice, "chat", `Mention ${created}`, created, [
      ["p", h.viewer.pubkey],
    ]);
    return {
      ...h.item,
      id: `chat:${event.id}`,
      channelId: "chat",
      target: { kind: "message", channelId: "chat", messageId: event.id },
      messageId: event.id,
      latestMessageId: event.id,
      messageIds: [event.id],
      createdAt: created,
      messages: [{ id: event.id, createdAt: created, mentioned: true }],
    };
  };
  const [kept, archived] = [row(15), row(20)];
  updateArchive(h.scope, archived, true);
  expect(h.archived(kept)).toBe(false);
  const merged: InboxItem = {
    ...archived,
    id: "chat:chat",
    messageIds: [...kept.messageIds, ...archived.messageIds],
    messages: [...kept.messages, ...archived.messages],
  };
  expect(h.archived(merged)).toBe(false);
  updateArchive(h.scope, kept, true);
  expect(h.archived(merged)).toBe(true);
});

it("persists a regrouped archive coordinate after its original evidence is replaced", () => {
  const h = fixture();
  const rootId = "a".repeat(64);
  const reply = message(h.alice, "room", "Unresolved reply", 20, [
    ["e", rootId, "", "reply"],
  ]);
  const unresolvedReply: InboxItem = {
    ...h.item,
    id: `room:${reply.id}`,
    target: { kind: "message", channelId: "room", messageId: reply.id },
    messageId: reply.id,
    latestMessageId: reply.id,
    messageIds: [reply.id],
    createdAt: reply.created_at,
    mentioned: false,
    messages: [{ id: reply.id, createdAt: reply.created_at, mentioned: false }],
    thread: true,
  };
  updateArchive(h.scope, unresolvedReply, true);
  expect(h.archived(unresolvedReply)).toBe(true);

  const regrouped: InboxItem = {
    ...unresolvedReply,
    id: `room:${rootId}`,
    rootId,
    messageIds: [reply.id, "b".repeat(64)],
  };
  reopenArchives(h.scope, [regrouped]);
  const laterReplies: InboxItem = {
    ...regrouped,
    messageId: "c".repeat(64),
    latestMessageId: "c".repeat(64),
    messageIds: ["c".repeat(64)],
    createdAt: 29,
    messages: [{ id: "c".repeat(64), createdAt: 29, mentioned: false }],
  };
  expect(h.archived(laterReplies)).toBe(true);

  const saved = readArchives(viewRevision(h.scope, archiveKey));
  expect(saved).toEqual([
    {
      id: regrouped.id,
      channelId: h.item.channelId,
      through: 30,
      messageIds: [reply.id],
    },
  ]);
});

it.each([2, 40, 54])(
  "keeps a grouped archive stable while its evidence splits into %i unresolved rows",
  (count) => {
    const h = fixture();
    const items: InboxItem[] = Array.from({ length: count }, (_, index) => {
      const id = (index + 1).toString(16).padStart(64, "0");
      return {
        ...h.item,
        id: `room:${id}`,
        messageId: id,
        latestMessageId: id,
        messageIds: [id],
        target: { kind: "message", channelId: "room", messageId: id },
        mentioned: false,
        messages: [{ id, createdAt: 20, mentioned: false }],
        thread: true,
      };
    });
    const rootId = "f".repeat(64);
    const grouped: InboxItem = {
      ...h.item,
      id: `room:${rootId}`,
      rootId,
      target: { kind: "thread", channelId: "room", rootId },
      messageIds: items.flatMap((item) => item.messageIds),
      mentioned: false,
      messages: items.flatMap((item) => item.messages),
      thread: true,
    };
    updateArchive(h.scope, grouped, true);
    const unrelated = { ...h.item, channelId: "other-room" };
    updateArchive(h.scope, unrelated, true);
    const draftKey = `buzz-view.v1:${JSON.stringify([h.scope, "draft:room"])}`;
    localStorage.setItem(draftKey, JSON.stringify("Unsent draft"));
    const original = viewRevision(h.scope, archiveKey);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    for (const evidence of [items, items, [...items].reverse()]) {
      reopenArchives(h.scope, evidence);
      expect(viewRevision(h.scope, archiveKey)).toBe(original);
      expect(evidence.every(h.archived)).toBe(true);
    }
    // Even a single remaining unresolved reply must not downgrade the root.
    reopenArchives(h.scope, items.slice(0, 1));
    reopenArchives(h.scope, [grouped]);
    reopenArchives(h.scope, [grouped]);
    expect(viewRevision(h.scope, archiveKey)).toBe(original);
    expect(writes).not.toHaveBeenCalled();
    expect(localStorage.getItem(draftKey)).toBe(JSON.stringify("Unsent draft"));
    expect(h.archived(unrelated)).toBe(true);
  },
);

it.each([false, true])(
  "does not choose between ambiguous rows when the saved coordinate matches one: %s",
  (matchesCurrent) => {
    const h = fixture();
    const secondId = "b".repeat(64);
    const second: InboxItem = {
      ...h.item,
      id: `room:${secondId}`,
      target: { kind: "message", channelId: "room", messageId: secondId },
      messageId: secondId,
      latestMessageId: secondId,
      messageIds: [secondId],
      messages: [{ id: secondId, createdAt: 20, mentioned: false }],
      thread: true,
    };
    const saved = {
      ...h.item,
      id: matchesCurrent ? second.id : "room:old-coordinate",
      messageIds: [...h.item.messageIds, secondId],
    };
    updateArchive(h.scope, saved, true);
    const original = viewRevision(h.scope, archiveKey);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const unresolved = { ...h.item, thread: true };
    for (const evidence of [
      [unresolved, second],
      [second, unresolved],
    ]) {
      reopenArchives(h.scope, evidence);
      expect(viewRevision(h.scope, archiveKey)).toBe(original);
    }
    expect(writes).not.toHaveBeenCalled();
    const rootId = "a".repeat(64);
    const grouped: InboxItem = {
      ...saved,
      id: `room:${rootId}`,
      rootId,
      target: { kind: "thread", channelId: "room", rootId },
    };
    reopenArchives(h.scope, [grouped]);
    expect(readArchives(viewRevision(h.scope, archiveKey))).toEqual([
      {
        id: grouped.id,
        channelId: "room",
        through: 30,
        messageIds: saved.messageIds,
      },
    ]);
    writes.mockClear();
    for (const evidence of [
      [grouped],
      [unresolved, second],
      [second],
      [grouped],
    ])
      reopenArchives(h.scope, evidence);
    expect(writes).not.toHaveBeenCalled();
  },
);

it("does not rewrite a lone unresolved reply or choose between verified root matches", () => {
  const h = fixture();
  const secondId = "b".repeat(64);
  const rootId = "a".repeat(64);
  updateArchive(
    h.scope,
    {
      ...h.item,
      id: `room:${rootId}`,
      messageIds: [...h.item.messageIds, secondId],
    },
    true,
  );
  const original = viewRevision(h.scope, archiveKey);
  const writes = vi.spyOn(Storage.prototype, "setItem");
  reopenArchives(h.scope, [{ ...h.item, thread: true }]);
  expect(viewRevision(h.scope, archiveKey)).toBe(original);
  const first: InboxItem = {
    ...h.item,
    id: `room:${rootId}`,
    rootId,
    target: { kind: "thread", channelId: "room", rootId },
    thread: true,
  };
  const second: InboxItem = {
    ...first,
    id: `room:${secondId}`,
    rootId: secondId,
    target: { kind: "thread", channelId: "room", rootId: secondId },
    messageIds: [secondId],
    messages: [{ id: secondId, createdAt: 20, mentioned: false }],
  };
  for (const evidence of [
    [first, second],
    [second, first],
  ]) {
    reopenArchives(h.scope, evidence);
    expect(viewRevision(h.scope, archiveKey)).toBe(original);
  }
  expect(writes).not.toHaveBeenCalled();
});

it("retires an ambiguous archive for a fresh mention without changing unrelated intent", () => {
  const h = fixture();
  const secondId = "b".repeat(64);
  updateArchive(
    h.scope,
    { ...h.item, messageIds: [...h.item.messageIds, secondId] },
    true,
  );
  const unrelated = { ...h.item, channelId: "other-room" };
  updateArchive(h.scope, unrelated, true);
  const fresh = {
    ...h.item,
    id: `room:${secondId}`,
    messageIds: [secondId, "c".repeat(64)],
    messages: [{ id: "c".repeat(64), createdAt: 30, mentioned: true }],
    thread: true,
  };
  const writes = vi.spyOn(Storage.prototype, "setItem");
  reopenArchives(h.scope, [h.item, fresh]);
  expect(h.archived(h.item)).toBe(false);
  expect(h.archived(fresh)).toBe(false);
  expect(h.archived(unrelated)).toBe(true);
  expect(writes).toHaveBeenCalledTimes(1);
  writes.mockClear();
  reopenArchives(h.scope, [fresh, h.item]);
  expect(writes).not.toHaveBeenCalled();
});

it("partitions archives by community and viewer, and never hides a failed save", () => {
  const h = fixture();
  updateArchive(h.scope, h.item, true);
  expect(
    readArchives(viewRevision("https://other.test:viewer", archiveKey)),
  ).toEqual([]);
  expect(
    readArchives(
      viewRevision(`https://relay.test:${h.alice.pubkey}`, archiveKey),
    ),
  ).toEqual([]);
  updateArchive(h.scope, h.item, false);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("disk full");
  });
  expect(() => updateArchive(h.scope, h.item, true)).toThrow("Could not save");
  expect(h.archived()).toBe(false);
});

it("ignores malformed archive records", () => {
  expect(readArchives("{bad json")).toEqual([]);
  expect(
    readArchives(
      '[{"id":"room:root","channelId":"room","through":0,"messageIds":["invalid"]}]',
    ),
  ).toEqual([]);
});

it("reconciles duplicate reopening effects without reporting a failed save", () => {
  const h = fixture();
  updateArchive(h.scope, h.item, true);
  const revision = viewRevision(h.scope, archiveKey);
  const tag = message(h.alice, "room", "New request", 30, [
    ["p", h.viewer.pubkey],
  ]);
  const reopened = {
    ...h.item,
    messageIds: [...h.item.messageIds, tag.id],
    messages: [
      ...h.item.messages,
      { id: tag.id, createdAt: 30, mentioned: true },
    ],
  };
  reopenArchives(h.scope, [reopened], revision);
  expect(() => reopenArchives(h.scope, [reopened], revision)).not.toThrow();
  expect(readArchives(viewRevision(h.scope, archiveKey))).toEqual([]);
});

it("does not overwrite a newer archive intent when reopening an older revision", () => {
  const h = fixture();
  updateArchive(h.scope, h.item, true);
  const revision = viewRevision(h.scope, archiveKey);
  const tag = message(h.alice, "room", "New request", 30, [
    ["p", h.viewer.pubkey],
  ]);
  const reopened = {
    ...h.item,
    messageIds: [...h.item.messageIds, tag.id],
    messages: [
      ...h.item.messages,
      { id: tag.id, createdAt: 30, mentioned: true },
    ],
  };
  updateArchive(h.scope, reopened, true);
  const latest = viewRevision(h.scope, archiveKey);
  expect(() => reopenArchives(h.scope, [reopened], revision)).not.toThrow();
  expect(viewRevision(h.scope, archiveKey)).toBe(latest);
  expect(h.archived(reopened)).toBe(true);
});

it("reports a genuine reopening write failure without retiring the archive", () => {
  const h = fixture();
  updateArchive(h.scope, h.item, true);
  const revision = viewRevision(h.scope, archiveKey);
  const tag = message(h.alice, "room", "New request", 30, [
    ["p", h.viewer.pubkey],
  ]);
  const reopened = {
    ...h.item,
    messageIds: [...h.item.messageIds, tag.id],
    messages: [
      ...h.item.messages,
      { id: tag.id, createdAt: 30, mentioned: true },
    ],
  };
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("disk full");
  });
  expect(() => reopenArchives(h.scope, [reopened], revision)).toThrow(
    "Could not save the reopened Inbox conversation",
  );
  expect(viewRevision(h.scope, archiveKey)).toBe(revision);
});

it("reopens a flat Solo conversation on an ordinary response with message read targets", () => {
  const h = fixture();
  const item = {
    ...h.item,
    id: "room:room",
    mentioned: false,
    messages: h.item.messages.map((entry) => ({ ...entry, mentioned: false })),
  };
  updateArchive(h.scope, item, true);
  expect(h.archived(item)).toBe(true);
  const fresh = {
    ...item,
    messageIds: [...item.messageIds, "b".repeat(64)],
    messages: [
      ...item.messages,
      { id: "b".repeat(64), createdAt: 31, mentioned: false },
    ],
  };
  expect(h.archived(fresh)).toBe(false);
  reopenArchives(h.scope, [fresh]);
  expect(h.archived(item)).toBe(false);
  expect(
    isArchived(
      archiveIndex(readArchives(viewRevision(h.scope, archiveKey))),
      fresh,
      true,
    ),
  ).toBe(true);
});
