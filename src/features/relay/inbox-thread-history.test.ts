import { expect, it, vi } from "vitest";
import { discoverInboxThreads } from "./inbox-thread-history";
import { keypair, message } from "./testing";
import { matchesEvent } from "./projection";
import type { ReadFilter, RelayEvent } from "./events";

function fixture(history: RelayEvent[]) {
  const read = vi.fn(async (filter: ReadFilter) =>
    history
      .filter((event) => matchesEvent(event, filter))
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
      .slice(0, filter.limit),
  );
  const admit = vi.fn(async (events: readonly RelayEvent[]) =>
    events.map((event) => event.id),
  );
  return { read, admit };
}
it("batches 100 authored posts without replies into three reads", async () => {
  const viewer = keypair();
  const f = fixture(
    Array.from({ length: 100 }, (_, i) =>
      message(viewer, "room", `post ${i}`, i),
    ),
  );
  await discoverInboxThreads({
    ...f,
    viewer: viewer.pubkey,
    channelIds: ["room"],
    choices: new Map(),
    signal: new AbortController().signal,
  });
  expect(f.read).toHaveBeenCalledTimes(3);
  expect(f.admit).not.toHaveBeenCalled();
});
it("pages past a full self-only reply page, including equal timestamps", async () => {
  const viewer = keypair(),
    other = keypair();
  const root = message(viewer, "room", "root", 1);
  const tags = [
    ["e", root.id, "", "root"],
    ["e", root.id, "", "reply"],
  ];
  const incoming = message(other, "room", "incoming", 2, tags);
  const f = fixture([
    root,
    incoming,
    ...Array.from({ length: 100 }, (_, i) =>
      message(viewer, "room", `self ${i}`, 3, tags),
    ),
  ]);
  await discoverInboxThreads({
    ...f,
    viewer: viewer.pubkey,
    channelIds: ["room"],
    choices: new Map(),
    signal: new AbortController().signal,
  });
  expect(
    f.admit.mock.calls.flatMap(([events]) => events).map((event) => event.id),
  ).toContain(incoming.id);
  expect(
    f.read.mock.calls.some(([filter]) => filter["#e"] && filter.before_id),
  ).toBe(true);
});
it("honors an explicit unfollow despite authored participation", async () => {
  const viewer = keypair(),
    other = keypair();
  const root = message(viewer, "room", "root", 1);
  const f = fixture([
    root,
    message(other, "room", "reply", 2, [["e", root.id, "", "reply"]]),
  ]);
  await discoverInboxThreads({
    ...f,
    viewer: viewer.pubkey,
    channelIds: ["room"],
    choices: new Map([[`room:${root.id}`, false]]),
    signal: new AbortController().signal,
  });
  expect(f.admit).not.toHaveBeenCalled();
});
it("rejects a nonadvancing page instead of reporting complete history", async () => {
  const viewer = keypair(),
    root = message(viewer, "room", "root", 1);
  const read = vi.fn(async (filter: ReadFilter) =>
    filter.authors ? [root] : [],
  );
  await expect(
    discoverInboxThreads({
      viewer: viewer.pubkey,
      channelIds: ["room"],
      choices: new Map(),
      read,
      admit: async () => [],
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("did not advance");
});
it("does not admit a raw read completing after cancellation", async () => {
  const viewer = keypair(),
    root = message(viewer, "room", "root", 1);
  const controller = new AbortController();
  const admit = vi.fn(async () => []);
  await expect(
    discoverInboxThreads({
      viewer: viewer.pubkey,
      channelIds: ["room"],
      choices: new Map(),
      read: async () => {
        controller.abort();
        return [root];
      },
      admit,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(admit).not.toHaveBeenCalled();
});

it("finds a quiet second thread without draining a busy thread's backlog", async () => {
  const viewer = keypair(),
    other = keypair();
  const busy = message(viewer, "room", "busy", 1),
    quiet = message(viewer, "room", "quiet", 2);
  const older = message(other, "room", "older", 3, [
    ["e", quiet.id, "", "reply"],
  ]);
  const f = fixture([
    busy,
    quiet,
    older,
    // This helper receives already-verified events. Avoid 2,100 redundant
    // signatures in the pagination fixture; session tests cover verification.
    ...Array.from({ length: 2100 }, (_, i) => ({
      ...older,
      id: (i + 1).toString(16).padStart(64, "0"),
      created_at: 4 + i,
      tags: [
        ["h", "room"],
        ["e", busy.id, "", "reply"],
      ],
    })),
  ]);
  await discoverInboxThreads({
    ...f,
    viewer: viewer.pubkey,
    channelIds: ["room"],
    choices: new Map(),
    signal: new AbortController().signal,
  });
  expect(
    f.admit.mock.calls.flatMap(([events]) => events).map((event) => event.id),
  ).toContain(older.id);
  expect(f.read).toHaveBeenCalledTimes(6);
});

it("finds quiet Solo activity after a busy Solo settles and skips deleted or agent-only pages", async () => {
  const viewer = keypair(),
    other = keypair();
  const busy = message(other, "busy", "busy", 300);
  const quiet = message(other, "quiet", "quiet survivor", 1);
  const deleted = message(other, "quiet", "deleted", 2);
  const noise = message(other, "quiet", "coordination", 3, [
    ["audience", "agents"],
  ]);
  const f = fixture([
    busy,
    quiet,
    deleted,
    ...Array.from({ length: 100 }, (_, i) => ({
      ...noise,
      id: i.toString(16).padStart(64, "0"),
      created_at: 200 - i,
    })),
  ]);
  f.admit.mockImplementation(async (events) =>
    events.filter((event) => event.id !== deleted.id).map((event) => event.id),
  );
  await discoverInboxThreads({
    ...f,
    viewer: viewer.pubkey,
    channelIds: ["busy", "quiet"],
    soloChannelIds: ["busy", "quiet"],
    choices: new Map(),
    signal: new AbortController().signal,
  });
  expect(
    f.admit.mock.calls.flatMap(([events]) => events).map((event) => event.id),
  ).toContain(quiet.id);
  expect(
    f.read.mock.calls.some(
      ([filter]) =>
        filter.before_id &&
        filter["#h"]?.length === 1 &&
        filter["#h"][0] === "quiet",
    ),
  ).toBe(true);
});

it("ends a lifetime of authored posts as bounded completion, not an error", async () => {
  const viewer = keypair();
  const post = message(viewer, "room", "post", 1);
  // Already-verified clones; signatures are irrelevant to the walk.
  const f = fixture(
    Array.from({ length: 2001 }, (_, i) => ({
      ...post,
      id: (i + 1).toString(16).padStart(64, "0"),
      created_at: 1 + i,
    })),
  );
  await expect(
    discoverInboxThreads({
      ...f,
      viewer: viewer.pubkey,
      channelIds: ["room"],
      choices: new Map(),
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({ complete: false });
});

it("reads replies for many channels together and stays in the window", async () => {
  const viewer = keypair(),
    other = keypair();
  const channelIds = Array.from({ length: 20 }, (_, i) => `room-${i}`);
  const post = message(viewer, "room-0", "post", 1);
  const posts = Array.from({ length: 1300 }, (_, i) => ({
    ...post,
    id: (i + 1).toString(16).padStart(64, "0"),
    created_at: 100 + i,
    tags: [["h", `room-${i % 20}`]],
  }));
  // Post 650 (room-10) gets the only incoming reply.
  const root = posts[650];
  if (!root) throw new Error("missing fixture post");
  const reply = message(other, "room-10", "reply", 5000, [
    ["e", root.id, "", "reply"],
  ]);
  const stale = message(viewer, "room-0", "outside the window", 50);
  const f = fixture([...posts, reply, stale]);
  await expect(
    discoverInboxThreads({
      ...f,
      viewer: viewer.pubkey,
      channelIds,
      choices: new Map(),
      since: 100,
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({ complete: true });
  expect(
    f.admit.mock.calls.flatMap(([events]) => events).map((event) => event.id),
  ).toEqual(expect.arrayContaining([root.id, reply.id]));
  // Every walk stays in the window; only exact root reads do not.
  expect(
    f.read.mock.calls.every(
      ([filter]) => (filter.since === 100) === !filter.ids,
    ),
  ).toBe(true);
  expect(f.read.mock.calls.length).toBeLessThan(40);
});

it("reads an out-of-window root for an in-window reply", async () => {
  const viewer = keypair(),
    other = keypair();
  const root = message(other, "room", "old root", 40);
  const tags = [["e", root.id, "", "reply"]];
  const mine = message(viewer, "room", "recent participation", 150, tags);
  const reply = message(other, "room", "reply today", 200, tags);
  const f = fixture([root, mine, reply]);
  await discoverInboxThreads({
    ...f,
    viewer: viewer.pubkey,
    channelIds: ["room"],
    choices: new Map(),
    since: 100,
    signal: new AbortController().signal,
  });
  expect(
    f.admit.mock.calls.flatMap(([events]) => events).map((event) => event.id),
  ).toEqual(expect.arrayContaining([root.id, reply.id]));
});
