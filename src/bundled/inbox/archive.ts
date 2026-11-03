import type { InboxItem } from "../../features/relay/inbox";
import { replaceView, viewRevision } from "../../shared/view-state";

export const archiveKey = "inbox:archives";
type Archive = Readonly<{
  id: string;
  channelId: string;
  through: number;
  messageIds: readonly string[];
  reopened?: boolean;
}>;
const maxBytes = 512 * 1024;

export const hasUnread = (item: InboxItem) =>
  item.unreadCount > 0 || item.manual;

export function readArchives(
  revision: string | null | undefined,
): readonly Archive[] {
  if (!revision || revision.length > maxBytes) return [];
  try {
    const value: unknown = JSON.parse(revision);
    if (!Array.isArray(value) || value.length > 1000) return [];
    return value.filter(
      (entry): entry is Archive =>
        entry &&
        typeof entry.id === "string" &&
        typeof entry.channelId === "string" &&
        Number.isSafeInteger(entry.through) &&
        entry.through >= 0 &&
        (entry.reopened === undefined || typeof entry.reopened === "boolean") &&
        Array.isArray(entry.messageIds) &&
        entry.messageIds.length <= 4096 &&
        entry.messageIds.every(
          (id: unknown) => typeof id === "string" && /^[0-9a-f]{64}$/.test(id),
        ),
    );
  } catch {
    return [];
  }
}

function owns(archive: Archive, item: InboxItem) {
  return (
    archive.channelId === item.channelId &&
    (archive.id === item.id ||
      archive.messageIds.some((id) => item.messageIds.includes(id)))
  );
}

type ArchiveIndex = ReadonlyMap<string, readonly Archive[]>;
const coordinate = (channelId: string, id: string) =>
  JSON.stringify([channelId, id]);
export function archiveIndex(archives: readonly Archive[]): ArchiveIndex {
  const index = new Map<string, Archive[]>();
  for (const archive of archives)
    for (const id of [archive.id, ...archive.messageIds]) {
      const key = coordinate(archive.channelId, id);
      const entries = index.get(key) ?? [];
      entries.push(archive);
      index.set(key, entries);
    }
  return index;
}
function matches(index: ArchiveIndex, item: InboxItem) {
  return [
    ...new Set(
      [item.id, ...item.messageIds].flatMap(
        (id) => index.get(coordinate(item.channelId, id)) ?? [],
      ),
    ),
  ];
}

// The shared Inbox projection groups DMs under a channel read target,
// including top-level messages and replies. Solo flat rows use the same
// channel coordinate but keep individual message read targets.
const ordinaryActivity = (item: InboxItem) =>
  item.thread ||
  item.target.kind === "channel" ||
  item.id === `${item.channelId}:${item.channelId}`;

function renewed(archive: Archive, item: InboxItem, mentionsOnly = false) {
  const observed = new Set(archive.messageIds);
  return item.messages.some(
    ({ id, createdAt, mentioned }) =>
      (mentioned || (!mentionsOnly && ordinaryActivity(item))) &&
      !observed.has(id) &&
      createdAt >= archive.through,
  );
}

// A Solo chat row merges what were separate per-message rows, so archives saved
// for some of them must not hide the rest.
const partial = (entries: readonly Archive[], item: InboxItem) => {
  const observed = new Set(entries.flatMap((archive) => archive.messageIds));
  return (
    item.id === `${item.channelId}:${item.channelId}` &&
    entries.some((archive) => archive.id !== item.id) &&
    !item.messageIds.every((id) => observed.has(id))
  );
};

export function isArchived(
  index: ArchiveIndex,
  item: InboxItem,
  mentionsOnly = false,
) {
  if (!index.size) return false;
  const entries = matches(index, item);
  return (
    entries.length > 0 &&
    !partial(entries, item) &&
    !entries.some(
      (archive) =>
        (!mentionsOnly && ordinaryActivity(item) && archive.reopened) ||
        renewed(archive, item, mentionsOnly),
    )
  );
}

export function updateArchive(
  scope: string,
  item: InboxItem,
  archived: boolean,
  at = Math.floor(Date.now() / 1000),
) {
  const revision = viewRevision(scope, archiveKey);
  const archives = readArchives(revision).filter((entry) => !owns(entry, item));
  if (archived)
    archives.push({
      id: item.id,
      channelId: item.channelId,
      // The row's time may come from a newer message that is not evidence.
      through: Math.max(at, ...item.messages.map(({ createdAt }) => createdAt)),
      messageIds: [...item.messageIds],
    });
  if (archives.length > 1000 || JSON.stringify(archives).length > maxBytes)
    throw new Error(
      "Inbox archive storage is full. Restore some archived conversations first.",
    );
  const result = replaceView(scope, archiveKey, revision, archives);
  if (result !== "saved")
    throw new Error(
      result === "changed"
        ? "Inbox archive changed in another window. Try again."
        : "Could not save the Inbox archive on this device. Try again.",
    );
}

/** Persist reopening while retaining the mention cutoff until a fresh explicit tag. */
export function reopenArchives(
  scope: string,
  items: readonly InboxItem[],
  revision = viewRevision(scope, archiveKey),
) {
  const archives = readArchives(revision);
  if (!archives.length) return;
  const index = archiveIndex(archives);
  const reopened = new Set<Archive>();
  const retired = new Set<Archive>();
  const regrouped = new Map<Archive, InboxItem | null>();
  for (const item of items)
    for (const archive of matches(index, item)) {
      if (renewed(archive, item, true)) retired.add(archive);
      else if (!archive.reopened && renewed(archive, item))
        reopened.add(archive);
      // Count every match, including the saved coordinate: split evidence does
      // not identify a replacement conversation, regardless of row order.
      regrouped.set(archive, regrouped.has(archive) ? null : item);
    }
  const retained = archives
    .filter((archive) => !retired.has(archive))
    .map((archive) => {
      const item = regrouped.get(archive);
      if (reopened.has(archive)) archive = { ...archive, reopened: true };
      // Never downgrade a verified root to an unresolved singleton reply.
      return item?.rootId && archive.id !== item.id
        ? { ...archive, id: item.id }
        : archive;
    });
  if (
    !reopened.size &&
    !retired.size &&
    retained.every((archive, index) => archive === archives[index])
  )
    return;
  // A newer revision is reconciled by the view subscription, not this stale effect.
  if (replaceView(scope, archiveKey, revision, retained) === "failed")
    throw new Error(
      "Could not save the reopened Inbox conversation on this device. Try again.",
    );
}
