import type { ReadFilter, RelayEvent } from "./events";
import type { ThreadFollows } from "./thread-follows";
import { threadReference } from "./thread-reference";
import { agentAudience } from "./audience";
import { byteSize } from "./budget";

type Cursor = { until: number; before_id: string };
type Target = { channelId: string; rootId: string; witness?: RelayEvent };
/** Finite discovery independent of busy-channel catch-up. Authored seeds stay
 * outside unread retention; only threads with incoming replies admit a witness. */
export async function discoverInboxThreads({
  viewer,
  channelIds,
  soloChannelIds = [],
  choices,
  read,
  admit,
  signal,
}: {
  viewer: string;
  channelIds: readonly string[];
  soloChannelIds?: readonly string[];
  choices: ThreadFollows;
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
  const limited = () =>
    new Error(
      "Some older conversations could not be loaded within the Inbox history limit.",
    );
  const page = async (filter: ReadFilter, cursor?: Cursor) => {
    signal.throwIfAborted();
    if (++requests > 256) throw limited();
    const rows = [...(await read({ ...filter, ...cursor }, signal))].sort(
      (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
    );
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
  const load = async (targets: readonly Target[]) => {
    const grouped = new Map<string, Map<string, Target>>();
    for (const target of targets) {
      const key = `${target.channelId}:${target.rootId}`;
      if (
        seen.has(key) ||
        choices.get(key) === false ||
        !channels.has(target.channelId)
      )
        continue;
      seen.add(key);
      const group = grouped.get(target.channelId) ?? new Map<string, Target>();
      group.set(target.rootId, target);
      grouped.set(target.channelId, group);
    }
    for (const [channelId, pending] of grouped) {
      // Stop each root only after its incoming activity survives the shared
      // edit/delete fold; a busy root must not consume other roots' budget.
      let cursor: Cursor | undefined;
      while (pending.size) {
        const replies = await page(
          {
            kinds: [9, 40002],
            "#h": [channelId],
            "#e": [...pending.keys()],
            limit: 100,
          },
          cursor,
        );
        const found = new Map<string, RelayEvent[]>();
        for (const event of replies) {
          const root = threadReference(event)?.rootId;
          if (
            !root ||
            !pending.has(root) ||
            event.pubkey === viewer ||
            agentAudience(event)
          )
            continue;
          const group = found.get(root) ?? [];
          group.push(event);
          found.set(root, group);
        }
        if (found.size) {
          const roots = await page({
            kinds: [9, 40002],
            ids: [...found.keys()],
            "#h": [channelId],
            limit: found.size,
          });
          const events = [...roots];
          for (const [root, replies] of found) {
            const witness = pending.get(root)?.witness;
            if (witness) events.push(witness);
            events.push(...replies);
          }
          retained += events.length;
          if (retained > 2000) throw limited();
          const surviving = new Set(await admit(events, signal));
          signal.throwIfAborted();
          for (const [root, replies] of found)
            if (replies.some((event) => surviving.has(event.id)))
              pending.delete(root);
        }
        const last = replies.at(-1);
        if (!last) break;
        cursor = cursorOf(last);
      }
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
