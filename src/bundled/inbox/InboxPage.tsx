import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import { workflowLabel } from "../../features/relay/workflow-attribution";
import { LightningIcon } from "../../shared/design-system/icons";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { InboxItem } from "../../features/relay/inbox";
import { usePanelSplit } from "../../features/panels/usePanelSplit";
import { DraftsView } from "./DraftsView";
import type {
  ConversationExtensions,
  PageTabsProps,
  PageTabTarget,
} from "../../features/conversation/contracts";
import type { Navigation } from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import type { PageNavigation } from "../../features/navigation/service";
import { routeOf } from "./route";
import {
  useChannelList,
  useProfileGeneration,
  useRelayConnection,
} from "../../features/relay/react";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useIdentityNames } from "../../features/identity-names/react";
import { messagePreview } from "../../features/notifications/content";
import { formatPublicKey } from "../../shared/identity/public-key";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Button } from "../../shared/design-system/ui/Button";
import {
  InboxFilters,
  type ActivityFilter,
  type ShowFilter,
  type SenderFilter,
} from "./InboxFilters";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import {
  ArchiveIcon,
  ArchiveOffIcon,
  BellIcon,
} from "../../shared/design-system/icons";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuItem,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";
import styles from "./Inbox.module.css";
import { dmLabel } from "./dm-label";
import { channelText } from "../../features/channels/channel-icon";
import {
  readView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import {
  archiveKey,
  archiveIndex,
  hasUnread,
  isArchived,
  readArchives,
  reopenArchives,
  updateArchive,
} from "./archive";
import { avatarMedia } from "../../shared/avatar-source";

type AttentionFilter = "all" | "unread";
const shows = [
  { value: "inbox", label: "Inbox" },
  { value: "archived", label: "Archived" },
] as const;
const activities = [
  { value: "all", label: "All activity" },
  { value: "dms", label: "DMs" },
  { value: "threads", label: "Threads" },
  { value: "mentions", label: "Mentions" },
] as const;
const senders = [
  { value: "everyone", label: "Everyone" },
  { value: "humans", label: "Humans" },
  { value: "agents", label: "Agents" },
] as const;
const attentions = [
  { value: "all", label: "All messages" },
  { value: "unread", label: "Unread only" },
] as const;
type Filters = {
  show: ShowFilter;
  activity: ActivityFilter;
  sender: SenderFilter;
  attention: AttentionFilter;
};
const filtersKey = "inbox:filters";
/** Saved choices are per device/viewer/community; unknown or missing fields use defaults. */
function readFilters(scope: string): Filters {
  const saved = readView<unknown>(scope, filtersKey, undefined);
  const field = <T extends string>(
    key: keyof Filters,
    options: readonly [{ value: T }, ...{ value: T }[]],
  ): T => {
    const value: unknown =
      saved && typeof saved === "object"
        ? (saved as Record<string, unknown>)[key]
        : undefined;
    return (options.find((option) => option.value === value) ?? options[0])
      .value;
  };
  return {
    show: field("show", shows),
    activity: field("activity", activities),
    sender: field("sender", senders),
    attention: field("attention", attentions),
  };
}
const matchesActivity = (
  item: InboxItem,
  filter: ActivityFilter,
  isDm: boolean,
) => {
  switch (filter) {
    case "all":
      return true;
    case "dms":
      return isDm;
    case "mentions":
      return item.mentioned;
    case "threads":
      return item.thread;
  }
};
const targetOf = (item: InboxItem) => ({
  channelId: item.channelId,
  messageId: item.messageId,
  ...(item.rootId ? { rootId: item.rootId } : {}),
});

/** DMs and a Solo chat's own messages open whole; others open at their message. */
const tabTarget = (
  item: InboxItem,
  channel: { channelType?: string } | undefined,
): PageTabTarget =>
  item.target.kind === "channel" ||
  (channel?.channelType === "solo" && !item.thread)
    ? { channelId: item.channelId }
    : {
        channelId: item.channelId,
        threadId: item.rootId ?? item.messageId,
        messageId: item.messageId,
      };

type Selection = { channelId: string; messageId: string; rootId?: string };
// The row a tab opened, kept as long as the session's tabs so returning to
// Inbox still archives and advances from the conversation it restores.
const selections = new WeakMap<
  RelaySession,
  { opened?: PageTabTarget | undefined; target?: Selection | undefined }
>();

type InboxPageTabs = (props: PageTabsProps) => ReactNode;

/** The open conversation's Archive/Restore, published for the Inbox shortcut. */
export type ArchiveShortcut = { current?: (() => void) | undefined };

// Each presentation of a visit (a new open, even of the same address) is a fresh
// navigation object, so a route is applied once per object and never re-applied
// by a remount or re-render of the same one.
const appliedRoutes = new WeakSet<object>();

export function InboxPage({
  relay,
  navigator,
  extensions,
  tabs,
  host,
  archive,
  navigation,
}: {
  relay: RelayData;
  navigator: Navigation;
  navigation?: PageNavigation | undefined;
  extensions?: ConversationExtensions | undefined;
  /** The host tab workspace, `conversation.ui.Tabs`, while a plugin provides it. */
  tabs?: InboxPageTabs | undefined;
  host: ConversationHostServices;
  archive?: ArchiveShortcut | undefined;
}) {
  const connection = useRelayConnection(relay);
  const { viewer, scope } = connection;
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Inbox">
        {connection.status === "ready" &&
        viewer &&
        scope?.endsWith(`:${viewer}`) ? (
          <InboxView
            key={`${scope}:${connection.generation}`}
            session={connection.session}
            scope={{
              viewer,
              communityOrigin: scope.slice(0, -(viewer.length + 1)),
            }}
            navigator={navigator}
            extensions={extensions}
            tabs={tabs}
            host={host}
            archive={archive}
            navigation={navigation}
          />
        ) : (
          <div data-buzz-ui="" className={styles.page}>
            <PanelHeader
              title={
                <PanelHeaderLabel
                  title="Inbox"
                  icon={<BellIcon size="1rem" />}
                />
              }
            />
            <div className={styles.notice} role="status">
              <p className="text-body text-subtle">
                {connection.status === "connecting"
                  ? "Connecting to your inbox…"
                  : (connection.error ??
                    "Choose a community to see your inbox.")}
              </p>
              {connection.status === "error" && (
                <Button onClick={relay.retry}>Retry connection</Button>
              )}
            </div>
          </div>
        )}
      </FullPageSurface>
    </div>
  );
}

type InboxViewProps = {
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
  extensions?: ConversationExtensions | undefined;
  tabs?: InboxPageTabs | undefined;
  host: ConversationHostServices;
  archive?: ArchiveShortcut | undefined;
  navigation?: PageNavigation | undefined;
};

const never = () => false;

/** The conversation list is Inbox's first tab; conversations open beside it. */
export function InboxView({ tabs: Tabs, ...props }: InboxViewProps) {
  const list = (
    open: (target: PageTabTarget) => boolean,
    close: (target: PageTabTarget) => boolean,
    isOpen: (target: PageTabTarget) => boolean,
  ) => <InboxList {...props} open={open} close={close} isOpen={isOpen} />;
  // Without the host tab workspace, rows have nowhere to open.
  if (!Tabs) return list(never, never, never);
  return (
    <Tabs
      id="inbox"
      session={props.session}
      scope={props.session.scope}
      label="Inbox"
      icon={<BellIcon size="1rem" />}
      // Opening reveals a conversation; reading is earned as it is seen.
      visits={false}
    >
      {list}
    </Tabs>
  );
}

function InboxList({
  session,
  scope,
  navigator,
  extensions,
  host,
  archive: archiveShortcut,
  navigation,
  open: openTab,
  close: closeTab,
  isOpen,
}: InboxViewProps & {
  open(target: PageTabTarget): boolean;
  close(target: PageTabTarget): boolean;
  isOpen(target: PageTabTarget): boolean;
}) {
  const split = usePanelSplit(undefined, 316, {
    defaultWidth: 420,
    maxRatio: 0.5,
  });
  const previewId = useId();
  const list = useChannelList(session.channels);
  const inbox = useSyncExternalStore(
    session.unread.subscribeInbox,
    session.unread.inbox,
    session.unread.inbox,
  );
  const feed = useSyncExternalStore(
    session.inboxFeed.subscribe,
    session.inboxFeed.snapshot,
    session.inboxFeed.snapshot,
  );
  const choices = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
    session.agentChoices.snapshot,
  );
  const sync = useSyncExternalStore(
    session.unread.subscribeSync,
    session.unread.sync,
    session.unread.sync,
  );
  const archiveScope = session.scope;
  const [filters, setFilters] = useState(() => readFilters(archiveScope));
  const { show, activity, sender: senderFilter } = filters;
  const unreadOnly = filters.attention === "unread";
  function setFilter(patch: Partial<Filters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    writeView(archiveScope, filtersKey, next);
  }
  const [drafts, setDrafts] = useState(false);
  // A shortcut's open carries filters; a plain open carries none and changes nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new presentation applies its route; later filter edits are the user's.
  useEffect(() => {
    const route = routeOf(navigation?.target);
    // Back/Forward returns to the view as the user left it, not the opening filters.
    if (
      !navigation ||
      !route ||
      navigation.traversal ||
      appliedRoutes.has(navigation)
    )
      return;
    appliedRoutes.add(navigation);
    setFilter({ show: "inbox", ...route });
    setDrafts(false);
  }, [navigation]);
  const subscribeArchives = useCallback(
    (listener: () => void) => subscribeView(archiveScope, listener),
    [archiveScope],
  );
  const archiveRevision = useSyncExternalStore(subscribeArchives, () =>
    viewRevision(archiveScope, archiveKey),
  );
  const filtersRevision = useSyncExternalStore(subscribeArchives, () =>
    viewRevision(archiveScope, filtersKey),
  );
  useEffect(() => {
    void filtersRevision;
    setFilters(readFilters(archiveScope));
  }, [archiveScope, filtersRevision]);
  const archives = useMemo(
    () => archiveIndex(readArchives(archiveRevision)),
    [archiveRevision],
  );
  // The tab a row opened, which archive closes even after its row regroups.
  // Selection lasts as long as that tab.
  const [opened, setOpened] = useState(() => selections.get(session)?.opened);
  const openRow = (item: InboxItem, channel?: { channelType?: string }) => {
    const tab = tabTarget(item, channel);
    const shown = openTab(tab);
    setOpened(shown ? tab : undefined);
    return shown;
  };
  const showing = !!opened && isOpen(opened);
  const [selectedTarget, setSelectedTarget] = useState(
    () => selections.get(session)?.target,
  );
  useEffect(() => {
    selections.set(session, { opened, target: selectedTarget });
  }, [session, opened, selectedTarget]);
  const fallbackRow = useRef<HTMLButtonElement | null>(null);
  const fallbackControl = useRef<HTMLButtonElement | null>(null);
  const viewFocus = useRef(false);
  useLayoutEffect(() => {
    // Switching Drafts replaces the trigger. Restore it only if the dismissed
    // popup still owned focus, not after the user moved to another control.
    void drafts;
    if (!viewFocus.current) return;
    viewFocus.current = false;
    if (document.activeElement === document.body)
      fallbackControl.current?.focus({ preventScroll: true });
  }, [drafts]);
  // Row to focus after its predecessor leaves the list ("" means the toolbar).
  const focusRow = useRef<string | undefined>(undefined);
  const workspace = useRef<HTMLDivElement | null>(null);
  const retryFocus = useRef(false);
  const retiredFocus = useRef(false);
  const retryButton = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    // Capture ownership before removal, not after focus has fallen to body.
    return () => {
      retryFocus.current = document.activeElement === button;
    };
  }, []);

  const [pending, setPending] = useState(false);
  const [refreshAfterRoster, setRefreshAfterRoster] = useState(false);
  const [error, setError] = useState<string>();
  const [menu, setMenu] = useState<{ id: string; anchor?: HTMLElement }>();
  const active = useRef(false);
  const busy = useRef(false);
  const failedMutation = useRef<
    | {
        work: () => Promise<unknown>;
        valid: () => boolean;
        onSuccess: (() => void) | undefined;
      }
    | undefined
  >(undefined);
  const intentRevision = useRef(0);
  function cancelRetry() {
    intentRevision.current++;
    failedMutation.current = undefined;
    setError(undefined);
  }
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    // A completed discovery revision can retire an earlier feed attempt.
    void list.asOf;
    if (list.status !== "ready") return;
    if (refreshAfterRoster) {
      setRefreshAfterRoster(false);
      void Promise.all([session.unread.refresh(), session.inboxFeed.refresh()]);
    } else {
      void session.unread.ensure();
      void session.inboxFeed.ensure();
      session.agentChoices.ensure();
    }
  }, [session, list.status, list.asOf, refreshAfterRoster]);
  const items = inbox.items;
  const archived = (item: InboxItem) =>
    isArchived(archives, item, activity === "mentions");
  const viewItems = items.filter(
    (item) => archived(item) === (show === "archived"),
  );
  useEffect(() => {
    try {
      reopenArchives(archiveScope, inbox.items, archiveRevision);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save the archived conversation.",
      );
    }
  }, [archiveScope, archiveRevision, inbox.items]);
  const activityItems = viewItems
    .map((item) => (activity === "mentions" ? item.mention : item))
    .filter(
      (item): item is InboxItem =>
        !!item &&
        matchesActivity(
          item,
          activity,
          list.channels.some(
            (channel) =>
              channel.id === item.channelId &&
              (channel.channelType === "dm" ||
                (channel.channelType === "solo" && !item.thread)),
          ),
        ),
    )
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  // A late verified root can legitimately regroup channel:reply into
  // channel:root. Keep the captured visit by exact key, never by a namesake.
  // Keep the captured visit mounted if its archive membership changes while open.
  const selected = items.find(
    (item) =>
      item.channelId === selectedTarget?.channelId &&
      item.messageIds.includes(selectedTarget.messageId),
  );
  const selectedId = selected?.id;
  // A room reclassified as a Huddle belongs to its Huddle composer, not Inbox.
  const selectedRetired = list.channels.some(
    (channel) =>
      channel.id === selectedTarget?.channelId &&
      (channel.archived || channel.huddle || channel.metadataPending),
  );
  useEffect(() => {
    if (
      selectedTarget &&
      (selectedRetired || !showing || (!selected && inbox.status !== "loading"))
    ) {
      // Restoring the channel does not reopen its conversation.
      if (selectedRetired && opened && closeTab(opened))
        retiredFocus.current = true;
      // A closed tab ends its visit, so reopening the row reads it again.
      if (selectedRetired || !showing) {
        intentRevision.current++;
        failedMutation.current = undefined;
        setError(undefined);
      }
      setSelectedTarget(undefined);
    }
  }, [
    selectedTarget,
    selected,
    selectedRetired,
    showing,
    opened,
    closeTab,
    inbox.status,
  ]);
  useLayoutEffect(() => {
    if (!retiredFocus.current) return;
    retiredFocus.current = false;
    // Focus the retired tab held, removed or leaving with it, returns to the
    // filters; focus elsewhere stays.
    const focused = document.activeElement;
    if (
      !(focused instanceof HTMLElement) ||
      focused === document.body ||
      !focused.isConnected ||
      focused.closest('[inert], [hidden], [aria-hidden="true"]')
    )
      fallbackControl.current?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (menu && !items.some((item) => item.id === menu.id)) setMenu(undefined);
  }, [items, menu]);
  // Enrich bounded activity candidates before applying Sender: unknown authors
  // must be able to appear after their profiles arrive, even in an empty view.
  // Keep main's bounded optional profile demand, independent of presentation.
  const candidateIds = activityItems.slice(0, 50).map((item) => item.authorId);
  const matchingAuthors = [...new Set(candidateIds)].sort().join(":");
  const authorIds = useMemo(
    () => (matchingAuthors ? matchingAuthors.split(":") : []),
    [matchingAuthors],
  );
  const cachedProfiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  // Classification covers every evaluated author, independently of bounded demand.
  // Winning events can change without changing folded display values.
  useSyncExternalStore(session.profiles.subscribe, () =>
    activityItems
      .map(({ authorId }) => session.profiles.event?.(authorId)?.id ?? "")
      .join(":"),
  );
  const agentIds = new Set(choices.identities.map((agent) => agent.pubkey));
  const senderKind = (authorId: string) => {
    if (agentIds.has(authorId) || cachedProfiles.get(authorId)?.isAgent)
      return "agent";
    // foldProfiles supplies a fallback for malformed kind 0; require a valid
    // signed, parsed object before treating absent agent hints as human display evidence.
    const event = session.profiles.event?.(authorId);
    if (event) {
      try {
        const body: unknown = JSON.parse(event.content);
        if (body !== null && typeof body === "object" && !Array.isArray(body))
          return "human";
      } catch {
        /* Missing or malformed profile is unknown. */
      }
    }
    return "unknown";
  };
  const matching = activityItems.filter(
    (item) =>
      (senderFilter === "everyone" ||
        senderKind(item.authorId) ===
          (senderFilter === "agents" ? "agent" : "human")) &&
      (!unreadOnly ||
        hasUnread(item) ||
        (item.id === selectedId &&
          item.messageIds.includes(selectedTarget?.messageId ?? ""))),
  );
  const visible = matching;
  const archiveView = useRef({ show, visible, selected, opened });
  useLayoutEffect(() => {
    archiveView.current = { show, visible, selected, opened };
  });
  const profileKey = [
    ...new Set([
      ...authorIds,
      ...matching
        .slice(0, 50)
        .flatMap((item) =>
          item.workflowOwnerId ? [item.workflowOwnerId] : [],
        ),
      ...matching.slice(0, 50).flatMap((item) => {
        const channel = list.channels.find(
          (entry) => entry.id === item.channelId,
        );
        return channel?.channelType === "dm"
          ? (channel.participants?.slice(0, 3) ?? [])
          : [];
      }),
    ]),
  ]
    .sort()
    .join(":");
  const profileIds = useMemo(
    () => (profileKey ? profileKey.split(":") : []),
    [profileKey],
  );
  const selection = useMemo(
    () => selectProfiles(session.profiles, profileIds),
    [session, profileIds],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const name = useIdentityNames(session.names);
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    // A settled discovery revision can retire earlier optional profile reads.
    void list.asOf;
    void profileGeneration;
    if (profileIds.length && list.status === "ready")
      void session.profiles.ensure(profileIds, "background").catch(() => {});
  }, [session, profileIds, list.status, list.asOf, profileGeneration]);
  useLayoutEffect(() => {
    const id = focusRow.current;
    if (id === undefined || pending) return;
    focusRow.current = undefined;
    const row = [
      ...(workspace.current?.querySelectorAll<HTMLElement>(
        "li[data-inbox-row]",
      ) ?? []),
    ].find((entry) => entry.dataset.inboxRow === id);
    (
      row?.querySelector<HTMLElement>("button") ?? fallbackControl.current
    )?.focus({ preventScroll: true });
  });
  async function run(
    work: () => Promise<unknown>,
    valid?: () => boolean,
    onSuccess?: () => void,
  ) {
    if (!active.current || busy.current) return;
    busy.current = true;
    setPending(true);
    failedMutation.current = undefined;
    let succeeded = false;
    try {
      if (valid && !valid())
        throw new Error(
          "Inbox action expired. Close and reopen the conversation.",
        );
      await work();
      succeeded = true;
      if (active.current) setError(undefined);
    } catch (cause) {
      if (active.current) {
        if (valid?.()) failedMutation.current = { work, valid, onSuccess };
        setError(
          cause instanceof Error
            ? cause.message
            : "Inbox action failed. Try again.",
        );
      }
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
    // Follow-up reads must run after the mutation releases the busy guard, on Retry too.
    if (succeeded && active.current) onSuccess?.();
  }
  function refresh(retrySync = false) {
    void run(async () => {
      reopenArchives(archiveScope, session.unread.inbox().items);
      if (list.status !== "ready") {
        setRefreshAfterRoster(true);
        session.channels.ensureList();
      } else {
        await Promise.all([
          session.unread.refresh(),
          session.inboxFeed.refresh(),
        ]);
      }
      if (retrySync && active.current) await session.unread.retrySync();
    });
  }
  function archive(item: InboxItem, value: boolean) {
    // Archive captures the conversation, not just the activity-filter projection.
    const conversation = session.unread
      .inbox()
      .items.find(
        (current) =>
          current.channelId === item.channelId &&
          current.messageIds.includes(item.messageId),
      );
    if (!conversation) return;
    cancelRetry();
    // Retry repeats this click's cutoff, not a later clock or newly arrived mention.
    const at = Math.floor(Date.now() / 1000);
    const intent = intentRevision.current;
    const generation = session.unread.generation();
    const valid = () => {
      const channel = session.channels
        .list()
        .channels.find((entry) => entry.id === item.channelId);
      return (
        active.current &&
        intentRevision.current === intent &&
        session.unread.generation() === generation &&
        !!channel &&
        !channel.cached &&
        !!channel.members?.includes(scope.viewer) &&
        session.unread
          .inbox()
          .items.some(
            (current) =>
              current.channelId === item.channelId &&
              current.messageIds.includes(item.messageId),
          )
      );
    };
    let advanced: InboxItem | undefined;
    void run(
      async () => {
        // Retry retains the cutoff, but navigation follows the currently rendered view.
        const current = archiveView.current;
        const leaves =
          current.show === "inbox"
            ? value
            : current.show === "archived" && !value;
        const index = current.visible.findIndex(
          (row) =>
            row.channelId === item.channelId &&
            (row.id === item.id || row.messageIds.includes(item.messageId)),
        );
        const next =
          leaves && index >= 0
            ? (current.visible[index + 1] ?? current.visible[index - 1])
            : undefined;
        updateArchive(archiveScope, conversation, value, at);
        setMenu(undefined);
        if (!leaves) return;
        const channelOf = (row: InboxItem) =>
          session.channels
            .list()
            .channels.find((entry) => entry.id === row.channelId);
        // Archiving the open conversation closes its tab and opens the next;
        // restoring it keeps its tab.
        if (
          value &&
          current.selected?.channelId === item.channelId &&
          current.selected.messageIds.includes(item.messageId) &&
          current.opened &&
          closeTab(current.opened)
        ) {
          if (next && openRow(next, channelOf(next))) {
            advanced = next;
            setSelectedTarget(targetOf(next));
            return;
          }
          setSelectedTarget(undefined);
        }
        focusRow.current = next?.id ?? "";
      },
      valid,
      () => {
        if (advanced && hasUnread(advanced) && canRead) mutate(advanced, false);
      },
    );
  }
  function mutate(item: InboxItem, unread: boolean) {
    // An open menu is not authority: recheck the current session at action entry.
    if (
      !active.current ||
      busy.current ||
      session.unread.sync().capability !== "frontier-sync"
    )
      return;
    // Capture the admitted row and access evidence. Retry is explicit and cannot
    // reuse the intent after retargeting, access changes, or newer read/activity intent.
    const intent = ++intentRevision.current;
    const channel = session.channels
      .list()
      .channels.find((entry) => entry.id === item.channelId);
    const generation = session.unread.generation();
    const membership = channel?.members
      ? [...channel.members].sort().join(":")
      : undefined;
    let revision = session.unread.revision();
    const remaining = [...item.readThrough];
    const valid = () => {
      const current = session.channels
        .list()
        .channels.find((entry) => entry.id === item.channelId);
      return (
        active.current &&
        intentRevision.current === intent &&
        session.unread.sync().capability === "frontier-sync" &&
        !!channel &&
        !!current &&
        !current.cached &&
        (!current.readOnly || current.viewerRole === "guest") &&
        !current.archived &&
        current.channelType === channel.channelType &&
        !!current.members?.includes(scope.viewer) &&
        [...current.members].sort().join(":") === membership &&
        session.unread.generation() === generation &&
        session.unread
          .inbox()
          .items.some(
            (row) =>
              row.channelId === item.channelId &&
              row.messageIds.includes(item.messageId),
          ) &&
        session.unread.revision() === revision
      );
    };
    // Prepare once per click, not once per Retry: later arrivals are a new intent.
    let readChannel: (() => Promise<unknown>) | undefined;
    const work = async () => {
      if (unread) await session.unread.markUnreadLocal(item.target);
      else if (item.target.kind === "channel") {
        readChannel ??= session.unread.prepareChannelRead(item.channelId);
        await readChannel();
      } else
        while (remaining.length) {
          // Close/Escape retires undispatched steps, not the admitted save.
          // Its genuine storage/access rejection still propagates through run.
          if (intentRevision.current !== intent) return;
          if (!valid())
            throw new Error(
              "Inbox action expired. Close and reopen the conversation.",
            );
          const step = remaining[0];
          if (!step) break;
          await session.unread.markThrough(step.target, step.messageId);
          remaining.shift();
          revision = session.unread.revision();
        }
    };
    void run(work, valid);
  }
  function retry() {
    // Keep source errors mounted too while their refresh clears live evidence.
    setError(failure);
    const mutation = failedMutation.current;
    if (mutation) {
      void run(mutation.work, mutation.valid, mutation.onSuccess);
      return;
    }
    refresh(true);
  }
  const canRead = sync.capability === "frontier-sync";
  // The Archive shortcut acts on the conversation opened last.
  useLayoutEffect(() => {
    if (!archiveShortcut || !selected || pending || drafts) return;
    const current = () => archive(selected, !archived(selected));
    archiveShortcut.current = current;
    return () => {
      if (archiveShortcut.current === current)
        archiveShortcut.current = undefined;
    };
  });
  const loading =
    list.status === "idle" ||
    list.status === "loading" ||
    inbox.status === "loading" ||
    feed.status === "loading";
  const failure =
    error ?? list.error ?? inbox.error ?? feed.error ?? sync.error;
  useLayoutEffect(() => {
    if (!retryFocus.current) return;
    retryFocus.current = false;
    if (failure || pending || document.activeElement !== document.body) return;
    fallbackControl.current?.focus({ preventScroll: true });
  }, [failure, pending]);
  function showView(value: ShowFilter) {
    if (value === show) return;
    cancelRetry();
    setSelectedTarget(undefined);
    setFilter({ show: value });
  }
  const filtered =
    activity !== "all" || senderFilter !== "everyone" || unreadOnly;
  const toolbar = (
    <header className={styles.toolbar}>
      <InboxFilters
        view={drafts ? "drafts" : activity}
        show={show}
        onShowChange={showView}
        sender={senderFilter}
        unreadOnly={unreadOnly}
        triggerRef={fallbackControl}
        onViewChange={(view) => {
          if (drafts !== (view === "drafts")) {
            cancelRetry();
            viewFocus.current = true;
          }
          setDrafts(view === "drafts");
          if (view !== "drafts") setFilter({ activity: view });
        }}
        onSenderChange={(sender) => setFilter({ sender })}
        onUnreadChange={(checked) =>
          setFilter({ attention: checked ? "unread" : "all" })
        }
      />
      {!drafts && (
        <div className={styles.headerTitle}>
          {loading && (
            <span
              className={`${styles.refreshStatus} text-caption text-subtle`}
              role="status"
            >
              Checking recent activity…
            </span>
          )}
        </div>
      )}
    </header>
  );
  return (
    <div
      ref={split.ref}
      style={split.style}
      data-buzz-ui=""
      className={styles.page}
    >
      {!drafts && failure && (
        <div className={styles.notice} role="alert">
          <p className="text-body">{failure}</p>
          <Button ref={retryButton} size="sm" loading={pending} onClick={retry}>
            Retry inbox
          </Button>
        </div>
      )}
      {drafts ? (
        <DraftsView
          toolbar={toolbar}
          resizeHandle={split.handle}
          onEmptyRetire={() => fallbackControl.current?.focus()}
          session={session}
          scope={scope}
          navigator={navigator}
          extensions={extensions}
          host={host}
        />
      ) : (
        <div ref={workspace} className={styles.workspace}>
          <div className={styles.listPane}>
            {toolbar}
            <div className={styles.scroll}>
              {inbox.freshness === "stale" && !failure && (
                <div className={styles.notice} role="status">
                  <span className="text-body text-subtle">
                    Showing retained activity.
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={pending}
                    onClick={() => refresh()}
                  >
                    Refresh
                  </Button>
                </div>
              )}
              {(inbox.status === "idle" || feed.status === "idle") &&
                !loading &&
                !failure && (
                  <div className={styles.notice} role="status">
                    <span className="text-body text-subtle">
                      Check recent activity.
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={pending}
                      onClick={() => refresh()}
                    >
                      Refresh
                    </Button>
                  </div>
                )}
              {!visible.length &&
                (inbox.status === "ready" || feed.status === "ready") &&
                !loading &&
                !failure && (
                  <div className={styles.empty} role="status">
                    <EmptyState
                      icon={
                        show === "archived" ? <ArchiveIcon /> : <BellIcon />
                      }
                      title={
                        show === "archived"
                          ? unreadOnly
                            ? "No archived conversations match Unread only"
                            : "No archived conversations in this view"
                          : unreadOnly
                            ? "No unread activity in this view"
                            : "No recent activity in this view"
                      }
                      description={
                        show === "archived"
                          ? activity === "mentions"
                            ? "Archived mentions stay here until you restore them or receive a new mention."
                            : "Archived conversations stay here until you restore them, receive a new participating-thread reply, or receive a new mention."
                          : "Mentions, direct messages, and replies in threads you participate in appear here."
                      }
                      action={
                        filtered || show === "archived" ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              // Status stays; an unfiltered archive returns to Inbox.
                              if (filtered)
                                setFilter({
                                  activity: "all",
                                  sender: "everyone",
                                  attention: "all",
                                });
                              else showView("inbox");
                              fallbackControl.current?.focus();
                            }}
                          >
                            {filtered ? "Clear filters" : "Show Inbox"}
                          </Button>
                        ) : undefined
                      }
                    />
                  </div>
                )}
              <ul
                className={styles.list}
                aria-label="Inbox conversations"
                aria-busy={pending}
              >
                {visible.map((item) => {
                  const channel = list.channels.find(
                    (candidate) => candidate.id === item.channelId,
                  );
                  const displayId = item.workflowOwnerId ?? item.authorId;
                  const profile = profiles.get(displayId);
                  const resolved = name(
                    displayId,
                    profile?.name ??
                      formatPublicKey(displayId) ??
                      "Unknown sender",
                    channel?.members,
                  );
                  const sender = item.workflowOwnerId
                    ? workflowLabel(resolved)
                    : resolved;
                  const dmName = dmLabel(
                    channel?.participants,
                    profiles,
                    name,
                    channel?.name ?? "Direct message",
                  );
                  const context =
                    channel?.channelType === "dm"
                      ? `DM · ${dmName}`
                      : channel
                        ? channelText(channel)
                        : "Conversation";
                  const unread = hasUnread(item);
                  const rowArchived = archived(item);
                  return (
                    <li
                      key={item.id}
                      data-inbox-row={item.id}
                      className={styles.row}
                      data-unread={unread || undefined}
                      data-selected={selectedId === item.id || undefined}
                    >
                      <ContextMenuRoot
                        open={menu?.id === item.id}
                        onOpenChange={(open) =>
                          setMenu(open ? { id: item.id } : undefined)
                        }
                      >
                        <ContextMenuTrigger
                          render={<div className={styles.rowSurface} />}
                          onKeyDown={(event) => {
                            if (
                              event.key === "ContextMenu" ||
                              (event.shiftKey && event.key === "F10")
                            ) {
                              event.preventDefault();
                              setMenu({
                                id: item.id,
                                anchor: event.target as HTMLElement,
                              });
                            }
                          }}
                        >
                          <NavigationItem
                            aria-label={`Open ${sender} in ${context}`}
                            aria-describedby={`${previewId}-${item.id}`}
                            disabled={pending}
                            selected={selectedId === item.id}
                            ref={
                              item.id === visible[0]?.id
                                ? fallbackRow
                                : undefined
                            }
                            icon={
                              <Avatar
                                size="default"
                                alt=""
                                fallback={sender}
                                fallbackContent={
                                  item.workflowOwnerId ? (
                                    <LightningIcon size={20} />
                                  ) : undefined
                                }
                                src={
                                  item.workflowOwnerId
                                    ? undefined
                                    : avatarMedia(
                                        profile?.picture,
                                        session.media,
                                      )
                                }
                                shape={
                                  item.workflowOwnerId || profile?.isAgent
                                    ? "squircle"
                                    : "circle"
                                }
                              />
                            }
                            label={
                              <span className={styles.content}>
                                <span className={styles.heading}>
                                  <span className={styles.identity}>
                                    <strong
                                      className={`text-label-sm text-standard ${styles.sender}`}
                                    >
                                      {sender}
                                    </strong>
                                    <span
                                      className={`text-caption ${styles.source}`}
                                      data-inbox-source=""
                                    >
                                      {context}
                                    </span>
                                  </span>
                                  <time
                                    className={`text-caption text-subtle ${styles.rowDate}`}
                                    dateTime={new Date(
                                      item.createdAt * 1000,
                                    ).toISOString()}
                                  >
                                    {relativeTimestamp(item.createdAt)}
                                  </time>
                                </span>
                                <span
                                  id={`${previewId}-${item.id}`}
                                  className={`text-body ${unread ? "text-standard" : "text-subtle"} ${styles.preview}`}
                                >
                                  {[
                                    item.previewMessageId,
                                    ...item.messageIds,
                                  ].some(
                                    (id) =>
                                      id !== undefined &&
                                      feed.incomplete.includes(id),
                                  )
                                    ? feed.status === "error"
                                      ? "Preview unavailable. Retry inbox."
                                      : "Preview updating…"
                                    : messagePreview(item.preview)}
                                </span>
                              </span>
                            }
                            trailing={
                              unread ? (
                                <span
                                  className={styles.unreadSlot}
                                  role="img"
                                  aria-label="Unread"
                                >
                                  <span className={styles.unreadDot} />
                                </span>
                              ) : (
                                <span
                                  className={styles.unreadSlot}
                                  aria-hidden="true"
                                />
                              )
                            }
                            onClick={() => {
                              if (busy.current) return;
                              // The selected row reveals its current message in
                              // its captured tab, even after regrouping would
                              // open a whole conversation as a thread.
                              const reselect =
                                selectedId === item.id &&
                                opened &&
                                !opened.threadId !==
                                  !tabTarget(item, channel).threadId
                                  ? opened
                                  : undefined;
                              if (
                                reselect
                                  ? !openTab(reselect)
                                  : !openRow(item, channel)
                              )
                                void navigator.open({
                                  version: 1,
                                  kind: "conversation",
                                  scope,
                                  channelId: item.channelId,
                                  messageId: item.messageId,
                                  ...(item.rootId && {
                                    threadRootId: item.rootId,
                                  }),
                                });
                              // The selected row is the same visit, even when its
                              // current representative changed after reading.
                              if (selectedId === item.id) return;
                              cancelRetry();
                              setSelectedTarget(targetOf(item));
                              if (unread && canRead) mutate(item, false);
                            }}
                          />
                          <span className={styles.rowArchive}>
                            <IconButton
                              size="sm"
                              variant="ghost"
                              disabled={pending}
                              aria-label={`${rowArchived ? "Restore" : "Archive"} ${sender} in ${context}`}
                              title={rowArchived ? "Restore" : "Archive"}
                              onClick={() => archive(item, !rowArchived)}
                              icon={
                                rowArchived ? (
                                  <ArchiveOffIcon
                                    size={16}
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <ArchiveIcon size={16} aria-hidden="true" />
                                )
                              }
                            />
                          </span>
                        </ContextMenuTrigger>
                        <MenuPopup
                          size="compact"
                          aria-label={`Actions for ${sender} in ${context}`}
                          anchor={
                            menu?.id === item.id ? menu.anchor : undefined
                          }
                        >
                          <MenuItem
                            disabled={pending}
                            onClick={() => archive(item, !rowArchived)}
                          >
                            {rowArchived
                              ? "Restore conversation"
                              : "Archive conversation"}
                          </MenuItem>
                          <MenuItem
                            disabled={pending || unread || !canRead}
                            onClick={() => mutate(item, true)}
                          >
                            Mark unread
                          </MenuItem>
                        </MenuPopup>
                      </ContextMenuRoot>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
