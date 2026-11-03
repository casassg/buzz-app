import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { InboxItem } from "../../features/relay/inbox";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  useChannelRoster,
  useRelayConnection,
} from "../../features/relay/react";
import { subscribeView, viewRevision } from "../../shared/view-state";
import {
  archiveIndex,
  archiveKey,
  hasUnread,
  isArchived,
  readArchives,
} from "./archive";
import styles from "./Inbox.module.css";

/** Unread conversations the default Inbox view lists: every activity, not archived. */
function countUnread(
  items: readonly InboxItem[],
  archives: ReturnType<typeof archiveIndex>,
) {
  return items.filter((item) => hasUnread(item) && !isArchived(archives, item))
    .length;
}

/** The Inbox navigation entry's count of unread conversations. */
export function InboxBadge({ relay }: { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  const { viewer, scope } = connection;
  return connection.status === "ready" &&
    viewer &&
    scope?.endsWith(`:${viewer}`) ? (
    <UnreadCount
      key={`${scope}:${connection.generation}`}
      session={connection.session}
    />
  ) : null;
}

function UnreadCount({ session }: { session: RelaySession }) {
  const roster = useChannelRoster(session.channels);
  // Count from the shared unread evidence the sidebar already loads. Inbox's
  // own deeper history (older mentions and threads) is fetched when Inbox
  // opens, not at startup, and then joins the same projection.
  useEffect(() => {
    if (roster.status !== "ready") return;
    void session.unread.ensure();
  }, [session, roster.status]);
  const inbox = useSyncExternalStore(
    session.unread.subscribeInbox,
    session.unread.inbox,
    session.unread.inbox,
  );
  const scope = session.scope;
  const subscribeArchives = useCallback(
    (listener: () => void) => subscribeView(scope, listener),
    [scope],
  );
  const archiveRevision = useSyncExternalStore(subscribeArchives, () =>
    viewRevision(scope, archiveKey),
  );
  const count = useMemo(
    () => countUnread(inbox.items, archiveIndex(readArchives(archiveRevision))),
    [inbox.items, archiveRevision],
  );
  if (!count) return null;
  return (
    <span
      className={styles.navBadge}
      role="img"
      aria-label={`${count} unread ${count === 1 ? "conversation" : "conversations"}`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
