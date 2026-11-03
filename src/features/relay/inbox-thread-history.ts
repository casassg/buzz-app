import type { ReadFilter, RelayEvent } from "./events";
import type { ThreadFollows } from "./thread-follows";
import { threadReference } from "./thread-reference";
import { agentAudience } from "./audience";
import { byteSize } from "./budget";

type Cursor = { until: number; before_id: string };
type Target = { channelId: string; rootId: string; witness?: RelayEvent };

/** How far back discovery looks for participating threads and Solo replies. */
export const INBOX_THREAD_WINDOW_SECONDS = 30 * 86_400;

/** Reaching the read budget ends discovery early; it is not a failure. */
class Limited extends Error {}

/** Finite discovery independent of busy-channel catch-up. Authored seeds stay
 * outside unread retention; only threads with incoming replies admit a witness.
 * Reads stay inside the `since` window. Reaching the budget is bounded
 * completion (`complete: false`): rows already admitted stay, and retrying
 * would repeat the same walk. */
export async function discoverInboxThreads(
  options: Parameters<typeof walk>[0],
): Promise<{ complete: boolean }> {
  try {
    await walk(options);
    return { complete: true };
  } catch (error) {
    if (error instanceof Limited && !options.signal.aborted)
      return { complete: false };
    throw error;
  }
}

async function walk({
  viewer,
  channelIds,
  soloChannelIds = [],
  choices,
  since,
  read,
  admit,
  signal,
}: {
  viewer: string;
  channelIds: readonly string[];
  soloChannelIds?: readonly string[];
  choices: ThreadFollows;
  /** Oldest creation time read, in Unix seconds. */
  since?: number;
  read: (
    filter: ReadFilter,
    signal: AbortSignal,
  ) => Promise<readonly RelayEvent[]>;
  admit: (
    events: readonly RelayEvent[],
    signal: AbortSignal,
    flatOnly?: boolean,
  ) => Promise<readonly string[]>;
  signal: AbortSignal;
}) {
  const channels = new Set(channelIds);
  const seen = new Set<string>();
  let seeds = 0,
    bytes = 0,
    requests = 0,
    retained = 0;
  const limited = () => new Limited("Inbox thread history reached its limit.");
  const page = async (filter: ReadFilter, cursor?: Cursor) => {
    signal.throwIfAborted();
    if (++requests > 256) throw limited();
    // The window bounds discovery walks; an exact root read is not a walk, and
    // an old root with an in-window reply must still arrive.
    const window = since === undefined || filter.ids ? {} : { since };
    const rows = [
      ...(await read({ ...filter, ...window, ...cursor }, signal)),
    ].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
    signal.throwIfAborted();
    bytes += byteSize(rows);
    if (bytes > 4 * 1024 * 1024) throw limited();
    if (
      cursor &&
      rows.some(
        (event) =>
          event.created_at > cursor.until ||
          (event.created_at === cursor.until && event.id <= cursor.before_id),
      )
    )
      throw new Error("Inbox thread history did not advance. Retry inbox.");
    return rows;
  };
  const cursorOf = (event: RelayEvent): Cursor => ({
    until: event.created_at,
    before_id: event.id,
  });
  const channelOf = (event: RelayEvent) => {
    const tags = event.tags.filter(([name]) => name === "h");
    return tags.length === 1 ? tags[0]?.[1] : undefined;
  };
  const load = async (targets: readonly Target[]) => {
    const pending = new Map<string, Target>();
    for (const target of targets) {
      const key = `${target.channelId}:${target.rootId}`;
      if (
        seen.has(key) ||
        choices.get(key) === false ||
        !channels.has(target.channelId)
      )
        continue;
      seen.add(key);
      pending.set(key, target);
    }
    // One walk covers every channel in the batch. Each root stops only after
    // its incoming activity survives the shared edit/delete fold, so a busy
    // root must not consume other roots' budget.
    let cursor: Cursor | undefined;
    while (pending.size) {
      const open = [...pending.values()];
      const replies = await page(
        {
          kinds: [9, 40002],
          "#h": [...new Set(open.map((target) => target.channelId))],
          "#e": [...new Set(open.map((target) => target.rootId))],
          limit: 100,
        },
        cursor,
      );
      const found = new Map<string, RelayEvent[]>();
      for (const event of replies) {
        const root = threadReference(event)?.rootId;
        const key = root && `${channelOf(event)}:${root}`;
        if (
          !key ||
          !pending.has(key) ||
          event.pubkey === viewer ||
          agentAudience(event)
        )
          continue;
        const group = found.get(key) ?? [];
        group.push(event);
        found.set(key, group);
      }
      if (found.size) {
        const threads = open.filter((target) =>
          found.has(`${target.channelId}:${target.rootId}`),
        );
        const roots = await page({
          kinds: [9, 40002],
          ids: [...new Set(threads.map((target) => target.rootId))],
          "#h": [...new Set(threads.map((target) => target.channelId))],
          limit: found.size,
        });
        const events = roots.filter((root) =>
          found.has(`${channelOf(root)}:${root.id}`),
        );
        for (const [key, replies] of found) {
          const witness = pending.get(key)?.witness;
          if (witness) events.push(witness);
          events.push(...replies);
        }
        retained += events.length;
        if (retained > 2000) throw limited();
        const surviving = new Set(await admit(events, signal));
        signal.throwIfAborted();
        for (const [key, replies] of found)
          if (replies.some((event) => surviving.has(event.id)))
            pending.delete(key);
      }
      const last = replies.at(-1);
      if (!last) break;
      cursor = cursorOf(last);
    }
  };
  // Find a surviving incoming flat message per Solo chat, independently of
  // aggregate channel catch-up. Settled channels leave the next query so a
  // busy conversation cannot starve quieter ones.
  for (let offset = 0; offset < soloChannelIds.length; offset += 128) {
    const pending = new Set(soloChannelIds.slice(offset, offset + 128));
    let cursor: Cursor | undefined;
    while (pending.size) {
      const rows = await page(
        { kinds: [9, 40002], "#h": [...pending], limit: 100 },
        cursor,
      );
      const incoming = rows.filter(
        (event) =>
          event.pubkey !== viewer &&
          !agentAudience(event) &&
          !threadReference(event)?.parentId,
      );
      retained += incoming.length;
      if (retained > 2000) throw limited();
      if (incoming.length) {
        const surviving = new Set(await admit(incoming, signal, true));
        signal.throwIfAborted();
        for (const event of incoming) {
          if (!surviving.has(event.id)) continue;
          const tags = event.tags.filter(([name]) => name === "h");
          if (tags.length === 1 && tags[0]?.[1]) pending.delete(tags[0][1]);
        }
      }
      const last = rows.at(-1);
      if (!last) break;
      cursor = cursorOf(last);
    }
  }
  const followed: Target[] = [];
  for (const [key, following] of choices) {
    if (!following) continue;
    const split = key.lastIndexOf(":");
    followed.push({
      channelId: key.slice(0, split),
      rootId: key.slice(split + 1),
    });
  }
  for (let offset = 0; offset < followed.length; offset += 100)
    await load(followed.slice(offset, offset + 100));
  for (let offset = 0; offset < channelIds.length; offset += 128) {
    let cursor: Cursor | undefined;
    for (;;) {
      const authored = await page(
        {
          kinds: [9, 40002],
          authors: [viewer],
          "#h": channelIds.slice(offset, offset + 128),
          limit: 100,
        },
        cursor,
      );
      seeds += authored.length;
      if (seeds > 2000) throw limited();
      const targets: Target[] = [];
      for (const event of authored) {
        if (event.pubkey !== viewer) continue;
        const tags = event.tags.filter(([name]) => name === "h");
        const channelId = tags.length === 1 ? tags[0]?.[1] : undefined;
        if (channelId)
          targets.push({
            channelId,
            rootId: threadReference(event)?.rootId ?? event.id,
            witness: event,
          });
      }
      await load(targets);
      const last = authored.at(-1);
      if (!last) break;
      cursor = cursorOf(last);
    }
  }
}
