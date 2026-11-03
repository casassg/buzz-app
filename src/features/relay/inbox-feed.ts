import {
  discoverInboxThreads,
  INBOX_THREAD_WINDOW_SECONDS,
} from "./inbox-thread-history";
import type { ThreadFollows } from "./thread-follows";
import { byteSize } from "./budget";
import type { ChannelQueries } from "./contracts";
import type { RelayEvent, ReadFilter } from "./events";
import type { RelayReader } from "./reader";

const mentionKinds = [9, 40002];
const cursorOf = (event: RelayEvent) => ({
  until: event.created_at,
  before_id: event.id,
});
const older = (event: RelayEvent, cursor: ReturnType<typeof cursorOf>) =>
  event.created_at < cursor.until ||
  (event.created_at === cursor.until && event.id > cursor.before_id);
export type InboxFeedSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  error?: string | undefined;
  /** Exact addressed targets whose stored edits/deletions are not settled. */
  incomplete: readonly string[];
}>;

/** The session owns finite, verified, viewer-addressed history. No new live route,
 * polling, or parallel channel store. Current membership gates completeness targets. */
export function createInboxFeed({
  viewer,
  channels,
  reader,
  addressedRead,
  retainedEvent,
  retainedEditIds,
  threadHistory,
  notify = (listener) => listener(),
}: {
  threadHistory?: {
    choices(): ThreadFollows;
    incomingIds(flatOnly?: boolean): readonly string[];
    read(
      filter: ReadFilter,
      signal: AbortSignal,
    ): Promise<readonly RelayEvent[]>;
    admit(
      events: readonly RelayEvent[],
      signal: AbortSignal,
      prepare: (events: readonly RelayEvent[]) => void,
    ): readonly RelayEvent[];
  };
  viewer: string;
  channels: ChannelQueries;
  reader: RelayReader;
  /** Private lookups in the existing bounded unread evidence owner. */
  retainedEvent: (id: string) => RelayEvent | undefined;
  retainedEditIds: (ids: readonly string[]) => readonly string[];
  /** Verified session admission calls prepare before publishing unread evidence. */
  addressedRead: (
    filter: ReadFilter,
    signal: AbortSignal,
    prepare: (events: readonly RelayEvent[]) => void,
  ) => Promise<readonly RelayEvent[]>;
  notify?: (listener: () => void) => void;
}) {
  let closed = false;
  let epoch = 0;
  let work: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let requested = false;
  let snapshot: InboxFeedSnapshot = Object.freeze({
    status: "idle",
    incomplete: [],
  });
  const listeners = new Set<() => void>();
  // Metadata can hide a row without revoking access. Settle its overlays before
  // later ordinary metadata can reveal the retained mention.
  const admitted = (event: RelayEvent) => {
    const hs = event.tags.filter(([name]) => name === "h");
    return (
      hs.length === 0 ||
      (hs.length === 1 &&
        channels
          .list()
          .channels.some(
            (channel) =>
              channel.id === hs[0]?.[1] &&
              !channel.huddle &&
              !channel.cached &&
              channel.members?.includes(viewer),
          ))
    );
  };
  function project(events: readonly RelayEvent[], addressedOnly = false) {
    return Object.freeze(
      events.filter(
        (event) =>
          mentionKinds.includes(event.kind) &&
          admitted(event) &&
          (!addressedOnly ||
            event.tags.some(
              ([name, value]) => name === "p" && value === viewer,
            )),
      ),
    );
  }
  function publish(patch: Partial<InboxFeedSnapshot>) {
    if (closed) return;
    snapshot = Object.freeze({
      ...snapshot,
      ...patch,
    });
    for (const listener of listeners) notify(listener);
  }
  async function overlays(
    ids: readonly string[],
    kinds: readonly number[],
    signal: AbortSignal,
  ) {
    if (!ids.length) return [];
    const collected: RelayEvent[] = [];
    let cursor: ReturnType<typeof cursorOf> | undefined;
    for (;;) {
      const page = [
        ...(await reader.read(
          [
            {
              kinds,
              "#e": ids,
              limit: 500,
              ...(cursor ?? {}),
            },
          ],
          { signal },
        )),
      ].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
      const previous = cursor;
      if (previous && page.some((event) => !older(event, previous)))
        throw new Error("Inbox message updates did not advance. Retry inbox.");
      collected.push(...page);
      if (collected.length > 2000 || byteSize(collected) > 4 * 1024 * 1024)
        throw new Error(
          "Inbox message updates exceed the read budget. Retry inbox.",
        );
      const last = page.at(-1);
      if (!last) return collected;
      cursor = cursorOf(last);
      // Authorized responses can have short pages. Only empty ends the walk.
    }
  }
  /** One closure governs admission for addressed and thread history: stored
   * edits and deletions of the targets, then deletions of their edits. */
  async function settle(ids: readonly string[], signal: AbortSignal) {
    const updates = await overlays(ids, [40003, 5, 9005], signal);
    await overlays(
      [
        ...new Set([
          ...retainedEditIds(ids),
          ...updates
            .filter((event) => event.kind === 40003)
            .map((event) => event.id),
        ]),
      ],
      [5, 9005],
      signal,
    );
  }
  /** Channels discovery may read: verified, current, unarchived membership. */
  const discoveryChannels = () =>
    channels
      .list()
      .channels.filter(
        (channel) =>
          !channel.huddle &&
          !channel.cached &&
          !channel.archived &&
          !channel.metadataPending &&
          channel.members?.includes(viewer),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  /** Restored channels the latest discovery skipped until verified. */
  let unverified: ReadonlySet<string> | undefined;
  async function refresh() {
    if (closed) return;
    if (work) return work;
    requested = true;
    const generation = epoch;
    const owned = new AbortController();
    controller = owned;
    // Do not clear incomplete targets on retry: the new first read can re-admit
    // the old body before its stored overlays are checked again.
    work = (async () => {
      try {
        // Bounded addressed chat history; nonchat and approvals belong elsewhere.
        const mentionFilter: ReadFilter = {
          kinds: mentionKinds,
          "#p": [viewer],
          limit: 50,
        };
        const mentions = await addressedRead(
          mentionFilter,
          owned.signal,
          (events) => {
            if (closed || generation !== epoch || owned.signal.aborted) return;
            const ids = project(events, true).map((event) => event.id);
            if (ids.length)
              publish({
                incomplete: Object.freeze([
                  ...new Set([...snapshot.incomplete, ...ids]),
                ]),
              });
          },
        );
        if (closed || generation !== epoch) return;
        // Retry older failed targets even when newer addressed rows pushed them
        // beyond the latest page; never clear an unchecked exact ID.
        const targets = [
          ...new Set([
            ...snapshot.incomplete,
            ...project(mentions, true).map((event) => event.id),
          ]),
        ];
        await settle(targets, owned.signal);
        if (closed || generation !== epoch) return;
        publish({ incomplete: [] });
        if (threadHistory) {
          const eligible = discoveryChannels();
          unverified = new Set(
            channels
              .list()
              .channels.filter(
                (channel) => channel.cached || channel.metadataPending,
              )
              .map((channel) => channel.id),
          );
          await discoverInboxThreads({
            viewer,
            channelIds: eligible.map((channel) => channel.id),
            soloChannelIds: eligible
              .filter((channel) => channel.channelType === "solo")
              .map((channel) => channel.id),
            choices: threadHistory.choices(),
            since: Math.floor(Date.now() / 1000) - INBOX_THREAD_WINDOW_SECONDS,
            read: threadHistory.read,
            signal: owned.signal,
            admit: async (events, signal, flatOnly) => {
              const admitted = threadHistory.admit(
                events,
                signal,
                (visible) => {
                  const ids = project(visible).map((event) => event.id);
                  publish({
                    incomplete: Object.freeze([
                      ...new Set([...snapshot.incomplete, ...ids]),
                    ]),
                  });
                },
              );
              const ids = project(admitted).map((event) => event.id);
              await settle(ids, signal);
              if (closed || generation !== epoch || signal.aborted) return [];
              const settled = new Set(ids);
              publish({
                incomplete: Object.freeze(
                  snapshot.incomplete.filter((id) => !settled.has(id)),
                ),
              });
              return threadHistory.incomingIds(flatOnly);
            },
          });
        }
        if (closed || generation !== epoch) return;
        publish({
          status: "ready",
          incomplete: [],
          error: undefined,
        });
      } catch (error) {
        if (closed || generation !== epoch || owned.signal.aborted) return;
        publish({
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "Inbox history unavailable",
        });
      }
    })().finally(() => {
      if (controller === owned) {
        controller = undefined;
        work = undefined;
      }
    });
    if (generation === epoch && controller === owned)
      publish({ status: "loading", error: undefined });
    return work;
  }
  function clear(incomplete: readonly string[] = []) {
    epoch++;
    controller?.abort();
    controller = undefined;
    work = undefined;
    unverified = undefined;
    // Previously demanded data recovers explicitly or through reconnect.
    publish({ status: "idle", incomplete, error: undefined });
  }
  function stale() {
    epoch++;
    controller?.abort();
    controller = undefined;
    work = undefined;
    unverified = undefined;
    publish({
      status: "idle",
      incomplete: retainedIncomplete(),
      error: undefined,
    });
  }
  function reconnect() {
    if (requested) void refresh();
  }
  // A restored channel joins discovery once verified. Demanded discovery that
  // skipped it renews, as a follow change does. A newly joined channel does
  // not: its pre-membership history needs fresh shared admission instead.
  const stopChannels = threadHistory
    ? channels.subscribeList(() => {
        const skipped = unverified;
        if (closed || !skipped?.size) return;
        if (discoveryChannels().some((channel) => skipped.has(channel.id))) {
          stale();
          reconnect();
        }
      })
    : undefined;
  const retainedIncomplete = () =>
    Object.freeze(snapshot.incomplete.filter((id) => retainedEvent(id)));
  return Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure: () =>
      work ?? (snapshot.status === "idle" ? refresh() : Promise.resolve()),
    refresh,
    stale,
    reconnect,
    clear: () => clear(),
    purge: () => clear(retainedIncomplete()),
    dispose() {
      closed = true;
      stopChannels?.();
      epoch++;
      controller?.abort();
      controller = undefined;
      work = undefined;
      // Retained capabilities expose no retired content; do not notify dead consumers.
      snapshot = Object.freeze({
        status: "idle",
        incomplete: [],
      });
      listeners.clear();
    },
  });
}
