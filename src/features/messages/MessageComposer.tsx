import {
  soloModelPicksKey,
  parseSoloModelPicks,
  updateSoloModelPicks,
} from "./solo-model-picks";
import { useChatLinkSharing } from "./useChatLinkSharing";
import {
  draftGif,
  useGifDraftPreview,
} from "../../bundled/emoji/GifDraftPreview";
import { accentButtonStyle } from "../../shared/theme/accent";
import { stageChatCards } from "./composer-chat-cards";
import { chatCardIds } from "./chat-cards";
import { ComposerChatCards } from "./ComposerChatCards";
import { useConversationPresentation } from "../conversation/ConversationPresentation";
import { TypingPresentation } from "../conversation/typing-presentation";
import { useTypingBroadcast } from "./useTypingBroadcast";
import { TypingIndicator } from "./TypingIndicator";
import { useEffectEvent } from "react";
import { useMessageEditScope } from "./MessageEditScope";
import { selectNewestMessage } from "./message-selection";
import { useMessageDeletion } from "./MessageManagement";
import { animate, useReducedMotion } from "motion/react";
import {
  ToastNotice,
  useToastNotification,
} from "../../shared/design-system/ui/Toast";
import { writeClipboardText } from "../../shared/clipboard";
import { SelectedMentionContext } from "./selected-mention-context";
import { DraftMentionRoster } from "./draft-mention-roster";
import {
  allowsOutsideMentions,
  archivedMention,
  mentionAdmission,
  pastedMentionRecipient,
} from "./mention-admission";
import { rememberMention } from "./mention-history";
import {
  readComposerSnapshot,
  composerMarkdownContext,
  markdownRanges,
} from "./composer-document";
import { useMessageEdit, lastEditableMessage } from "./useMessageEdit";
import { editMentionText } from "./message-edit";
import type { ChannelMessage } from "../relay/contracts";
import { useListedChannel } from "../relay/listed-channel";
import { FileDropOverlay } from "./FileDropOverlay";
import { useFileDrop } from "./use-file-drop";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { useBringAgents } from "./useBringAgents";
import { useNonmemberMentions } from "./useNonmemberMentions";
import { useOldAgentMentions } from "./useOldAgentMentions";
import { useKnownAgentPubkeys } from "../agents/use-known";
import { knownAgentPubkeys } from "../agents/known";
import {
  latestOwnMessage,
  rememberedMentions,
  seedAgents,
  seedEvidenceSettled,
  seedMentions,
} from "./remembered-mentions";
import { rememberAgentsPreference } from "./mention-preferences";
import { useChosenAgent } from "../solo/default-agent";
import { useAgentChoices } from "../agents/use-choices";
import {
  soloAgentsOnly,
  soloHasPeople,
  soloRoster,
  useSoloMembers,
} from "../solo/people";
import {
  ArrowUpIcon,
  PaperclipIcon,
  PencilSimpleIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import { useVoiceCapture } from "./useVoiceCapture";
import { ComposerAttachments } from "./ComposerAttachments";
import {
  attachmentDraft,
  useAttachmentDraft,
  type AttachmentDraft,
} from "./attachment-draft";
import {
  sendInBackground,
  useBackgroundSendPending,
} from "./background-upload";
import { BackgroundUploadStatus } from "./BackgroundUploadStatus";
import type { UploadedAttachment } from "../relay/attachments";
import {
  useContext,
  useEffect,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { fullSession, type ComposerSession } from "./composer-session";
import type { RelaySession } from "../relay/session";
import {
  readView,
  writeView,
  viewRevision,
  replaceView,
  subscribeView,
} from "../../shared/view-state";
import styles from "./Messages.module.css";
import { messageViewKey } from "./view-key";
import { isEmojiOnly, usesLargeEmojiPresentation } from "./emoji-size";
import {
  legacyFollowupDraft,
  MAX_DRAFT_GIFS,
  mentionBoundary,
  mentionDraft,
  stageableGif,
  type MentionDraft,
  type MentionRecipient,
} from "./mention-draft";
import { normalizeName } from "../search/person-match";
import { ComposerAccessories } from "../conversation/ComposerAccessories";
import { ComposerTools } from "../conversation/ComposerTools";
import { ComposerLinkDialog } from "./ComposerLinkDialog";
import { ComposerFormattingTools } from "./ComposerFormattingTools";
import { AgentsContext, useSessionState } from "../agents/react";
import { ComposerModels, type DraftPicks } from "./ComposerModels";
import type { MentionPicks } from "../relay/messages";
import type {
  ConversationExtensions,
  CompletionEdit,
  CompletionPending,
  CompletionQuery,
  CompletionResolution,
  ComposerObservation,
  ComposerResource,
} from "../conversation/contracts";
import { ComposerCompletions } from "../conversation/ComposerCompletions";
import { MENTION_RESOLVE_TIMEOUT_MS } from "../conversation/completion";
import { useCompletionEditor } from "../conversation/useCompletionEditor";
import { formatMediaTime, mediaTimeReply } from "./media-timecode";
import { RichComposerInput } from "./RichComposerInput";
import type { MessageLinkOrigin } from "./MessageRow";
import { composerMarkdown } from "./composer-markdown";
import type {
  ComposerInputElement,
  ComposerLinkEdit,
  ComposerFormat,
} from "./composer-dom";
import { TargetOpenerProvider } from "../conversation/opener";
import { avatarMedia } from "../../shared/avatar-source";
import { followUpBehaviorPreference } from "./follow-up-preference";
import { followUpQueue } from "./follow-up-queue";
import { followUpMessage } from "./follow-up-message";
import { QueuedFollowUps } from "./QueuedFollowUps";

const noChannels: ReturnType<ComposerSession["channels"]["list"]> = {
  status: "idle",
  channels: [],
};
const noSubscription = () => () => {};

type AcceptedDraft = {
  next: MentionDraft;
  revision: string | null | undefined;
};
// Failed post-acceptance cleanup survives composer remounts within this session.
// This is recovery evidence only, not another persistent draft inventory.
const acceptedDrafts = new WeakMap<
  ComposerSession,
  Map<string, AcceptedDraft>
>();
type RecoveredSend = {
  draft: MentionDraft;
  picks?: DraftPicks;
  preparationError?: unknown;
};
const recoveryListeners = new WeakMap<
  ComposerSession,
  Map<string, Set<(recovered: RecoveredSend) => void>>
>();
// A recovery that no mounted composer consumed replays on remount. Only the
// unpersisted parts need it: the pick snapshot and a preparation failure. The
// saved draft and attachment store remain the owners of the recovered content.
const missedRecovery = new WeakMap<
  ComposerSession,
  Map<string, RecoveredSend>
>();
function takeMissedRecovery(session: ComposerSession, key: string) {
  const byKey = missedRecovery.get(session);
  const recovered = byKey?.get(key);
  byKey?.delete(key);
  return recovered;
}
function notifyRecovered(
  session: ComposerSession,
  key: string,
  recovered: RecoveredSend,
) {
  let byKey = missedRecovery.get(session);
  if (!byKey) {
    byKey = new Map();
    missedRecovery.set(session, byKey);
  }
  byKey.set(key, recovered);
  for (const listener of recoveryListeners.get(session)?.get(key) ?? [])
    listener(recovered);
}
function errorForRecovery(reason: unknown) {
  return reason instanceof Error
    ? reason.message
    : reason !== undefined
      ? String(reason)
      : undefined;
}
/** What `MentionRecipient` promises, checked where one arrives from a
 * contribution: a 64-hex pubkey and a non-empty name. */
function wellFormedRecipient(
  recipient: unknown,
): recipient is MentionRecipient {
  if (typeof recipient !== "object" || recipient === null) return false;
  const { pubkey, name } = recipient as { pubkey?: unknown; name?: unknown };
  return (
    typeof pubkey === "string" &&
    /^[0-9a-f]{64}$/.test(pubkey) &&
    typeof name === "string" &&
    !!name.trim()
  );
}
/** Why a pending mention returned to prose, as the send it held tells it. */
const pendingRefusals = {
  unresolved: "could not be confirmed as one person or agent",
  unavailable: "could not be tagged here",
  limit: "could not be tagged: a message can tag at most 32 recipients",
  length: "could not be tagged: the message would be too long",
} as const;
type PendingRefusal = { name: string; reason: keyof typeof pendingRefusals };
function subscribeRecovery(
  session: ComposerSession,
  key: string,
  listener: (recovered: RecoveredSend) => void,
) {
  let byKey = recoveryListeners.get(session);
  if (!byKey) {
    byKey = new Map();
    recoveryListeners.set(session, byKey);
  }
  let listeners = byKey.get(key);
  if (!listeners) {
    listeners = new Set();
    byKey.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) byKey.delete(key);
  };
}
function recoveryFor(session: ComposerSession) {
  let recovery = acceptedDrafts.get(session);
  if (!recovery) {
    recovery = new Map();
    acceptedDrafts.set(session, recovery);
  }
  return recovery;
}

export type MessageComposerProps = {
  extensions?: ConversationExtensions | undefined;
  scope: string;
  session: ComposerSession | RelaySession;
  channelId: string;
  channelName: string;
  label?: string | undefined;
  placeholder?: string | undefined;
  soloConversation?: boolean | undefined;
  ownSoloConversation?: boolean | undefined;
  /** Seeds an empty new-chat draft; follow-ups use remembered mentions. */
  defaultMention?: MentionRecipient | undefined;
  /** Whether a retained tab shows this composer, apart from its read policy.
   * A composer shown again may reseed its remembered agents (see seedMentions). */
  shown?: boolean | undefined;
  /** Sending needs at least one tagged recipient. */
  requireMention?: boolean | undefined;
  chatPresentation?: boolean | undefined;
  trailingTool?: ReactNode;
  inviteAgents?: boolean | undefined;
  onSend?: (id: string) => void;
  /** Inbox may retire only after saving the replacement or confirming no draft remains. */
  onDraftSaved?: (() => void) | undefined;
  /** Before a focused form detaches, its host can hand focus to retained content. */
  onFocusedRemoval?: (() => void) | undefined;
  /** Threads supply their own retained rows; channels use the shared window. */
  editMessages?: readonly ChannelMessage[] | undefined;
  onOpenLink?:
    | ((target: string, origin?: MessageLinkOrigin) => boolean)
    | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
  threadRootId?: string;
  /** The viewer's latest message in this thread, once the thread has loaded.
   * An empty thread composer starts with the agents it notified (see
   * seedMentions); other composers read their own channel window. */
  threadSeed?: Pick<ChannelMessage, "id" | "mentions"> | undefined;
  replyParentId?: string | undefined;
  replyContext?: ReactNode;
  mediaTimeSeconds?: number;
  clearMediaTime?(): void;
  /** Focus once on entry; an owner can cancel its target before a delayed mount. */
  autoFocus?: boolean | RefObject<HTMLElement | null>;
  focusRequest?: number;
  hideMediaTimeIndicator?: boolean;
  disabled?: boolean;
  /** A new conversation owns persistence and delivery before a channel exists. */
  submission?: {
    draftKey: string;
    initialDraft?: MentionDraft | string | undefined;
    /** A durable operation overrides disposable view state during recovery. */
    recoveredDraft?: MentionDraft | undefined;
    locked: boolean;
    disabled: boolean;
    /** Files upload before the conversation exists; submit sends them. */
    attachments?: boolean;
    /** DMs can start with files alone; named Solo chats still require text. */
    allowAttachmentOnly?: boolean;
    /** New Solo chats keep their picks on the stable draft until creation. */
    modelPicksKey?: string;
    /** Told after each save whether the editor holds a draft it could not
     * save, which view state then misses. */
    unsaved?: ((held: boolean) => void) | undefined;
    /** `addressed`: the toolbar's agents, when they are held apart from the text. */
    submit: (
      draft: MentionDraft,
      attachments: AttachmentDraft,
      addressed?: readonly MentionRecipient[],
      picks?: MentionPicks,
      draftPicks?: DraftPicks,
      draftPicksRevision?: string | null,
    ) => void;
  };
};

/** Safe to retarget through ordinary props; callers do not own internal remount keys. */
export function MessageComposer(props: MessageComposerProps) {
  const key = `${props.submission?.draftKey ?? ""}:${messageViewKey(
    props.session,
    props.scope,
    props.channelId,
    props.threadRootId,
  )}`;
  return (
    <TypingPresentation active key={key}>
      <TargetOpenerProvider canOpen={props.canOpenLink} open={props.onOpenLink}>
        {props.ownSoloConversation ? (
          <PersonalComposer {...props} />
        ) : (
          <Composer {...props} />
        )}
      </TargetOpenerProvider>
    </TypingPresentation>
  );
}

function PersonalComposer(props: MessageComposerProps) {
  const { session, channelId, submission } = props;
  const choices = useAgentChoices(session, true, true);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const members = useListedChannel(
    session.channels,
    channelId,
    (channel) => channel?.members,
  );
  // A saved chat keeps its people; agents are only the owner's available ones.
  const roster = useMemo(
    () =>
      submission
        ? choices.selectable
        : soloRoster(
            members,
            session.viewer,
            profiles,
            agentPubkeys,
            choices.selectable,
          ),
    [
      submission,
      choices.selectable,
      members,
      agentPubkeys,
      profiles,
      session.viewer,
    ],
  );
  // The agents still loading may include the name a Space was typed for. That
  // pending mention resolves against the first roster committed once they
  // settle. Each loading period has its own promise: a Retry after a failed
  // read must not hand out the one the failure settled with an empty roster.
  const loading = choices.pending && choices.status !== "ready";
  const settling = useRef<{
    promise: Promise<readonly MentionRecipient[]>;
    resolve: (roster: readonly MentionRecipient[]) => void;
  }>(undefined);
  if (loading && !settling.current) {
    let resolve!: (roster: readonly MentionRecipient[]) => void;
    const promise = new Promise<readonly MentionRecipient[]>((done) => {
      resolve = done;
    });
    settling.current = { promise, resolve };
  }
  const pending = loading ? settling.current?.promise : undefined;
  useLayoutEffect(() => {
    if (loading || !settling.current) return;
    settling.current.resolve(roster);
    settling.current = undefined;
  }, [loading, roster]);
  const value = useMemo(
    () => ({ recipients: roster, ...(pending ? { pending } : {}) }),
    [roster, pending],
  );

  return (
    <DraftMentionRoster.Provider value={value}>
      <Composer {...props} />
      {choices.error && (
        <p role="alert">
          {choices.error}{" "}
          <Button onClick={() => void props.session.agentChoices.refresh()}>
            Retry agents
          </Button>
        </p>
      )}
    </DraftMentionRoster.Provider>
  );
}

function routedKey(agents: readonly MentionRecipient[]) {
  return agents.map((agent) => agent.pubkey).join(",");
}

/** No text, mention, chat card or GIF: nothing the user has put in yet. */
function untouchedDraft(draft: MentionDraft) {
  return (
    !draft.text &&
    !draft.recipients.length &&
    !draft.chatCards?.length &&
    !draft.gifs?.length
  );
}

function sameAttachmentSelection(
  left: readonly { id: string }[],
  right: readonly { id: string }[],
) {
  return (
    left.length === right.length &&
    left.every((item, index) => item.id === right[index]?.id)
  );
}

function Composer({
  session,
  extensions,
  scope,
  channelId,
  channelName,
  label: customLabel,
  placeholder,
  onSend,
  onDraftSaved,
  onFocusedRemoval,
  editMessages,
  onOpenLink,
  canOpenLink,
  threadRootId,
  threadSeed,
  replyParentId,
  replyContext,
  mediaTimeSeconds,
  clearMediaTime,
  autoFocus = false,
  focusRequest,
  hideMediaTimeIndicator = false,
  disabled: requestedDisabled = false,
  submission,
  soloConversation,
  ownSoloConversation = false,
  defaultMention,
  shown = true,
  requireMention = false,
  chatPresentation = false,
  inviteAgents = false,
  trailingTool,
}: MessageComposerProps) {
  const active = useConversationPresentation();
  // Previews replace the list on every message; subscribe to this channel's facts.
  const listed =
    session.channels?.get || soloConversation ? session.channels : undefined;
  const channels = () => (listed?.list() ?? noChannels).channels;
  const writable = useListedChannel(
    listed,
    channelId,
    (channel) => !!channel && !channel.readOnly && !channel.archived,
  );
  const readOnly = !submission && !!session.channels?.get && !writable;
  const cached = useListedChannel(
    listed,
    channelId,
    (channel) => !!channel?.cached,
  );
  const disabled = requestedDisabled || readOnly;
  const [sending, setSending] = useState(false);
  const sendAttempt = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => sendAttempt.current?.abort(), []);
  useLayoutEffect(() => {
    if (disabled || !active) sendAttempt.current?.abort();
  }, [disabled, active]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retargeting invalidates an in-flight send, not the root-keyed draft.
  useLayoutEffect(() => () => sendAttempt.current?.abort(), [replyParentId]);
  const inputId = useId();
  const draftKey =
    submission?.draftKey ??
    (threadRootId
      ? `draft:${channelId}:thread:${threadRootId}`
      : `draft:${channelId}`);
  const [admitting, setAdmitting] = useState(false);
  const admission = useRef(false);
  const live = useRef(true);
  const permitted = useRef(!disabled);
  permitted.current = !disabled && active;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const mentionRoster = useContext(DraftMentionRoster)?.recipients;
  // A pending mention settles after later renders; admit it against the roster then.
  const currentRoster = useRef(mentionRoster);
  currentRoster.current = mentionRoster;
  const solo = !!soloConversation || ownSoloConversation;
  // Only a saved Solo chat subscribes; other composers never read this.
  const { withPeople, agentsOnly } = useSoloMembers(
    session,
    channelId,
    solo && !submission,
  );
  const channelType = useListedChannel(
    listed,
    channelId,
    (channel) => channel?.channelType,
  );
  const dmMembers = useListedChannel(listed, channelId, (channel) =>
    channel?.channelType === "dm" ? channel.members : undefined,
  );
  // A DM or Solo chat is one conversation; elsewhere a top-level message
  // starts a thread of its own.
  const startsThread =
    !threadRootId && !solo && channelType !== "dm" && channelType !== "solo";
  const host = fullSession(session);
  const agentChoices = inviteAgents || solo;
  const recoveryKey = `${scope}:${draftKey}`;
  const sendPending = useBackgroundSendPending(session, recoveryKey);
  const [accepted, setAccepted] = useState(() => {
    if (submission) return;
    const recovery = recoveryFor(session);
    const pending = recovery.get(recoveryKey);
    const current = viewRevision(scope, draftKey);
    if (pending && current !== undefined && current !== pending.revision) {
      recovery.delete(recoveryKey); // Deleted or replaced while unmounted.
      return;
    }
    return pending;
  });
  const revision = useRef(viewRevision(scope, draftKey));
  // Whether this mount seeded the shortcut's initial text, rather than
  // restoring a saved draft that may already have had its tag removed.
  const [seededKey] = useState(() =>
    !accepted?.next &&
    !submission?.recoveredDraft &&
    (revision.current === null || revision.current === "null")
      ? draftKey
      : undefined,
  );
  const dirty = useRef(false);
  const writing = useRef(false);
  const [conflict, setConflict] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  // A composer with nothing saved starts with the agents the viewer's latest
  // message in its conversation notified, in memory only: a draft is saved
  // once the user types, removes a mention or sends here, and relay history,
  // not that draft, is what every device seeds from. ThreadPanel supplies a
  // thread's message; the other composers read their channel window. The
  // seed is this mount's initial draft, not an editor reset: a StrictMode
  // remount between effects would undo one.
  const seedsFromWindow = !submission && !threadRootId && !defaultMention;
  const windowSeed = () => {
    const window = session.channels.window?.(channelId);
    return window?.status === "ready" && session.viewer
      ? latestOwnMessage(session.viewer, window.rows)
      : undefined;
  };
  const seedKey = (source: Pick<ChannelMessage, "id">) =>
    `${draftKey}\n${source.id}`;
  const [initial] = useState(() => {
    const stored = mentionDraft(
      accepted?.next ??
        submission?.recoveredDraft ??
        readView<unknown>(scope, draftKey, submission?.initialDraft ?? ""),
    );
    // A follow-up an earlier release saved is this composer's prefill, not
    // the user's draft: history seeds it now, and the first save replaces it.
    const saved = stageChatCards(
      legacyFollowupDraft(stored) ? mentionDraft("") : stored,
      channels(),
    );
    // An own Solo chat alone with agents seeds its toolbar, not the text.
    const source =
      threadSeed ??
      (seedsFromWindow && !(ownSoloConversation && agentsOnly && !withPeople)
        ? windowSeed()
        : undefined);
    if (!source || submission || !untouchedDraft(saved))
      return { value: saved, applied: undefined, automatic: false };
    // A seed from settled evidence is final; one taken while agent evidence
    // is partial stays provisional, replaced as names resolve (see the seed
    // effect below).
    const applied = seedEvidenceSettled(session, source)
      ? seedKey(source)
      : undefined;
    const seed = seedMentions(session, source);
    return seed.recipients.length
      ? { value: seed, applied, automatic: true }
      : { value: saved, applied, automatic: false };
  });
  const [value, updateDraft] = useState(initial.value);
  // The seed applied, or settled by the user's edit, for this draft key and
  // message, and whether content the user put in has closed seeding, each
  // until the composer is shown again.
  const seedApplied = useRef<string | undefined>(initial.applied);
  const seedClosed = useRef(false);
  // The draft as this composer last prefilled it; the user's edits clear it.
  const automaticTag = useRef<string | undefined>(
    initial.automatic ? JSON.stringify(initial.value) : undefined,
  );
  const chatCards = value.chatCards;
  const gifs = value.gifs;
  const editorDraft = useMemo(() => {
    if (!value.chatCards && !value.gifs) return value;
    const { chatCards: _cards, gifs: _gifs, ...caption } = value;
    return caption;
  }, [value]);
  const draft = value.text;
  const recipientKey = JSON.stringify(
    value.recipients.map(({ pubkey, name }) => ({ pubkey, name })),
  );
  const recipients = useMemo(
    () => JSON.parse(recipientKey) as readonly MentionRecipient[],
    [recipientKey],
  );
  const valueRef = useRef(value);
  // Only a composer holding nothing but its own prefill reads its window, so
  // typing never rescans the history and the always-mounted composers
  // subscribe only while they could seed. Nothing is loaded here: the host
  // owns the window.
  const presented = active && shown;
  const seeking =
    seedsFromWindow &&
    presented &&
    ((!value.recipients.length && !value.text.trim()) ||
      automaticTag.current === JSON.stringify(value));
  const subscribeRows = useCallback(
    (listener: () => void) =>
      seeking
        ? (session.channels.subscribeWindow?.(channelId, listener) ??
          noSubscription())
        : noSubscription(),
    [seeking, session.channels, channelId],
  );
  const windowSource = useSyncExternalStore(subscribeRows, () =>
    seeking ? windowSeed() : undefined,
  );
  const seedSource = threadSeed ?? windowSource;
  // Agent evidence (profiles, the inventory) re-runs the seed effect below
  // while a seed is pending, so no composer re-renders per profile batch or
  // library transition once it has seeded or holds the user's content.
  const seedPending =
    !!seedSource &&
    !seedClosed.current &&
    seedApplied.current !== seedKey(seedSource);
  useSyncExternalStore(
    seedPending ? session.profiles.subscribe : noSubscription,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  useSyncExternalStore(
    seedPending ? session.agentChoices.subscribe : noSubscription,
    session.agentChoices.snapshot,
    session.agentChoices.snapshot,
  );
  // A Solo chat keeps its explicit model/effort picks across turns and mounts.
  const stickyPicks = !!ownSoloConversation;
  const stickyPicksKey =
    submission?.modelPicksKey ?? soloModelPicksKey(channelId);
  const [picksSnapshot, setPicksSnapshot] = useState(() => {
    const revision = viewRevision(scope, stickyPicksKey);
    return {
      picks: stickyPicks ? parseSoloModelPicks(revision) : {},
      revision,
    };
  });
  const [pickReadFailed, setPickReadFailed] = useState(
    stickyPicks && picksSnapshot.revision === undefined,
  );
  const committedPicks = useRef(picksSnapshot);
  useLayoutEffect(() => {
    committedPicks.current = picksSnapshot;
  }, [picksSnapshot]);
  const { picks } = picksSnapshot;
  const picksRevision = useRef(picksSnapshot.revision);
  const setPicks = useCallback(
    (next: DraftPicks) =>
      setPicksSnapshot({ picks: next, revision: picksRevision.current }),
    [],
  );
  const unsavedDraft = useRef(false);
  const unsavedPicks = useRef(
    new Map<
      string,
      { pick: DraftPicks[string] | undefined; pending: boolean }
    >(),
  );
  const pendingPickSaves = useRef(0);
  const [pickStorageFailed, setPickStorageFailed] = useState(false);
  const refreshPicks = useCallback(() => {
    const revision = viewRevision(scope, stickyPicksKey);
    if (revision === undefined || revision === picksRevision.current) return;
    picksRevision.current = revision;
    const merged = { ...parseSoloModelPicks(revision) };
    for (const [pubkey, { pick }] of unsavedPicks.current) {
      if (pick) merged[pubkey] = pick;
      else delete merged[pubkey];
    }
    setPicks(merged);
    setPickReadFailed(false);
    setPickStorageFailed(
      [...unsavedPicks.current.values()].some((intent) => !intent.pending),
    );
  }, [scope, stickyPicksKey, setPicks]);
  useEffect(() => {
    if (!stickyPicks) return;
    return subscribeView(scope, refreshPicks);
  }, [scope, stickyPicks, refreshPicks]);
  const changePicks = (
    next: DraftPicks,
    resetPubkeys: readonly string[] = [],
  ) => {
    const before = picks;
    const changedKeys = new Set([...Object.keys(before), ...Object.keys(next)]);
    for (const pubkey of [...changedKeys])
      if (JSON.stringify(before[pubkey]) === JSON.stringify(next[pubkey]))
        changedKeys.delete(pubkey);
    for (const pubkey of resetPubkeys) changedKeys.add(pubkey);
    if (!stickyPicks) {
      setPicks(next);
      return;
    }
    // Each queued action owns only its mutations, plus previously failed edits.
    // Replaying another pending action here could undo a later cross-window edit.
    const edits = new Map(
      [...unsavedPicks.current].filter(([, intent]) => !intent.pending),
    );
    for (const pubkey of changedKeys) {
      const intent = { pick: next[pubkey], pending: true };
      unsavedPicks.current.set(pubkey, intent);
      edits.set(pubkey, intent);
    }
    for (const intent of edits.values()) intent.pending = true;
    setPicks(next);
    submission?.unsaved?.(true);
    pendingPickSaves.current++;
    void updateSoloModelPicks(
      scope,
      stickyPicksKey,
      new Map([...edits].map(([pubkey, { pick }]) => [pubkey, pick])),
    )
      .then((saved) => {
        for (const [pubkey, intent] of edits)
          if (unsavedPicks.current.get(pubkey) === intent)
            unsavedPicks.current.delete(pubkey);
        picksRevision.current = saved.revision;
        const merged = { ...saved.picks };
        for (const [pubkey, { pick }] of unsavedPicks.current) {
          if (pick) merged[pubkey] = pick;
          else delete merged[pubkey];
        }
        if (live.current) {
          setPicks(merged);
          setPickReadFailed(false);
        }
      })
      .catch(() => {
        for (const intent of edits.values()) intent.pending = false;
      })
      .finally(() => {
        pendingPickSaves.current--;
        if (live.current) {
          setPickStorageFailed(
            [...unsavedPicks.current.values()].some(
              (intent) => !intent.pending,
            ),
          );
          submission?.unsaved?.(
            unsavedDraft.current || unsavedPicks.current.size > 0,
          );
        }
      });
  };
  // Solo, alone with agents: the toolbar holds who hears the message when its
  // text mentions no one, and always keeps at least one agent.
  const [routed, setRouted] = useState<readonly MentionRecipient[]>([]);
  // A typed mention replaces the toolbar's remembered agents for this draft:
  // they are discarded, and the main agent stands in if the mentions go away.
  const [replacedKey, setReplacedKey] = useState<string>();
  const replaced = replacedKey === draftKey;
  const mentionCount = useRef(0);
  const resolvedPicks = useRef<
    | {
        source: typeof picksSnapshot;
        pubkeys: readonly string[];
        value: MentionPicks | null;
        error: string | undefined;
      }
    | undefined
  >(undefined);
  const agents = useContext(AgentsContext);
  /** Who a draft may address here now, the owner's agents from their other
   * communities included. */
  const admits = () =>
    mentionAdmission(
      session,
      channelId,
      agentChoices,
      currentRoster.current,
      new Set((agents?.joinable() ?? []).map((agent) => agent.pubkey)),
    );
  const sessionPlace = useMemo(
    () => ({
      channelId,
      ...(!solo &&
      channelType !== "dm" &&
      channelType !== "solo" &&
      threadRootId
        ? { root: threadRootId }
        : {}),
    }),
    [channelId, solo, channelType, threadRootId],
  );
  // A one-to-one DM wakes its other member without an explicit mention.
  // Include that session in both the rendered state and late send rechecks.
  const sessionTargets = (pubkeys: readonly string[]) =>
    dmMembers?.length === 2
      ? [
          ...new Set([
            ...pubkeys,
            ...dmMembers.filter((key) => key !== session.viewer),
          ]),
        ]
      : pubkeys;
  // Read at send time: inline mentions win, else the toolbar's agents.
  const sendRecipients = () =>
    routing && !valueRef.current.recipients.length
      ? routed
      : valueRef.current.recipients;
  const compactingNow = (
    recipients = sendRecipients().map((item) => item.pubkey),
  ) =>
    sessionTargets(recipients).some((pubkey) => {
      const key = agents?.find(pubkey)?.key;
      return !!key && agents?.sessionState(key, sessionPlace) === "compacting";
    });

  const caret = useRef<number | undefined>(undefined);
  const input = useRef<ComposerInputElement>(null);
  const hasFocused = useRef(false);
  const focusFromControl = useRef(
    typeof autoFocus === "object" ? autoFocus : undefined,
  );
  const focusOnMount = useRef(
    autoFocus && typeof document !== "undefined"
      ? typeof autoFocus === "boolean"
        ? document.activeElement
        : autoFocus.current
      : undefined,
  );
  useEffect(() => {
    // A navigation/dialog owner may restore focus during this commit. Let that
    // explicit handoff win over the conversation's default initial focus. A
    // loading conversation defers it until its composer is first enabled.
    // Focus moved while the composer waits also ends it, even if that control
    // later unmounts: restoring an archived channel must not pull focus back.
    const endOnFocusMove = () => {
      const moved = (event: FocusEvent) => {
        if (event.target !== focusOnMount.current)
          focusOnMount.current = undefined;
      };
      document.addEventListener("focusin", moved, true);
      return () => document.removeEventListener("focusin", moved, true);
    };
    if (disabled) {
      // Disabling after the handoff ends it; re-enabling must not refocus.
      if (focusOnMount.current === input.current)
        focusOnMount.current = undefined;
      if (!focusOnMount.current) return;
      return endOnFocusMove();
    }
    if (!focusOnMount.current) return;
    const focus = () => {
      const handoff = focusFromControl.current;
      if (handoff && !handoff.current) return;
      const previous = focusOnMount.current;
      // A responsive draft detail hides its opening row while the thread loads.
      // That browser blur may leave body focused; a later focusin still cancels.
      if (
        !previous ||
        (previous !== document.activeElement &&
          (document.activeElement !== document.body ||
            (previous.isConnected &&
              (!focusFromControl.current ||
                previous.getClientRects().length > 0))))
      )
        return;
      const editor = input.current;
      if (!editor || editor.closest("[inert]")) return;
      // A conversation can finish loading behind an already-focused dialog,
      // menu, or open popup trigger. Its default focus must not interrupt that
      // explicit owner: moving focus away also dismisses non-modal menus. A
      // hover preview is transient and owns no focus.
      const owner = document.activeElement?.closest(
        'dialog[open], [aria-modal="true"], [role="menu"], [data-popup-open]:not([data-popup-preview])',
      );
      if (owner && !owner.contains(editor)) return;
      const end = editor.value.length;
      // Let the visit's listener recognize its own successful focus handoff.
      if (handoff) handoff.current = editor;
      editor.focus();
      if (document.activeElement !== editor) return;
      editor.setSelectionRange(end, end);
      // Effect replay recreates the editor; retain this successful focus handoff.
      focusOnMount.current = editor;
    };
    const inertAncestor = input.current?.closest("[inert]");
    if (inertAncestor) {
      const stopWatching = endOnFocusMove();
      const observer = new MutationObserver(() => {
        if (!inertAncestor.hasAttribute("inert")) {
          observer.disconnect();
          stopWatching();
          focus();
        }
      });
      observer.observe(inertAncestor, {
        attributes: true,
        attributeFilter: ["inert"],
      });
      return () => {
        observer.disconnect();
        stopWatching();
      };
    }
    focus();
  }, [disabled]);
  const linkSharing = useChatLinkSharing(
    fullSession(session),
    channelId,
    () => {
      if (permitted.current) input.current?.focus();
    },
  );
  const bringing = useBringAgents(session, agents, channelId, () => {
    if (permitted.current) input.current?.focus();
  });
  const nonmembers = useNonmemberMentions(session, channelId, () => {
    if (permitted.current) input.current?.focus();
  });
  const oldAgents = useOldAgentMentions(agents, () => {
    if (permitted.current) input.current?.focus();
  });
  useEffect(() => {
    const editor = input.current;
    if (!focusRequest || !editor) return;
    // A new editor starts after its saved draft; a retained editor owns its caret.
    if (!hasFocused.current)
      editor.setSelectionRange(editor.value.length, editor.value.length);
    editor.focus();
  }, [focusRequest]);
  const restoreSelection = useRef<{ start: number; end: number } | undefined>(
    undefined,
  );
  const [linkEdit, setLinkEdit] = useState<ComposerLinkEdit | null>(null);
  if (!active && linkEdit) setLinkEdit(null);
  const [activeFormats, setActiveFormats] = useState<readonly ComposerFormat[]>(
    [],
  );
  const saveDraft = (next: MentionDraft, save = true) => {
    next = stageChatCards(
      {
        ...next,
        ...((next.chatCards ?? valueRef.current.chatCards)
          ? {
              chatCards: next.chatCards ?? valueRef.current.chatCards ?? [],
            }
          : {}),
        ...((next.gifs ?? valueRef.current.gifs)
          ? { gifs: next.gifs ?? valueRef.current.gifs ?? [] }
          : {}),
      },
      channels(),
    );
    if (JSON.stringify(next) === JSON.stringify(valueRef.current)) return false;
    valueRef.current = next;
    updateDraft(next);
    if (save && !editing.target) {
      if (submission) {
        const saved = writeView(scope, draftKey, next);
        unsavedDraft.current = !saved;
        submission.unsaved?.(
          unsavedDraft.current || unsavedPicks.current.size > 0,
        );
      } else {
        dirty.current = true;
        if (!conflict && !accepted) persist(next);
      }
    }
    return true;
  };
  function persist(next: MentionDraft, expected = revision.current) {
    writing.current = true;
    // A value already saved by another writer, as the Huddle owner saves the
    // stub after a companion send, is this save's outcome, not a conflict.
    const result =
      viewRevision(scope, draftKey) === JSON.stringify(next)
        ? "saved"
        : replaceView(scope, draftKey, expected, next);
    writing.current = false;
    if (result === "saved") revision.current = JSON.stringify(next);
    setConflict(result === "changed");
    setStorageFailed(result === "failed");
    return result;
  }
  const [error, setError] = useState<string>();
  const [pasteTooLong, setPasteTooLong] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string>();
  const focusRestoredDraft = useRef(false);
  const beforeEdit = useRef<
    { value: MentionDraft; restore(): void } | undefined
  >(undefined);
  const editing = useMessageEdit(session, () => {
    const saved = beforeEdit.current;
    if (!saved) return;
    valueRef.current = saved.value;
    updateDraft(saved.value);
    saved.restore();
    focusRestoredDraft.current = true;
    beforeEdit.current = undefined;
    setError(undefined);
    caret.current = undefined;
    setLinkEdit(null);
    completion.invalidate();
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: A changed draft or edit target retires feedback about the previous paste.
  useEffect(() => {
    setPasteTooLong(false);
  }, [draft, editing.target]);
  const editScope = useMessageEditScope();
  const editableRows = () =>
    editMessages ??
    editScope?.exactRows?.() ??
    (threadRootId
      ? []
      : (session.channels.window?.(channelId).rows ?? [])
    ).filter((row) => !row.threadRootId);
  // A member not yet known to be an agent (say, an unloaded profile) is a
  // person: routing stays off and mentions in the text decide.
  const routing = solo && !withPeople && agentsOnly && !editing.target;
  /** Who hears this message: inline mentions win; without any, the toolbar's
   * agents stand in. */
  const addressed = routing && !recipients.length ? routed : recipients;
  // The agents a send addresses: model, effort and session controls are
  // offered for each, so a one-to-one DM with an agent always has them.
  const addressedKeys = sessionTargets(addressed.map((item) => item.pubkey));
  const sessionState = useSessionState(agents, addressedKeys, sessionPlace);
  const compacting = sessionState === "compacting";
  // In a saved chat, the viewer's own pick outlives a remount until the next
  // send, which the chat's history then seeds from. A new chat always starts
  // from the main agent, unless a refused start gave its pick back (SoloDraft
  // saves that one) and the viewer has not picked since.
  const pillKey = `${draftKey}:agents`;
  const keepPick = (people: readonly MentionRecipient[] | null) => {
    writeView(scope, pillKey, !submission && people?.length ? people : null);
  };
  const choose = (people: readonly MentionRecipient[]) => {
    seededRoute.current = undefined;
    setReplacedKey(undefined);
    setRouted(people);
    keepPick(people);
  };
  const audience = routing
    ? {
        recipients: addressed,
        named: recipients.length > 0,
        only(people: readonly MentionRecipient[]) {
          if (!people.length) return;
          const team = people.map(({ pubkey, name }) => ({ pubkey, name }));
          // While tags in the text decide, a team replaces those tags, as a
          // pick edits them.
          if (!recipients.length) choose(team);
          else if (!replaceRecipients(team)) return;
          // Typing resumes in the draft, at its caret.
          input.current?.focus();
        },
        toggle({ pubkey, name }: MentionRecipient) {
          // While tags in the text decide, a pick edits those tags, so it
          // always changes who gets the message. Focus and the caret stay
          // put, and only an added agent must be admissible.
          if (recipients.length) {
            if (!recipients.some((person) => person.pubkey === pubkey))
              keepProseCaret(
                (at) =>
                  insert(`@${name} `, { pubkey, name }, at, undefined, false),
                false,
              );
            else if (
              input.current?.replaceRecipients(
                recipients.filter((person) => person.pubkey !== pubkey),
              )
            )
              completion.invalidate();
            return;
          }
          if (!routed.some((person) => person.pubkey === pubkey)) {
            // An added agent replaces any the message can no longer reach,
            // which the menu cannot uncheck.
            const admitted = admits();
            const reachable = routed.filter((person) =>
              admitted(person.pubkey),
            );
            if (reachable.length < 32) choose([...reachable, { pubkey, name }]);
          } else if (routed.length > 1)
            choose(routed.filter((person) => person.pubkey !== pubkey));
        },
      }
    : undefined;
  // The moment a mention is typed into a draft without any, the remembered
  // agents are set aside for good; a draft that already has mentions when the
  // pill takes over (restored, or before its agents were known) starts so.
  useEffect(() => {
    const before = mentionCount.current;
    mentionCount.current = routing ? recipients.length : 0;
    if (!routing || !recipients.length || before) return;
    // The composer's own prefill is withdrawn as the pill takes over, not
    // the viewer's choice.
    if (automaticTag.current === JSON.stringify(valueRef.current)) return;
    setReplacedKey(draftKey);
    setRouted([]);
    writeView(scope, pillKey, null);
  }, [routing, recipients.length, draftKey, scope, pillKey]);
  const editLocked = useListedChannel(
    listed,
    channelId,
    (channel) => !!channel?.archived || !!channel?.readOnly,
  );
  const editDisabled = disabled || editLocked;
  const editingDisabled =
    disabled ||
    admitting ||
    sending ||
    !!accepted ||
    !!submission?.locked ||
    (editing.target && (editing.locked || editDisabled)) ||
    false;
  const notifyTyping = useTypingBroadcast(
    session.typing?.send,
    channelId,
    threadRootId,
    active && !editingDisabled && !editing.target && !submission && !cached,
  );
  const label = editing.target
    ? "Edit message"
    : (customLabel ??
      (threadRootId ? "Reply to thread" : `Message #${channelName}`));
  const gifPreview = useGifDraftPreview(extensions?.tools);
  const attachments = useAttachmentDraft(
    session,
    `${scope}:${draftKey}`,
    channelId,
    !!submission?.attachments,
  );
  const picker = useRef<HTMLInputElement>(null);
  const pickerFocus = useRef<
    { ids: readonly string[]; owner: Element | null } | undefined
  >(undefined);
  const form = useRef<HTMLFormElement>(null);
  const notify = useToastNotification();
  const handOffFocus = useEffectEvent(() => {
    if (!form.current?.contains(document.activeElement)) return;
    const text = input.current?.value ?? "";
    onFocusedRemoval?.();
    if (!text.trim() || !session.channels?.get?.(channelId)?.archived) return;
    const copy = async () => {
      try {
        await writeClipboardText(text);
        notify("Text copied", "success");
      } catch {
        notify("Couldn’t copy text", "error", {
          label: "Try again",
          onClick: () => void copy(),
          timeout: Infinity,
        });
      }
    };
    notify(`${solo ? "Chat" : "Channel"} archived: ${channelName}`, "info", {
      label: "Copy text",
      onClick: () => void copy(),
      timeout: Infinity,
    });
  });
  useLayoutEffect(() => () => handOffFocus(), []);
  const canAttach = submission
    ? !!submission.attachments && !!session.attachments?.uploadForNewChat
    : !!session.attachments;
  const voice = useVoiceCapture(
    attachments.store,
    !active || editingDisabled || !!editing.target || !canAttach,
    setAttachmentError,
  );
  useEffect(() => {
    if (disabled) attachments.store.cancel();
    else attachments.store.resume();
  }, [disabled, attachments.store]);
  useEffect(() => {
    const pending = pickerFocus.current;
    if (!pending) return;
    const selected = pending.ids.map((id) =>
      attachments.items.find((item) => item.id === id),
    );
    if (
      !presented ||
      editingDisabled ||
      editing.target ||
      document.activeElement !== pending.owner ||
      selected.some((item) => !item || item.status === "error")
    ) {
      pickerFocus.current = undefined;
      return;
    }
    if (selected.every((item) => item?.status === "ready")) {
      pickerFocus.current = undefined;
      input.current?.focus();
      return;
    }
    // A later upload must not undo a deliberate focus move, even a round trip.
    const moved = (event: FocusEvent) => {
      if (event.target !== pending.owner) pickerFocus.current = undefined;
    };
    document.addEventListener("focusin", moved, true);
    return () => document.removeEventListener("focusin", moved, true);
  }, [attachments.items, presented, editingDisabled, editing.target]);
  const dragging = useFileDrop(
    form,
    active &&
      canAttach &&
      !editingDisabled &&
      !editing.target &&
      !voice.capturing,
    attachFiles,
  );
  function attachFiles(files: readonly File[]) {
    if (
      !permitted.current ||
      editingDisabled ||
      voice.isCapturing() ||
      !files.length
    )
      return;
    if (editing.target) {
      setAttachmentError("Finish editing before attaching new files.");
      return;
    }
    if (!canAttach) {
      setAttachmentError(
        submission
          ? "Create this conversation before attaching files."
          : "Uploads are unavailable on this connection.",
      );
      return;
    }
    try {
      attachments.store.add(files);
      setAttachmentError(undefined);
      return attachments.store
        .snapshot()
        .slice(-files.length)
        .map((item) => item.id);
    } catch (reason) {
      setAttachmentError(
        reason instanceof Error ? reason.message : "Could not attach files.",
      );
    }
  }
  const outbox = session.outbox;
  const emojiCatalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const largeEmojiDraft = usesLargeEmojiPresentation(
    draft,
    emojiCatalog.entries,
  );
  const completion = useCompletionEditor(
    input,
    active && !editingDisabled && !!outbox?.supports(9),
  );
  function loadSaved(raw: string | null) {
    let next: MentionDraft;
    try {
      next = stageChatCards(
        mentionDraft(JSON.parse(raw ?? "null")),
        channels(),
      );
    } catch {
      next = mentionDraft("");
    }
    revision.current = raw;
    dirty.current = false;
    valueRef.current = next;
    updateDraft(next);
    input.current?.reset(next);
    completion.invalidate();
    setLinkEdit(null);
    restoreSelection.current = undefined;
    caret.current = undefined;
    setConflict(false);
    setStorageFailed(false);
  }
  // Message-local picks return with their recovered draft. Solo preferences
  // remain the chat's current choices, including edits made during an upload.
  const reconcileDraft = useEffectEvent(
    (restored?: MentionDraft, recoveredPicks?: DraftPicks) => {
      if (submission || editing.target || writing.current) return;
      if (accepted) {
        // The recovered revision can precede attachment adoption. The explicit
        // recovery notification below reconciles the mounted owner afterward.
        if (recoveryFor(session).get(recoveryKey) === accepted) return;
        const current = viewRevision(scope, draftKey);
        if (current !== undefined) {
          setAccepted(undefined);
          loadSaved(current);
          if (!stickyPicks && restored && current === JSON.stringify(restored))
            setPicks(recoveredPicks ?? {});
        }
        return;
      }
      const current = viewRevision(scope, draftKey);
      if (current === undefined) return;
      const recovering = !!restored && current === JSON.stringify(restored);
      if (current === revision.current) {
        // The storage listener usually loads the recovered revision before
        // its notification arrives.
        if (!stickyPicks && recovering && !dirty.current)
          setPicks(recoveredPicks ?? {});
        return;
      }
      // An explicit successful recovery may replace only the cleared follow-up,
      // never a meaningful unsaved edit. Ordinary external revisions keep their
      // conflict behavior.
      if (
        recovering &&
        !valueRef.current.text.trim() &&
        !valueRef.current.recipients.length &&
        !composerMarkdown(valueRef.current).trim() &&
        !sendAttempt.current
      )
        loadSaved(current);
      else if (dirty.current || sendAttempt.current) {
        setConflict(true);
        return;
      } else loadSaved(current);
      if (!stickyPicks && recovering) setPicks(recoveredPicks ?? {});
    },
  );
  const editingDraft = !!editing.target;
  const deferredRecovery = useRef<RecoveredSend | undefined>(undefined);
  useEffect(() => {
    if (submission) return;
    const stop = subscribeView(scope, () => reconcileDraft());
    // Reconcile changes while message-edit mode or mounting paused this listener.
    reconcileDraft(
      deferredRecovery.current?.draft,
      deferredRecovery.current?.picks,
    );
    if (!editingDraft && deferredRecovery.current) {
      takeMissedRecovery(session, recoveryKey);
      setError(errorForRecovery(deferredRecovery.current.preparationError));
      deferredRecovery.current = undefined;
    }
    return stop;
  }, [scope, submission, editingDraft, session, recoveryKey]);
  const receiveRecovery = useEffectEvent((recovered: RecoveredSend) => {
    if (editing.target) deferredRecovery.current = recovered;
    reconcileDraft(recovered.draft, recovered.picks);
    if (!editing.target) {
      takeMissedRecovery(session, recoveryKey);
      setError(errorForRecovery(recovered.preparationError));
    }
  });
  useEffect(() => {
    const stop = subscribeRecovery(session, recoveryKey, (recovered) =>
      receiveRecovery(recovered),
    );
    // Recovery may have completed between unmount and this subscription. Replay
    // only if its saved caption still owns the draft; never attach an old error
    // to a replacement written while the composer was away.
    const missed = missedRecovery.get(session)?.get(recoveryKey);
    if (missed) {
      if (viewRevision(scope, draftKey) === JSON.stringify(missed.draft))
        receiveRecovery(missed);
      else takeMissedRecovery(session, recoveryKey);
    }
    return stop;
  }, [session, recoveryKey, scope, draftKey]);
  function resolveDraft(keep: boolean) {
    const current = viewRevision(scope, draftKey);
    if (current === undefined) {
      setStorageFailed(true);
      return;
    }
    if (keep) {
      dirty.current = true;
      persist(valueRef.current, current);
    } else loadSaved(current);
  }
  function finishDraft(pending: AcceptedDraft) {
    if (recoveryFor(session).get(recoveryKey) !== pending) {
      reconcileDraft();
      return;
    }
    const result = persist(pending.next, pending.revision);
    // No stale sent text needs cleanup if nothing was saved and absence is
    // still readable.
    if (
      result === "failed" &&
      (pending.revision !== null || viewRevision(scope, draftKey) !== null)
    )
      return;
    recoveryFor(session).delete(recoveryKey);
    setAccepted(undefined);
    if (result === "changed") {
      // Another editor owns this revision. Acceptance cannot erase its work.
      const current = viewRevision(scope, draftKey);
      if (current !== undefined) loadSaved(current);
      return;
    }
    dirty.current = false;
    onDraftSaved?.();
  }
  useEffect(() => {
    if (outbox?.supports(9)) void session.emoji.ensure();
  }, [session, outbox]);
  useLayoutEffect(() => {
    // Delivery closes while the input is still disabled. Focus only after React
    // has committed the restored, editable draft; preserve its saved selection.
    if (focusRestoredDraft.current) {
      focusRestoredDraft.current = false;
      input.current?.focus();
    }
    if (restoreSelection.current) {
      const { start, end } = restoreSelection.current;
      input.current?.focus();
      input.current?.setSelectionRange(start, end);
      restoreSelection.current = undefined;
      return;
    }
    if (caret.current === undefined) return;
    input.current?.focus();
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = undefined;
  });
  const requestDeletion = useMessageDeletion();
  const startEdit = useEffectEvent((row: ChannelMessage) => {
    if (
      !permitted.current ||
      editingDisabled ||
      editDisabled ||
      submission ||
      !input.current
    )
      return;
    const current = editableRows().find((item) => item.id === row.id);
    if (!current || !lastEditableMessage(session, [current])) {
      setError("This message is no longer available to edit.");
      return;
    }
    if (editing.target) {
      setError("Finish or cancel your current edit first.");
      input.current.focus();
      return;
    }
    completion.invalidate();
    beforeEdit.current = {
      value: valueRef.current,
      restore: input.current.checkpoint(),
    };
    const next = stageChatCards(
      mentionDraft(
        editing.start(current, (body) =>
          composerMarkdown(stageChatCards(mentionDraft(body), channels())),
        ),
      ),
      channels(),
    );
    valueRef.current = next;
    updateDraft(next);
    input.current.reset(next);
    setLinkEdit(null);
    caret.current = next.text.length;
    setError(undefined);
  });
  useEffect(() => {
    if (!editScope) return;
    const start = (row: ChannelMessage) => startEdit(row);
    editScope.current = start;
    editScope.input.current = input.current;
    return () => {
      if (editScope.current === start) {
        editScope.current = undefined;
        editScope.input.current = null;
      }
    };
  }, [editScope]);
  // DOM props are committed before child layout effects; closures can still
  // carry the preceding render's enabled state during that interval.
  const editable = () =>
    permitted.current &&
    !editingDisabled &&
    !!outbox?.supports(9) &&
    !!input.current?.isConnected &&
    !input.current.disabled &&
    !input.current.readOnly;
  function insert(
    text: string,
    recipient?: MentionRecipient,
    range?: CompletionQuery,
    terminator?: ":",
    focus = true,
  ) {
    const field = input.current;
    if (!editable() || !field || typeof text !== "string") return false;
    // Edits replace prose; they do not change the original notification recipients.
    if (editing.target && recipient) {
      text = editMentionText(recipient);
      recipient = undefined;
    }
    if (recipient && !admits()(recipient.pubkey)) {
      setError(
        "This recipient is no longer available. Remove it or refresh choices.",
      );
      return false;
    }
    if (recipient && valueRef.current.recipients.length >= 32) {
      setError("Choose at most 32 recipients");
      return false;
    }
    completion.invalidate();
    if (!field.insertText(text, recipient, range, terminator, focus)) {
      setError("Message is too long to insert text");
      return false;
    }
    if (recipient) rememberMention(session, channelId, recipient.pubkey);
    setError(undefined);
    return true;
  }
  /** A tool's lone GIF joins the attachment row, sent after the caption like
   * the row's other media, rather than sitting in prose at the caret. An edit
   * has no attachment row, so its GIF stays in the text. */
  function attachGif(text: string) {
    if (
      !gifPreview ||
      editing.target ||
      !stageableGif(text) ||
      !draftGif(text, session.media)
    )
      return;
    if (!editable()) return false;
    const current = valueRef.current.gifs ?? [];
    if (!current.includes(text)) {
      if (current.length >= MAX_DRAFT_GIFS) {
        setError(`Attach at most ${MAX_DRAFT_GIFS} GIFs per message.`);
        return false;
      }
      const next = { ...valueRef.current, gifs: [...current, text] };
      if (composerMarkdown(next).length > 16000) {
        setError("Message is too long to attach this GIF");
        return false;
      }
      saveDraft(next);
    }
    setError(undefined);
    input.current?.focus();
    return true;
  }
  // A Space typed before the chooser could decide holds its name as a chip
  // with no recipient; the provider's resolver settles it off-screen. The
  // chip's id keys its resolver here, and the draft says which chips exist.
  const pendingMentions = useRef(
    new Map<
      string,
      {
        resolve: CompletionPending["resolve"];
        controller?: AbortController | undefined;
        /** Settles with the typed name and why when the chip returned to prose. */
        settled?: Promise<PendingRefusal | undefined> | undefined;
      }
    >(),
  );
  function settlePendingMention(
    id: string,
    recipient: MentionRecipient | null,
    signal: AbortSignal,
  ) {
    const entry = pendingMentions.current.get(id);
    if (!entry || signal.aborted) return;
    // Exactly what Tab would have inserted: well formed (the resolution is a
    // provider's answer), admitted now, within the cap.
    const reason: PendingRefusal["reason"] | undefined = !wellFormedRecipient(
      recipient,
    )
      ? "unresolved"
      : !admits()(recipient.pubkey)
        ? "unavailable"
        : valueRef.current.recipients.length >= 32
          ? "limit"
          : undefined;
    const accepted =
      recipient && !reason
        ? { pubkey: recipient.pubkey, name: recipient.name }
        : null;
    const name = valueRef.current.pending?.find((chip) => chip.id === id)?.name;
    // Held through an IME composition, the outcome is a promise: the chip is
    // still pending until the replay, so the entry stays until it lands.
    return Promise.resolve(
      input.current?.settlePendingMention(id, accepted) ?? false,
    ).then((applied) => settled(id, accepted, applied, name ?? "", reason));
  }
  function settled(
    id: string,
    accepted: MentionRecipient | null,
    applied: boolean,
    name: string,
    reason: PendingRefusal["reason"] | undefined,
  ): PendingRefusal | undefined {
    const entry = pendingMentions.current.get(id);
    if (!entry) return;
    if (!applied) {
      // The chip left the draft in the commit before the effect below could
      // abort this resolution. Keep its resolver: redo restores the chip under
      // the same id, and the effect starts it again.
      entry.controller = undefined;
      entry.settled = undefined;
      return;
    }
    pendingMentions.current.delete(id);
    if (
      accepted &&
      valueRef.current.recipients.some((p) => p.pubkey === accepted.pubkey)
    ) {
      rememberMention(session, channelId, accepted.pubkey);
      return;
    }
    // Accepted but written as text: its current name overran the length limit.
    return { name, reason: reason ?? "length" };
  }
  function resolvePendingMention(id: string) {
    const entry = pendingMentions.current.get(id);
    if (!entry) return;
    if (!entry.controller) {
      const controller = new AbortController();
      entry.controller = controller;
      entry.settled = resolveChip(
        id,
        (s) => bounded(entry.resolve, s),
        controller.signal,
      );
    }
    return entry.settled;
  }
  /** One resolution per chip, through the longer names it continues into:
   * a chip whose name only longer known names kept from selecting extends
   * over the words typed after it when they complete one, and that name is
   * resolved under the same signal. Anything else returns it to prose, and
   * the promise settles with the typed name it returned and why. */
  async function resolveChip(
    id: string,
    resolve: CompletionPending["resolve"],
    signal: AbortSignal,
  ): Promise<PendingRefusal | undefined> {
    const outcome = await resolve(signal).catch(() => null);
    if (signal.aborted) return;
    if (!outcome || !("continued" in outcome))
      return settlePendingMention(id, outcome, signal);
    const next = typedContinuation(id, outcome.continued);
    const extended =
      next &&
      (await Promise.resolve(
        input.current?.extendPendingMention(id, next.remainder) ?? false,
      ));
    if (signal.aborted) return;
    if (next && extended)
      return resolveChip(id, (s) => bounded(next.resolve, s), signal);
    return settlePendingMention(id, null, signal);
  }
  /** `resolve` held to `MENTION_RESOLVE_TIMEOUT_MS`. The contract does not
   * ask a provider to time itself, so the host bounds every link: the first
   * resolution and each longer name a chip extends into. The bundled resolver
   * races its first resolution against the same constant, redundant under
   * this but harmless, and answers a chained resolve at once over the page it
   * already read. Expiry is null, prose, as the resolver's own bound is.
   * The provider gets its own signal, which follows the chip's and is also
   * aborted at expiry, so work that outlives the bound is told to stop; and
   * the chip's abort clears the timer, so a provider that ignores it leaves
   * nothing running after Backspace or unmount. */
  function bounded(
    resolve: CompletionPending["resolve"],
    signal: AbortSignal,
  ): Promise<CompletionResolution> {
    return new Promise((settle) => {
      const own = new AbortController();
      const timer = setTimeout(() => {
        settle(null);
        end();
      }, MENTION_RESOLVE_TIMEOUT_MS);
      const end = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", end);
        own.abort();
      };
      signal.addEventListener("abort", end, { once: true });
      resolve(own.signal)
        .then(settle, () => settle(null))
        .finally(end);
    });
  }
  /** The longest of `continued` that the chip's name plus the words typed
   * after it, up to a name boundary, spell: the name Space would have needed
   * typed in full. None when the words complete no name or stop mid-word.
   * The remainder ends on the name's last character: `normalizeName` trims,
   * so `Example ` spells the same name as `Example`, and extending over the
   * separator would join the chip to whatever is typed after it. */
  function typedContinuation(
    id: string,
    continued: readonly CompletionPending[],
  ) {
    const chip = valueRef.current.pending?.find((item) => item.id === id);
    if (!chip) return undefined;
    const { text } = valueRef.current;
    const names = new Map(continued.map((c) => [normalizeName(c.name), c]));
    const longest = Math.max(...[...names.keys()].map((n) => n.length));
    let found:
      | { remainder: string; resolve: CompletionPending["resolve"] }
      | undefined;
    for (let end = chip.end + 1; end <= text.length; end++) {
      const remainder = text.slice(chip.end, end);
      const name = normalizeName(chip.name + remainder);
      if (name.length > longest) break;
      if (/\s$/u.test(remainder) || !mentionBoundary(text, end)) continue;
      const next = names.get(name);
      if (next) found = { remainder, resolve: next.resolve };
    }
    return found;
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reconciles resolvers against the chips in the draft; the helpers read current refs.
  useEffect(() => {
    const alive = new Set(value.pending?.map((chip) => chip.id));
    for (const [id, entry] of pendingMentions.current) {
      if (alive.has(id)) resolvePendingMention(id);
      else if (entry.controller) {
        // Backspace, undo or Clear removed the chip. Redo brings it back under
        // the same id, and this effect starts its resolution again.
        entry.controller.abort();
        entry.controller = undefined;
        entry.settled = undefined;
      }
    }
  }, [value.pending]);
  useEffect(
    () => () => {
      for (const entry of pendingMentions.current.values())
        entry.controller?.abort();
    },
    [],
  );
  function insertMention(recipient: MentionRecipient) {
    if (!wellFormedRecipient(recipient)) return false;
    if (!solo || editing.target)
      return insert(`@${recipient.name} `, recipient);
    return keepProseCaret((at) =>
      insert(`@${recipient.name} `, recipient, at, undefined, false),
    );
  }
  /** Solo chats address agents up front: a picked tag joins the leading tags,
   * wherever the caret is. The insertion maps the caret, so the caret and its
   * Undo both stay in the prose it was in. */
  function keepProseCaret(add: (at: CompletionQuery) => boolean, focus = true) {
    const before = valueRef.current;
    let start = 0;
    for (const tag of [...before.recipients].sort(
      (a, b) => a.start - b.start,
    )) {
      if (tag.start !== start || !/[ \t]/.test(before.text[tag.end] ?? ""))
        break;
      start = tag.end;
      while (/[ \t]/.test(before.text[start] ?? "")) start++;
    }
    const caret = input.current?.selectionStart ?? before.text.length;
    if (!add({ start, end: start, query: "" })) return false;
    // A caret among the leading tags has no prose to stay in.
    if (caret < start)
      input.current?.setSelectionRange(
        valueRef.current.text.length,
        valueRef.current.text.length,
      );
    if (focus) input.current?.focus();
    return true;
  }
  function insertMentions(
    recipients: readonly MentionRecipient[],
    range?: CompletionQuery,
  ) {
    if (
      !Array.isArray(recipients) ||
      !recipients.length ||
      recipients.some(
        (person) =>
          !person ||
          typeof person.pubkey !== "string" ||
          !/^[0-9a-f]{64}$/.test(person.pubkey) ||
          typeof person.name !== "string" ||
          !person.name.trim(),
      )
    )
      return false;
    const unique = [
      ...new Map(recipients.map((person) => [person.pubkey, person])).values(),
    ];
    if (unique.length > 32) {
      setError("Choose at most 32 recipients");
      return false;
    }
    if (
      !permitted.current ||
      editingDisabled ||
      !outbox?.supports(9) ||
      !input.current?.isConnected ||
      input.current.disabled ||
      input.current.readOnly
    )
      return false;
    // Message edits only add references, never new notification intent.
    if (editing.target)
      return insert(unique.map(editMentionText).join(""), undefined, range);
    const admitted = admits();
    if (unique.some((person) => !admitted(person.pubkey))) {
      setError(
        "A team member is no longer available. Refresh choices before trying again.",
      );
      return false;
    }
    const text = unique.map((person) => `@${person.name} `).join("");
    if (
      !(solo && !range
        ? keepProseCaret(
            (at) =>
              !!input.current?.insertText(text, unique, at, undefined, false),
          )
        : input.current.insertText(text, unique, range))
    ) {
      setError(
        "The team would exceed the message length or 32-recipient limit. Nothing was added.",
      );
      return false;
    }
    completion.invalidate();
    for (const person of unique)
      rememberMention(session, channelId, person.pubkey);
    setError(undefined);
    return true;
  }
  function replaceRecipients(recipients: readonly MentionRecipient[]) {
    if (
      !Array.isArray(recipients) ||
      recipients.some(
        (person) =>
          !person ||
          typeof person.pubkey !== "string" ||
          !/^[0-9a-f]{64}$/.test(person.pubkey) ||
          typeof person.name !== "string" ||
          !person.name.trim(),
      ) ||
      !permitted.current ||
      editingDisabled ||
      editing.target ||
      !outbox?.supports(9) ||
      !input.current?.isConnected ||
      input.current.disabled ||
      input.current.readOnly
    )
      return false;
    const unique = [
      ...new Map(recipients.map((person) => [person.pubkey, person])).values(),
    ];
    const admitted = admits();
    if (unique.length > 32 || unique.some((person) => !admitted(person.pubkey)))
      return false;
    if (!input.current.replaceRecipients(unique)) return false;
    completion.invalidate();
    setError(undefined);
    return true;
  }
  function replaceRecipientsIfEmpty(recipients: readonly MentionRecipient[]) {
    const current = valueRef.current;
    const prose = [...current.recipients]
      .sort((a, b) => b.start - a.start)
      .reduce(
        (text, tag) => text.slice(0, tag.start) + text.slice(tag.end),
        current.text,
      );
    return !prose.trim() && replaceRecipients(recipients);
  }
  function insertResource(resource: ComposerResource): true | string {
    if (
      !permitted.current ||
      editingDisabled ||
      !outbox?.supports(9) ||
      !input.current?.isConnected
    )
      return "The message can't be edited right now";
    completion.invalidate();
    return input.current.insertResource(resource);
  }
  function replaceCompletion(
    edit: CompletionEdit,
    query: CompletionQuery,
    observation: ComposerObservation,
    key?: string,
  ) {
    if (
      !completion.valid(observation) ||
      valueRef.current.text !== observation.text
    )
      return false;
    // A typed terminator (Space, the closing emoji colon) stays literal in code.
    if (key === " " || key === ":") {
      const doc = readComposerSnapshot(valueRef.current.document);
      const context = doc
        ? composerMarkdownContext(doc)
        : { text: observation.text, protected: [] };
      if (
        [...context.protected, ...markdownRanges(context.text).literal].some(
          (r) => query.start < r.end && query.end > r.start,
        )
      )
        return false;
    }
    if ("pending" in edit && edit.pending) {
      // Edits replace prose and add no recipients, so a chip that may become
      // one has no place there: the typed Space stays literal.
      const field = input.current;
      if (editing.target || !editable() || !field) return false;
      completion.invalidate();
      const id = field.insertPendingMention(edit.pending.name, query);
      if (!id) return false;
      pendingMentions.current.set(id, { resolve: edit.pending.resolve });
      setError(undefined);
      return true;
    }
    if ("mentions" in edit && edit.mentions)
      return insertMentions(edit.mentions, query);
    if ("mention" in edit && edit.mention)
      return insert(`@${edit.mention.name} `, edit.mention, query);
    return (
      typeof edit.text === "string" &&
      insert(
        `${edit.text}${isEmojiOnly(edit.text, emojiCatalog.entries) ? "" : " "}`,
        undefined,
        query,
        key === ":" ? key : undefined,
      )
    );
  }
  const currentAdmission = () =>
    live.current &&
    permitted.current &&
    !sendAttempt.current?.signal.aborted &&
    (!ownSoloConversation ||
      session.channels.list().channels.find((item) => item.id === channelId)
        ?.channelType === "solo");
  // A new Solo chat is seeded with its default agent each time it is shown,
  // while its draft is empty and untagged; a saved chat seeds from its window
  // like every other composer. Once it has content, respect edits and
  // removals until the composer is shown again. Like the window's seed, the
  // tag is this composer's own prefill and isn't saved until the viewer edits
  // the draft, so showing the chat again tags the current default agent.
  const seedMention = defaultMention;
  // Alone with agents, the toolbar holds every agent of the viewer's latest
  // message instead, keys joined so the snapshot keeps its identity.
  const seekingAgents =
    routing && presented && !submission && !threadRootId && !routed.length;
  const subscribeAgents = useCallback(
    (listener: () => void) => {
      if (!seekingAgents) return noSubscription();
      const rows = session.channels.subscribeWindow?.(channelId, listener);
      const choices = session.agentChoices.subscribe(listener);
      return () => {
        rows?.();
        choices();
      };
    },
    [seekingAgents, session.channels, session.agentChoices, channelId],
  );
  const chosenAgent = useChosenAgent(scope);
  const lastAgents = useSyncExternalStore(subscribeAgents, () => {
    if (!seekingAgents || defaultMention) return undefined;
    const history = session.channels.window?.(channelId);
    // The history decides before any stand-in does.
    if (
      !replaced &&
      (history?.status === "idle" || history?.status === "loading")
    )
      return undefined;
    // Once typed mentions replaced the remembered agents, the history is
    // skipped.
    return seedAgents(
      session,
      channelId,
      replaced ? [] : (history?.rows ?? []),
      mentionAdmission(session, channelId, agentChoices, mentionRoster),
      session.agentChoices
        .snapshot()
        .selectable.some((choice) => choice.pubkey === chosenAgent)
        ? chosenAgent
        : undefined,
    ).join(",");
  });
  const seededAgents: readonly MentionRecipient[] = !routing
    ? []
    : defaultMention
      ? mentionAdmission(
          session,
          channelId,
          agentChoices,
          mentionRoster,
        )(defaultMention.pubkey)
        ? [defaultMention]
        : []
      : (lastAgents?.split(",") ?? []).flatMap(
          (key) =>
            pastedMentionRecipient(
              session,
              channelId,
              key,
              agentChoices,
              mentionRoster,
            ) ?? [],
        );
  const autoTagged = useRef<string | undefined>(undefined);
  const seeding = useRef(false);
  const prefill = (apply: () => boolean) => {
    seeding.current = true;
    try {
      if (!apply()) return false;
    } finally {
      seeding.current = false;
    }
    automaticTag.current = JSON.stringify(valueRef.current);
    return true;
  };
  const seededRoute = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!presented) {
      autoTagged.current = undefined;
      // Hidden untouched, the pill refills for the current default when shown.
      if (
        seededRoute.current === routedKey(routed) &&
        untouchedDraft(valueRef.current) &&
        !attachments.store.snapshot().length
      )
        setRouted([]);
      seededRoute.current = undefined;
    }
    if (
      !presented ||
      sendPending ||
      completion.composing.current ||
      editing.target
    )
      return;
    // Alone with agents, the agent joins the toolbar, never the text. An empty
    // pill is always refilled, even after a send, so removed mentions fall back.
    if (routing) {
      if (routed.length || recipients.length) return;
      // A saved pick is restored whole, however discovery stands; the send
      // checks each agent and asks the viewer about any it can't reach.
      const chosen = readView<unknown>(scope, pillKey, null);
      const kept = Array.isArray(chosen)
        ? chosen
            .filter(wellFormedRecipient)
            .map(({ pubkey, name }) => ({ pubkey, name }))
        : [];
      if (kept.length) {
        setRouted(kept);
        return;
      }
      if (seededAgents.length) {
        setRouted(seededAgents.map(({ pubkey, name }) => ({ pubkey, name })));
        seededRoute.current = routedKey(seededAgents);
      }
      return;
    }
    if (autoTagged.current === draftKey) return;
    // Shown again untouched, the prefill retags for the current default. A
    // saved draft is the viewer's, however it was addressed.
    if (automaticTag.current === JSON.stringify(valueRef.current)) {
      // Until the default can be tagged, as when its evidence is loading.
      if (
        seedMention &&
        (seedMention.pubkey === valueRef.current.recipients[0]?.pubkey ||
          prefill(() => replaceRecipients([seedMention])))
      )
        autoTagged.current = draftKey;
      return;
    }
    // A shortcut may seed an ordinary editable link. Still add the default
    // agent once while that freshly seeded text is untouched; a restored draft
    // keeps its recipients as saved, so a removed tag never returns.
    const untouchedInitial =
      seededKey === draftKey &&
      typeof submission?.initialDraft === "string" &&
      draft === submission.initialDraft;
    if (value.recipients.length || (draft.trim() && !untouchedInitial)) {
      autoTagged.current = draftKey;
      return;
    }
    if (seedMention && admits()(seedMention.pubkey)) {
      if (
        prefill(() =>
          insert(
            `@${seedMention.name} `,
            seedMention,
            { start: 0, end: 0, query: "" },
            undefined,
            false,
          ),
        )
      ) {
        input.current?.setSelectionRange(
          valueRef.current.text.length,
          valueRef.current.text.length,
        );
      }
    }
  });
  // The seed's message or the evidence classifying its agents may arrive
  // after mount (the window or thread page lands; mentioned profiles are
  // ensured on open; the library is idle until a chooser runs), and each send
  // changes the viewer's latest message. The seed then fills an empty
  // composer, or replaces its own earlier prefill, once per message and
  // showing (an edit of the user's settles it): a removed chip stays removed
  // until the composer is shown again, a newer message of the viewer's
  // lands, or a send here replaces the draft with the composer's own
  // follow-up. reset() replaces the editor without a change event, so
  // nothing persists; focus stays with its current owner.
  useEffect(() => {
    if (!presented) {
      seedApplied.current = undefined;
      seedClosed.current = false;
      return;
    }
    if (editing.target || completion.composing.current) return;
    // Content the user put in, unlike this effect's own prefill, closes the
    // seed until the composer is shown again, even once it is cleared.
    const current = JSON.stringify(valueRef.current);
    // Alone with agents, the toolbar holds them, never the text: a prefill
    // made before that was known is withdrawn.
    if (routing) {
      if (
        automaticTag.current === current &&
        valueRef.current.recipients.length
      ) {
        const empty = mentionDraft("");
        valueRef.current = empty;
        updateDraft(empty);
        input.current?.reset(empty);
        automaticTag.current = undefined;
      }
      return;
    }
    if (!untouchedDraft(valueRef.current) && automaticTag.current !== current) {
      seedClosed.current = true;
      return;
    }
    if (
      seedClosed.current ||
      !seedSource ||
      submission ||
      sendPending ||
      accepted ||
      attachments.items.length
    )
      return;
    const key = seedKey(seedSource);
    if (seedApplied.current === key) return;
    if (!rememberAgentsPreference()) {
      // Opting out changes future prefills, not the current draft.
      seedApplied.current = key;
      return;
    }
    // Partial agent evidence may name a subset of the agents: that seed shows
    // now and is replaced as names resolve, final once the evidence settles.
    // An empty seed waits for settled evidence before ending a prefilled
    // chain; settled, it ends one whether the message tagged people or no one.
    const seed = seedMentions(session, seedSource);
    const settled = seedEvidenceSettled(session, seedSource);
    if (settled) seedApplied.current = key;
    if (!seed.recipients.length && !settled) return;
    if (JSON.stringify(seed) === current) return;
    valueRef.current = seed;
    updateDraft(seed);
    input.current?.reset(seed);
    automaticTag.current = seed.recipients.length
      ? JSON.stringify(seed)
      : undefined;
    if (input.current && document.activeElement === input.current)
      input.current.setSelectionRange(seed.text.length, seed.text.length);
  });
  // Alone in a Solo chat, a send addresses agents; with people it is a conversation.
  const needsRecipient = (requireMention || solo) && !withPeople;
  const recipientHint = routing
    ? "Choose an agent to send"
    : submission
      ? "Tag an agent to send"
      : "Tag a person or agent to send";
  // A pending mention may yet become the recipient; sending waits for it.
  const untagged =
    needsRecipient &&
    !editing.target &&
    !addressed.length &&
    !value.pending?.length;
  async function prepareRecipients(
    explicit: readonly string[],
    fromPill = false,
  ) {
    const channel = await session.channelWrites.refreshMembership(channelId);
    if (!currentAdmission())
      throw new Error("The session changed. Review its channel and retry.");
    // The pill stands in only while the chat is the viewer and agents; a
    // person who joined since needs the agents tagged by name.
    if (
      fromPill &&
      !soloAgentsOnly(
        channel.members,
        session.viewer,
        knownAgentPubkeys(
          session.profiles.snapshot(),
          session.agentChoices.snapshot(),
        ),
      )
    )
      throw new Error("Someone joined this chat. Tag an agent to send.");
    const recipients = [...explicit];
    if (!recipients.length) {
      // An untagged send relies on a person being present; confirm it against
      // the fresh roster and agent inventory, not the rendered snapshot.
      await session.agentChoices.refresh();
      if (!currentAdmission())
        throw new Error("The session changed. Review its channel and retry.");
      const profiles = session.profiles.snapshot();
      if (
        !soloHasPeople(
          channel.members,
          session.viewer,
          profiles,
          knownAgentPubkeys(profiles, session.agentChoices.snapshot()),
        )
      )
        throw new Error("Tag an agent to send.");
    }
    const missing = recipients.filter((key) => !channel.members?.includes(key));
    if (missing.length) {
      // Classification no longer depends on inventory; refresh before admission.
      await session.agentChoices.refresh();
      if (!currentAdmission())
        throw new Error("The session changed. Review its channel and retry.");
      if (
        missing.some(
          (key) =>
            !session.agentChoices
              .snapshot()
              .selectable.some((agent) => agent.pubkey === key),
        )
      )
        throw new Error(
          "Tag a person already in this chat or one of your available agents.",
        );
      await session.channelWrites.addAgents(
        channelId,
        missing,
        currentAdmission,
      );
      if (!currentAdmission())
        throw new Error("The session changed. Review its channel and retry.");
    }
    return recipients;
  }
  async function send() {
    if (!permitted.current || voice.isCapturing()) return;
    if (editing.target) {
      if (editDisabled || editing.locked) return;
      if (
        !valueRef.current.text.trim() &&
        !valueRef.current.chatCards?.length
      ) {
        if (editing.target.attachments.length) {
          setError(
            "Keep attachment links unchanged. To remove this message, use Delete message.",
          );
          return;
        }
        if (requestDeletion && session.outbox?.supports(5)) {
          const checkpoint = beforeEdit.current;
          requestDeletion(editing.target, (focus) => {
            if (beforeEdit.current !== checkpoint) return;
            editing.close();
            focusRestoredDraft.current = focus;
          });
        }
        return;
      }
      editing.save(
        composerMarkdown(valueRef.current),
        editableRows().find((row) => row.id === editing.target?.id),
      );
      return;
    }
    if (
      disabled ||
      compactingNow() ||
      accepted ||
      conflict ||
      admission.current ||
      submission?.disabled ||
      (!submission && (input.current?.readOnly || input.current?.disabled)) ||
      attachments.blocked ||
      sendPending ||
      sendAttempt.current ||
      !outbox
    )
      return;
    if (valueRef.current.pending?.length) {
      // Enter straight after Space is the case a pending mention exists for.
      // Wait for its recipient rather than send prose; the composer shows
      // its sending state meanwhile. The wait is bounded: `resolveChip`
      // holds each link of a resolution, the first and each longer name the
      // chip extends into, to `MENTION_RESOLVE_TIMEOUT_MS` (the contract
      // lets a provider's resolve do I/O without timing itself); plus an IME
      // composition that was already open when Send was clicked, since a
      // settle landing under it is held until the composition ends.
      const wait = new AbortController();
      sendAttempt.current = wait;
      setSending(true);
      setError(undefined);
      let outcomes:
        | PromiseSettledResult<PendingRefusal | undefined>[]
        | undefined;
      try {
        outcomes =
          (await Promise.race([
            Promise.allSettled(
              valueRef.current.pending.map((chip) =>
                resolvePendingMention(chip.id),
              ),
            ),
            new Promise<void>((resolve) => {
              wait.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            }),
          ])) || undefined;
      } finally {
        if (sendAttempt.current === wait) {
          sendAttempt.current = null;
          if (live.current) setSending(false);
        }
      }
      if (wait.signal.aborted || !live.current || !permitted.current) return;
      // A chip this send waited on that returned to prose would go out as a
      // name that notifies no one, after the user saw it held. Keep the
      // draft and say why, so the user can fix it (a recipient over the cap)
      // or send again to send it as text, since nothing is pending by then.
      const prose = (outcomes ?? []).flatMap((outcome) =>
        outcome.status === "fulfilled" && outcome.value ? [outcome.value] : [],
      );
      if (prose.length) {
        const why = Object.entries(pendingRefusals).flatMap(
          ([reason, says]) => {
            const names = prose
              .filter((chip) => chip.reason === reason)
              .map((chip) => `@${chip.name}`);
            return names.length ? [`${names.join(", ")} ${says}.`] : [];
          },
        );
        setError(
          [
            ...why,
            needsRecipient && !sendRecipients().length
              ? `${recipientHint}.`
              : `Send again to send ${prose.length > 1 ? "them" : "it"} as text.`,
          ].join(" "),
        );
        return;
      }
    }
    const recipientsNow = sendRecipients();
    if (needsRecipient && !recipientsNow.length) {
      setError(recipientHint);
      return;
    }
    // Named conversations require text unless their owner explicitly permits files alone.
    if (
      !draft.trim() &&
      !chatCards?.length &&
      ((!!submission && !submission.allowAttachmentOnly) ||
        (!attachments.items.length && !gifs?.length))
    )
      return;
    const recovering = !submission && recoveryFor(session).get(recoveryKey);
    if (recovering) {
      setAccepted(recovering);
      valueRef.current = recovering.next;
      updateDraft(recovering.next);
      input.current?.reset(recovering.next);
      return;
    }
    if (!submission && viewRevision(scope, draftKey) !== revision.current) {
      setConflict(true);
      return;
    }
    if (pendingPickSaves.current) {
      setError(
        "Model and effort choices are still saving. Try sending again shortly.",
      );
      return;
    }
    if (pickReadFailed) return;
    const choicesNow = resolvedPicks.current;
    const picksNow = choicesNow?.source ?? committedPicks.current;
    if (
      stickyPicks &&
      (choicesNow?.value === null ||
        sessionTargets(recipientsNow.map((item) => item.pubkey)).some(
          (pubkey) => {
            const saved = picksNow.picks[pubkey];
            return (
              (saved?.model || saved?.effort) &&
              !choicesNow?.pubkeys.includes(pubkey)
            );
          },
        ))
    ) {
      setError(
        choicesNow?.error ??
          "Saved model and effort choices are still loading. Try sending again shortly.",
      );
      return;
    }
    const savedRevision = revision.current;
    const attempt = new AbortController();
    sendAttempt.current = attempt;
    const captured = valueRef.current;
    const capturedRecipients = routing ? recipientsNow : captured.recipients;
    const capturedAttachments = attachments.store.snapshot();
    // Mention resolution can update recipients before their picker commits.
    // Capture only a snapshot validated for the saved choices being sent.
    const capturedPicks = picksNow.picks;
    const capturedPicksRevision = picksNow.revision;
    const capturedRunPicks = stickyPicks
      ? { ...(choicesNow?.value ?? {}) }
      : { ...capturedPicks, ...(choicesNow?.value ?? {}) };
    // A send is an agent follow-up unless it addresses a confirmed person
    // (a loaded, non-agent profile). Those, and untagged conversation in a
    // shared chat, go out now; recipients still being classified keep the
    // owner's queue preference.
    const profileSnapshot = session.profiles.snapshot();
    const agentKeys = knownAgentPubkeys(
      profileSnapshot,
      session.agentChoices.snapshot(),
    );
    const queueFollowUp =
      !!host &&
      ownSoloConversation &&
      !threadRootId &&
      followUpBehaviorPreference() === "queue" &&
      capturedRecipients.length > 0 &&
      !soloHasPeople(
        capturedRecipients.map(({ pubkey }) => pubkey),
        session.viewer,
        profileSnapshot,
        agentKeys,
      );
    try {
      const bringable = new Set(
        (agents?.joinable() ?? []).map((agent) => agent.pubkey),
      );
      if (
        capturedRecipients.some(
          (p) => archivedMention(session, p.pubkey) && !bringable.has(p.pubkey),
        )
      )
        throw new Error(
          routing && !captured.recipients.length
            ? "An agent you're sending to is archived. Choose another agent to send."
            : "A selected recipient is archived. Remove it before sending.",
        );
      if (
        ownSoloConversation &&
        submission &&
        capturedRecipients.some(
          (person) =>
            !session.agentChoices
              .snapshot()
              .selectable.some((agent) => agent.pubkey === person.pubkey),
        )
      )
        throw new Error(
          "Only your available agents can be mentioned in Solo chats. Remove the unavailable recipient and retry.",
        );
      if (submission) {
        // SoloDraft filters the captured choices against its final recipient set.
        submission.submit(
          captured,
          attachments.store,
          routing ? capturedRecipients : undefined,
          ownSoloConversation ? capturedRunPicks : undefined,
          ownSoloConversation ? capturedPicks : undefined,
          ownSoloConversation ? capturedPicksRevision : undefined,
        );
        return;
      }
      let references: readonly string[] = [];
      let recipients = capturedRecipients.map((item) => item.pubkey);
      let declinedImports: readonly string[] = [];
      if (soloConversation || ownSoloConversation) {
        admission.current = true;
        setAdmitting(true);
        recipients = await prepareRecipients(
          recipients,
          routing && !captured.recipients.length,
        );
      } else if (recipients.length) {
        // An agent only an earlier Buzz runs would not answer; offer it here first.
        const lookup = oldAgents.find(captured.recipients);
        const old = lookup instanceof Promise ? await lookup : lookup;
        if (old.length) {
          setSending(true);
          setError(undefined);
          const decision = await oldAgents.ask(
            old,
            attempt.signal,
            () =>
              valueRef.current === captured &&
              sameAttachmentSelection(
                attachments.store.snapshot(),
                capturedAttachments,
              ) &&
              permitted.current,
          );
          if (decision === null) return;
          declinedImports = decision;
        }
        const channel = session.channels
          .list()
          .channels.find((item) => item.id === channelId);
        if (channel?.members && allowsOutsideMentions(channel)) {
          const current = () =>
            valueRef.current === captured &&
            sameAttachmentSelection(
              attachments.store.snapshot(),
              capturedAttachments,
            ) &&
            permitted.current;
          // The owner's agents from their other communities join first.
          let added: readonly string[] = [];
          const elsewhere = new Map(
            (agents?.joinable() ?? []).map((agent) => [agent.pubkey, agent]),
          );
          const bring = captured.recipients.flatMap((person) => {
            const agent = elsewhere.get(person.pubkey);
            return agent && !channel.members?.includes(person.pubkey)
              ? [agent]
              : [];
          });
          if (bring.length && channel.channelType !== "dm") {
            setSending(true);
            setError(undefined);
            const brought = await bringing.prepare(
              bring,
              attempt.signal,
              current,
            );
            if (brought === null) return;
            added = brought;
          }
          const missing = captured.recipients.filter(
            (person) =>
              !channel.members?.includes(person.pubkey) &&
              !added.includes(person.pubkey),
          );
          if (missing.length && channel?.channelType === "dm") {
            // Nobody can be added to a DM, so there is no choice to offer:
            // outside people become references without a prompt.
            references = missing.map((person) => person.pubkey);
            recipients = recipients.filter((key) => !references.includes(key));
          } else if (missing.length) {
            setSending(true);
            setError(undefined);
            const decision = await nonmembers.prepare(
              missing,
              attempt.signal,
              current,
            );
            if (decision === null) return;
            references = decision;
            recipients = recipients.filter((key) => !references.includes(key));
          }
        }
      }
      attempt.signal.throwIfAborted();
      if (attachments.store.snapshot().some((item) => item.status === "error"))
        return;
      if (
        valueRef.current !== captured ||
        !sameAttachmentSelection(
          attachments.store.snapshot(),
          capturedAttachments,
        )
      )
        return;
      if (viewRevision(scope, draftKey) !== savedRevision) {
        setConflict(true);
        return;
      }
      const content =
        threadRootId && mediaTimeSeconds !== undefined
          ? mediaTimeReply(mediaTimeSeconds, composerMarkdown(captured))
          : composerMarkdown(captured);
      // Alone with agents, the toolbar keeps the agents; the next draft starts empty.
      const next = routing
        ? mentionDraft("")
        : rememberedMentions(session, captured, recipients);
      // Only agents this message still addresses are asked for a model or effort.
      const addressedNow = sessionTargets(recipients);
      const sentPicks: MentionPicks = Object.fromEntries(
        Object.entries(capturedRunPicks).filter(([key]) =>
          addressedNow.includes(key),
        ),
      );
      const tuned = Object.keys(sentPicks).length > 0;
      const stagedChats = new Set(
        chatCardIds((captured.chatCards ?? []).join("\n\n")),
      );
      const linkedChats = chatCardIds(content).filter((id) =>
        stagedChats.has(id),
      );
      if (linkedChats.length) {
        setSending(true);
        setError(undefined);
        const current = () =>
          permitted.current &&
          valueRef.current === captured &&
          viewRevision(scope, draftKey) === savedRevision &&
          sameAttachmentSelection(
            attachments.store.snapshot(),
            capturedAttachments,
          );
        if (!(await linkSharing.prepare(linkedChats, attempt.signal, current)))
          return;
        attempt.signal.throwIfAborted();
        if (viewRevision(scope, draftKey) !== savedRevision) {
          setConflict(true);
          return;
        }
        if (!current()) return;
      }
      // Every prompt passed, so this message goes out to who was declined.
      oldAgents.decline(declinedImports);
      // Destination and content are fixed here; a background send never retargets.
      function publishNow(
        uploaded: readonly UploadedAttachment[],
        sender: RelaySession,
      ): string;
      function publishNow(
        uploaded: readonly UploadedAttachment[],
        sender: ComposerSession,
      ): string | Promise<string>;
      function publishNow(
        uploaded: readonly UploadedAttachment[],
        sender: ComposerSession,
      ) {
        if (compactingNow(recipients))
          throw new Error("Wait for compaction to finish, or interrupt it.");
        return threadRootId
          ? sender.messages.reply(
              channelId,
              threadRootId,
              content,
              recipients,
              uploaded,
              ...(replyParentId || references.length || tuned
                ? [replyParentId]
                : []),
              ...(references.length || tuned ? [references] : []),
              ...(tuned ? [sentPicks] : []),
            )
          : references.length || tuned
            ? sender.messages.send(
                channelId,
                content,
                recipients,
                uploaded,
                undefined,
                references,
                ...(tuned ? [sentPicks] : []),
              )
            : sender.messages.send(channelId, content, recipients, uploaded);
      }
      const publish = (
        uploaded: readonly UploadedAttachment[],
        validated = false,
      ) => {
        if (compactingNow(recipients))
          throw new Error("Wait for compaction to finish, or interrupt it.");
        if (!queueFollowUp || !host) return publishNow(uploaded, session);
        const message = {
          channelId,
          text: content,
          recipients,
          attachments: uploaded,
          references,
          picks: sentPicks,
        };
        const send = followUpMessage(host, message);
        return followUpQueue(host).submit(
          {
            ...message,
            message,
            beforeRelease: send.beforeRelease,
            ready: send.ready,
            publish: (recovery) => {
              if (compactingNow(recipients))
                throw new Error(
                  "Wait for compaction to finish, or interrupt it.",
                );
              return send.publish(recovery);
            },
            onSend: (id) => {
              if (live.current) onSend?.(id);
            },
          },
          validated,
        );
      };
      let id: string | undefined;
      if (capturedAttachments.length && !fullSession(session)) {
        setSending(true);
        const uploaded = await attachments.store.prepareForSend(attempt.signal);
        attempt.signal.throwIfAborted();
        id = await publish(uploaded);
      } else if (capturedAttachments.length) {
        // The revision acceptance saves; remembered agents are not a draft.
        const followup = JSON.stringify(mentionDraft(""));
        sendInBackground(
          session,
          recoveryKey,
          channelId,
          capturedAttachments,
          async (uploaded) => {
            const sent = await publish(uploaded);
            if (sent && live.current) onSend?.(sent);
          },
          (files, preparationError) => {
            // Only the original saved draft or the untouched follow-up can be
            // restored. A later edit belongs to its author, not this job.
            const current = viewRevision(scope, draftKey);
            const capturedRevision = JSON.stringify(captured);
            const cleared = (raw: string | null | undefined) => {
              if (!raw) return false;
              try {
                const draft = mentionDraft(JSON.parse(raw));
                return (
                  !draft.text.trim() &&
                  !draft.recipients.length &&
                  !composerMarkdown(draft).trim()
                );
              } catch {
                return false;
              }
            };
            if (
              live.current &&
              !cleared(JSON.stringify(valueRef.current)) &&
              (valueRef.current.text !== next.text ||
                JSON.stringify(valueRef.current.recipients) !==
                  JSON.stringify(next.recipients) ||
                JSON.stringify(valueRef.current.chatCards ?? []) !==
                  JSON.stringify(next.chatCards ?? []) ||
                JSON.stringify(valueRef.current.gifs ?? []) !==
                  JSON.stringify(next.gifs ?? [])) &&
              JSON.stringify(valueRef.current) !== capturedRevision
            )
              return "conflict";
            if (
              current !== savedRevision &&
              current !== followup &&
              current !== capturedRevision &&
              !(
                cleared(current) &&
                (!live.current || cleared(JSON.stringify(valueRef.current)))
              ) &&
              !(
                live.current &&
                current === JSON.stringify(valueRef.current) &&
                valueRef.current.text === next.text &&
                JSON.stringify(valueRef.current.recipients) ===
                  JSON.stringify(next.recipients) &&
                JSON.stringify(valueRef.current.chatCards ?? []) ===
                  JSON.stringify(next.chatCards ?? []) &&
                JSON.stringify(valueRef.current.gifs ?? []) ===
                  JSON.stringify(next.gifs ?? [])
              )
            )
              return "conflict";
            const target = attachmentDraft(session, recoveryKey, channelId);
            if (target.snapshot().length) return "conflict";
            if (
              current !== capturedRevision &&
              replaceView(scope, draftKey, current, captured) !== "saved"
            )
              return false;
            if (!target.adopt(files)) return false;
            recoveryFor(session).delete(recoveryKey);
            // The whole captured pick set returns with the whole draft; the
            // recipient filter above applies again on the next send.
            notifyRecovered(session, recoveryKey, {
              draft: captured,
              picks: capturedPicks,
              preparationError,
            });
            return true;
          },
          attachments.store,
        );
      } else {
        // prepareRecipients just refreshed membership; nothing awaited since.
        const result = publish([], true);
        if (typeof result !== "string") setSending(true);
        id = typeof result === "string" ? result : await result;
      }
      // Nothing is saved for the remembered agents: this composer shows them
      // in memory, and any composer here, on any device, seeds them from the
      // sent message once it lands (see seedMentions).
      const followUp = next;
      const pending = { next: mentionDraft(""), revision: savedRevision };
      recoveryFor(session).set(recoveryKey, pending);
      setAccepted(pending);
      attachments.store.clear();
      completion.invalidate();
      clearMediaTime?.();
      const changed =
        JSON.stringify(followUp) !== JSON.stringify(valueRef.current);
      valueRef.current = followUp;
      updateDraft(followUp);
      // The toolbar keeps whoever heard this message for the follow-up.
      if (routing) {
        setRouted(capturedRecipients);
        setReplacedKey(undefined);
        keepPick(null);
      }
      if (!stickyPicks) setPicks({});
      // An unchanged prefill may not render. Do not leave a caret command for
      // the next keystroke to consume after inserting its first character.
      caret.current = changed ? followUp.text.length : undefined;
      input.current?.reset(followUp);
      input.current?.focus();
      if (!changed)
        input.current?.setSelectionRange(
          followUp.text.length,
          followUp.text.length,
        );
      setError(undefined);
      autoTagged.current = draftKey;
      automaticTag.current = followUp.recipients.length
        ? JSON.stringify(followUp)
        : undefined;
      // The typed draft that closed seeding is gone: the follow-up is this
      // composer's own, settled for the message on screen like an edit, so a
      // newer message of the viewer's seeds over it once it lands. The typed
      // draft was not seeking, so the window is read here, not from render.
      seedClosed.current = false;
      const latest = threadSeed ?? (seedsFromWindow ? windowSeed() : undefined);
      if (latest) seedApplied.current = seedKey(latest);
      if (id) onSend?.(id);
      finishDraft(pending);
    } catch (reason) {
      if (live.current && !attempt.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      admission.current = false;
      if (sendAttempt.current === attempt) {
        sendAttempt.current = null;
        if (live.current) {
          setSending(false);
          setAdmitting(false);
        }
      }
    }
  }
  const readingOnly = !outbox?.supports(9) && !cached;
  // The attachments section animates out over 150 ms; the form's gap and
  // padding (data-attachments) collapse when it has, not when the list empties.
  // An edit unmounts the section at once, so no exit completes during one.
  const hasAttachments = attachments.items.length > 0 || !!gifs?.length;
  const [attachmentsExiting, setAttachmentsExiting] = useState(false);
  const [hadAttachments, setHadAttachments] = useState(hasAttachments);
  if (hadAttachments !== hasAttachments) {
    setHadAttachments(hasAttachments);
    setAttachmentsExiting(!hasAttachments);
  }
  if (attachmentsExiting && editing.target) setAttachmentsExiting(false);
  const context = (
    <div className={styles.composerContext}>
      {!cached && !submission && (
        <TypingIndicator
          audience="humans"
          session={session}
          channelId={channelId}
          threadRootId={threadRootId}
        />
      )}
      {host && extensions?.accessories && (
        <ComposerAccessories
          registry={extensions.accessories}
          session={host}
          scope={scope}
          channelId={channelId}
          threadRootId={threadRootId}
          canOpen={(target) => canOpenLink?.(target) ?? false}
          open={(target) => onOpenLink?.(target) ?? false}
        />
      )}
    </div>
  );
  // Several agents show as avatars that remove on hover, ahead of the
  // toolbar's agent menu; one stays, since a message always goes to someone.
  const severalAddressed = routing && addressed.length > 1;
  const renderLeadingTools = (tools: ReactNode) => (
    <>
      <div
        className={styles.composerLeadingTools}
        data-recipients={
          (routing ? severalAddressed : !!value.recipients.length) || undefined
        }
      >
        {severalAddressed && (
          <RecipientAvatars
            session={session}
            recipients={addressed}
            mentions={!!recipients.length}
            disabled={editingDisabled}
            remove={(pubkey) => {
              const person = addressed.find((item) => item.pubkey === pubkey);
              if (!person) return;
              audience?.toggle(person);
              // The removed avatar took focus with it; typing resumes in the draft.
              input.current?.focus();
            }}
          />
        )}
        {tools}
        {!routing && !!value.recipients.length && (
          <RecipientAvatars
            session={session}
            recipients={value.recipients}
            mentions
            disabled={editingDisabled}
            remove={(pubkey) => input.current?.removeRecipient(pubkey)}
          />
        )}
      </div>
      {canAttach && (
        <>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-label="Choose attachments"
            onChange={(event) => {
              const ids = attachFiles(
                Array.from(event.currentTarget.files ?? []),
              );
              if (ids?.length)
                pickerFocus.current = { ids, owner: document.activeElement };
              event.currentTarget.value = "";
            }}
          />
          <IconButton
            hint="familiar"
            size="sm"
            type="button"
            aria-label="Attach files"
            title="Attach files"
            disabled={editingDisabled || !!editing.target}
            onClick={() => picker.current?.click()}
            icon={<PaperclipIcon size={16} />}
          />
        </>
      )}
    </>
  );
  if (readingOnly)
    return (
      <>
        {context}
        <footer className={styles.composer} data-composer-surface="">
          This relay connection supports reading only.
        </footer>
      </>
    );
  return (
    <SelectedMentionContext.Provider value={value.recipients}>
      {context}
      {active && bringing.dialog}
      {active && nonmembers.dialog}
      {active && oldAgents.dialog}
      {active && linkSharing.dialog}
      {!submission && !threadRootId && host && (
        <QueuedFollowUps
          session={host}
          channelId={channelId}
          disabled={disabled || !active}
          focusComposer={() => input.current?.focus()}
        />
      )}
      <form
        ref={form}
        className={styles.composer}
        data-composer-surface=""
        data-chat-presentation={chatPresentation || undefined}
        data-file-drag={dragging || undefined}
        data-editing={!!editing.target || undefined}
        data-conversation-controls={
          (active && !editing.target && !!trailingTool) || undefined
        }
        data-attachments={
          (!editing.target && (hasAttachments || attachmentsExiting)) ||
          undefined
        }
        onKeyDown={(event) => {
          if (
            editing.target &&
            event.key === "Escape" &&
            !event.defaultPrevented &&
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229 &&
            !completion.composing.current
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (!editing.busy) editing.close();
          }
        }}
        onPasteCapture={(event) => {
          const files = Array.from(event.clipboardData.items)
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
          if (!files.length) return;
          event.preventDefault();
          event.stopPropagation();
          attachFiles(files);
        }}
        aria-label={
          editing.target
            ? "Edit message"
            : threadRootId
              ? "Reply to thread"
              : `Send a message to ${channelName}`
        }
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <label className="sr-only" htmlFor={inputId}>
          {label}
        </label>
        {active && extensions?.completions && (
          <ComposerCompletions
            registry={extensions.completions}
            editor={completion}
            input={input}
            session={session}
            scope={scope}
            channelId={channelId}
            threadRootId={threadRootId}
            inviteAgents={agentChoices && !editing.target}
            replace={replaceCompletion}
            resolved={value}
          />
        )}
        <BackgroundUploadStatus session={session} focusTarget={input} />
        {dragging && <FileDropOverlay composer={form} />}
        {attachmentError && (
          <ToastNotice
            title="Could not attach file"
            description={attachmentError}
            onDismiss={() => setAttachmentError(undefined)}
          />
        )}
        <ComposerContext key={editing.target ? "edit" : "reply"}>
          {editing.target ? (
            <div className={styles.replyContext}>
              <PencilSimpleIcon size={18} aria-hidden="true" />
              <div>Editing message</div>
              <IconButton
                type="button"
                size="sm"
                aria-label={editing.locked ? "Close edit" : "Cancel edit"}
                disabled={editing.busy}
                onClick={editing.close}
                icon={<XIcon size={16} aria-hidden="true" />}
              />
            </div>
          ) : (
            replyContext
          )}
        </ComposerContext>
        <div className={styles.composerContent}>
          {!editing.target && (
            <ComposerAttachments
              media={session.media}
              renderers={extensions?.attachments}
              items={attachments.items}
              gifs={gifs?.map((markdown) => ({
                markdown,
                // The alt text names the tile even when its media is unavailable.
                title: markdown.slice(2, markdown.indexOf("](")) || "GIF",
                source: draftGif(markdown, session.media)?.source,
              }))}
              removeGif={(markdown) => {
                saveDraft({
                  ...valueRef.current,
                  gifs:
                    valueRef.current.gifs?.filter(
                      (item) => item !== markdown,
                    ) ?? [],
                });
                input.current?.focus();
              }}
              disabled={editingDisabled}
              onExitComplete={() => setAttachmentsExiting(false)}
              remove={(id) => {
                const item = attachments.items.find(
                  (candidate) => candidate.id === id,
                );
                attachments.store.remove(id);
                if (item?.status === "error" && item.error === error)
                  setError(undefined);
                input.current?.focus();
              }}
              retry={(id) => {
                const item = attachments.items.find(
                  (candidate) => candidate.id === id,
                );
                attachments.store.retry(id);
                if (item?.status === "error" && item.error === error)
                  setError(undefined);
              }}
            />
          )}
          <ComposerChatCards
            cards={chatCards ?? []}
            session={session}
            scope={scope}
            channelId={channelId}
            extensions={extensions}
            disabled={editingDisabled}
            remove={(index) => {
              saveDraft({
                ...valueRef.current,
                chatCards:
                  valueRef.current.chatCards?.filter((_, i) => i !== index) ??
                  [],
              });
              input.current?.focus();
            }}
          />
          <div className={styles.composerInput}>
            <RichComposerInput
              ref={input}
              id={inputId}
              disabled={editingDisabled}
              value={draft}
              draft={editorDraft}
              session={session}
              scope={scope}
              channelId={channelId}
              extensions={extensions}
              emoji={emojiCatalog.entries}
              onPasteTooLong={() => setPasteTooLong(true)}
              aria-describedby={
                pasteTooLong ? `${inputId}-paste-error` : undefined
              }
              onDraftChange={(next) => {
                setPasteTooLong(false);
                const textChanged = next.text !== valueRef.current.text;
                // The default tag's prefill shows without being saved.
                if (seeding.current) {
                  saveDraft(next, false);
                  return;
                }
                if (!editing.target) {
                  // The user's edit settles the seed on screen, as settled
                  // evidence does: clearing it lasts until the composer is
                  // shown again, while a newer message of the viewer's, sent
                  // elsewhere, still seeds.
                  if (seedSource) seedApplied.current = seedKey(seedSource);
                  automaticTag.current = undefined;
                }
                saveDraft(next);
                completion.observe(true);
                if (textChanged && next.text.trim()) notifyTyping();
              }}
              onFormatsChange={setActiveFormats}
              onEditLink={setLinkEdit}
              // Pasted identity links notify admitted recipients under their
              // current names; edits never add recipients. Send still asks
              // before adding someone outside the channel.
              acceptRecipient={(pubkey) =>
                editing.target
                  ? null
                  : pastedMentionRecipient(
                      session,
                      channelId,
                      pubkey,
                      agentChoices,
                      mentionRoster,
                    )
              }
              data-single-emoji={largeEmojiDraft || undefined}
              data-emoji-images-only={
                (largeEmojiDraft &&
                  /^\s*(?::[a-z0-9_-]{1,64}:\s*)+$/i.test(draft)) ||
                undefined
              }
              // Choosing this conversation's tab resumes typing here.
              data-tab-focus=""
              maxLength={Math.max(
                0,
                16000 -
                  [...(chatCards ?? []), ...(gifs ?? [])].reduce(
                    (size, card) => size + card.length + 2,
                    0,
                  ),
              )}
              aria-label={label}
              placeholder={placeholder ?? label}
              onFocus={() => {
                hasFocused.current = true;
                completion.observe(true);
              }}
              onBlur={() => {
                completion.invalidate();
              }}
              onSelect={() => {
                completion.observe();
              }}
              onCompositionStart={() => {
                completion.composing.current = true;
                completion.invalidate();
              }}
              onCompositionEnd={() => {
                completion.composing.current = false;
                completion.observe(true);
              }}
              onKeyDown={(event) => {
                if (
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229 ||
                  completion.composing.current
                )
                  return;
                if (
                  event.shiftKey &&
                  ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
                ) {
                  completion.invalidate();
                  return;
                }
                if (completion.keys.current?.(event)) return;
                if (
                  event.key === "ArrowUp" &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.repeat &&
                  !event.defaultPrevented &&
                  !editingDisabled &&
                  !editDisabled &&
                  !submission &&
                  !editing.target &&
                  ((event.currentTarget.value === "" &&
                    !valueRef.current.recipients.length) ||
                    automaticTag.current ===
                      JSON.stringify(valueRef.current)) &&
                  !valueRef.current.chatCards?.length &&
                  !valueRef.current.gifs?.length &&
                  !attachments.items.length
                ) {
                  // Like Slack, Up selects the newest message; E edits it.
                  // ⌘↑ and surfaces without a selectable list keep Up-to-edit.
                  if (
                    !event.metaKey &&
                    selectNewestMessage(editScope?.list.current)
                  ) {
                    event.preventDefault();
                    return;
                  }
                  const target = lastEditableMessage(session, editableRows());
                  if (target) {
                    event.preventDefault();
                    startEdit(target);
                  }
                  return;
                }
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey
                ) {
                  event.preventDefault();
                  // Holding Enter must not send after an empty list item exits.
                  if (event.repeat) return;
                  if (
                    activeFormats.includes("bullet_list") ||
                    activeFormats.includes("ordered_list")
                  ) {
                    event.currentTarget.insertLineBreak();
                    return;
                  }
                  send();
                }
              }}
            />
          </div>
        </div>
        {!editing.target &&
          threadRootId &&
          mediaTimeSeconds !== undefined &&
          !hideMediaTimeIndicator && (
            <div className={styles.mediaComposerAnchor}>
              <span>Commenting at {formatMediaTime(mediaTimeSeconds)}</span>
              <IconButton
                size="compact"
                type="button"
                onClick={clearMediaTime}
                aria-label="Remove video time"
                icon={<XIcon size={13} />}
              />
            </div>
          )}
        {voice.element}
        <div className={styles.composerActions} hidden={voice.capturing}>
          <div className={styles.composerToolRow}>
            {active && (
              <ComposerFormattingTools
                disabled={editingDisabled}
                singleRow={chatPresentation || !!trailingTool}
                // Conversation controls (Berd's project) follow the tools.
                trailing={!editing.target ? trailingTool : undefined}
                activeFormats={activeFormats}
                toggleFormat={(format) => input.current?.toggleFormat(format)}
                editLink={() => {
                  const edit = input.current?.editLink();
                  if (edit) setLinkEdit(edit);
                }}
              >
                {extensions ? (
                  <ComposerTools
                    registry={extensions.tools}
                    {...(canAttach && !editing.target
                      ? { capture: voice.begin }
                      : {})}
                    renderLeading={renderLeadingTools}
                    session={session}
                    scope={scope}
                    channelId={channelId}
                    threadRootId={threadRootId}
                    disabled={editingDisabled}
                    inviteAgents={agentChoices && !editing.target}
                    recipients={recipients}
                    audience={audience}
                    insertText={(text) => attachGif(text) ?? insert(text)}
                    insertMention={insertMention}
                    insertMentions={insertMentions}
                    replaceRecipients={replaceRecipients}
                    replaceRecipientsIfEmpty={replaceRecipientsIfEmpty}
                    insertResource={insertResource}
                    focus={() => input.current?.focus()}
                  />
                ) : (
                  renderLeadingTools(null)
                )}
              </ComposerFormattingTools>
            )}
            {active &&
              !editing.target &&
              (!submission || ownSoloConversation) &&
              !!addressedKeys.length && (
                <ComposerModels
                  profiles={session.profiles}
                  media={session.media}
                  pubkeys={addressedKeys}
                  value={picks}
                  disabled={editingDisabled || pickReadFailed}
                  resettable={stickyPicks}
                  explicitOnly={!!submission && stickyPicks}
                  onChange={changePicks}
                  onResolved={(next, error) => {
                    resolvedPicks.current =
                      next === undefined
                        ? undefined
                        : {
                            source: picksSnapshot,
                            pubkeys: addressedKeys,
                            value: next,
                            error,
                          };
                  }}
                  onRetryInventory={() => void session.agentChoices.refresh()}
                  startsThread={startsThread}
                  place={sessionPlace}
                />
              )}
            <IconButton
              variant={
                draft.trim() ||
                chatCards?.length ||
                gifs?.length ||
                attachments.items.length
                  ? "primary"
                  : "ghost"
              }
              size="toolbar"
              type="submit"
              style={editing.target ? undefined : accentButtonStyle}
              aria-label={editing.target ? "Save changes" : "Send message"}
              title={
                editing.target
                  ? "Save changes"
                  : compacting
                    ? "Wait for compaction to finish, or interrupt it."
                    : untagged
                      ? recipientHint
                      : "Send message"
              }
              focusableWhenDisabled={
                untagged || (!editing.target && compacting) || undefined
              }
              disabled={
                disabled ||
                untagged ||
                (!editing.target && compacting) ||
                (!editing.target && (!!accepted || conflict || sendPending)) ||
                (!!editing.target && (editing.locked || editDisabled)) ||
                admitting ||
                sending ||
                submission?.disabled ||
                (!editing.target && attachments.blocked) ||
                (!draft.trim() &&
                  !chatCards?.length &&
                  ((!!submission && !submission.allowAttachmentOnly) ||
                    (!attachments.items.length && !gifs?.length)) &&
                  !(
                    editing.target &&
                    requestDeletion &&
                    session.outbox?.supports(5)
                  ))
              }
              icon={<ArrowUpIcon size={16} />}
            />
          </div>
        </div>
        {!editing.target && compacting && (
          <p className={styles.composerStatus} role="status">
            Compacting session…
          </p>
        )}
        {pasteTooLong && (
          <p id={`${inputId}-paste-error`} role="alert">
            This paste would make your message too long.{" "}
            {canAttach && !editing.target
              ? "Shorten it or attach the text as a file."
              : "Shorten the text and try again."}
          </p>
        )}
        {(error || editing.error) && (
          <p role="alert">{error ?? editing.error}</p>
        )}
        {pickReadFailed && (
          <div>
            <p role="alert">
              Could not read saved model and effort for this chat on this
              device. Retry before sending.
            </p>
            <Button type="button" onClick={refreshPicks}>
              Retry saved choices
            </Button>
          </div>
        )}
        {pickStorageFailed && (
          <p role="alert">
            Could not save model and effort for this chat on this device. The
            current choices remain until this composer closes.
          </p>
        )}
        {!editing.target &&
          !submission &&
          (accepted || conflict || storageFailed) && (
            <div>
              <p role="alert">
                {accepted
                  ? "Message accepted. Could not update the saved draft. Retry cleanup before sending again."
                  : conflict
                    ? "This draft changed elsewhere. Your edits are kept here; choose which draft to keep."
                    : "Could not save this draft on this device. Your edits are kept here."}
              </p>
              {accepted ? (
                <Button type="button" onClick={() => finishDraft(accepted)}>
                  Retry draft cleanup
                </Button>
              ) : conflict ? (
                <>
                  <Button type="button" onClick={() => resolveDraft(false)}>
                    Load saved draft
                  </Button>
                  <Button type="button" onClick={() => resolveDraft(true)}>
                    Keep my draft
                  </Button>
                </>
              ) : (
                <Button type="button" onClick={() => persist(valueRef.current)}>
                  Retry draft save
                </Button>
              )}
            </div>
          )}
        {editing.retryable && (
          <>
            <p role="status">Your edit is still in the outbox.</p>
            <Button
              type="button"
              disabled={editDisabled}
              onClick={editing.retry}
            >
              Retry edit
            </Button>
          </>
        )}
        {(error || editing.error) && emojiCatalog.status === "error" && (
          <Button
            type="button"
            disabled={editingDisabled}
            onClick={() => {
              void session.emoji.refresh().then(() => {
                if (
                  input.current?.isConnected &&
                  session.emoji.snapshot().status === "ready"
                ) {
                  setError(undefined);
                  editing.clearError();
                }
              });
            }}
          >
            Retry message preparation
          </Button>
        )}
      </form>
      {active && linkEdit && (
        <ComposerLinkDialog
          edit={linkEdit}
          input={input}
          finalFocus={() => (permitted.current ? input.current : false)}
          disabled={editingDisabled}
          close={() => setLinkEdit(null)}
        />
      )}
    </SelectedMentionContext.Provider>
  );
}

/** Retain the last preview for collapse; context semantics clear immediately. */
function ComposerContext({ children }: { children: ReactNode }) {
  const open = !!children;
  const [lastContext, setLastContext] = useState(children);
  if (open && children !== lastContext) setLastContext(children);
  return (
    <div
      className={styles.composerReplySlot}
      data-open={open || undefined}
      inert={!open}
      aria-hidden={!open || undefined}
    >
      <div className={styles.composerReplyClip}>
        <div className={styles.composerReplyContent}>
          {open ? children : lastContext}
        </div>
      </div>
    </div>
  );
}

/** Presentation stays host-owned even when the optional mention tool is disabled. */
function RecipientAvatars({
  session,
  recipients,
  mentions,
  disabled,
  remove,
}: {
  session: ComposerSession | RelaySession;
  recipients: readonly MentionRecipient[];
  /** Whether these come from mentions in the text, or the agents menu. */
  mentions: boolean;
  disabled: boolean;
  remove(pubkey: string): void;
}) {
  const reduceMotion = useReducedMotion();
  const enter = useCallback(
    (node: HTMLButtonElement | null) => {
      if (
        !node ||
        document.documentElement.hasAttribute("data-keyboard-navigation") ||
        reduceMotion
      )
        return;
      const animation = animate(
        node,
        { transform: ["scale(0.9)", "scale(1)"] },
        { type: "spring", duration: 0.24, bounce: 0.15 },
      );
      return () => animation.stop();
    },
    [reduceMotion],
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const unique = [
    ...new Map(recipients.map((item) => [item.pubkey, item])).values(),
  ];
  return (
    <section
      className={styles.mentionRecipients}
      aria-label={mentions ? "Explicit mentions" : "Sending to"}
    >
      {unique.map((recipient) => {
        const profile = profiles.get(recipient.pubkey);
        return (
          <IconButton
            key={recipient.pubkey}
            type="button"
            size="toolbar"
            ref={enter}
            data-mention-recipient=""
            data-avatar-shape={
              agentPubkeys.has(recipient.pubkey) ? "squircle" : "circle"
            }
            title={`Remove ${mentions ? "explicit mention of " : ""}${recipient.name} (${recipient.pubkey.slice(0, 8)})`}
            aria-label={`Remove ${mentions ? "mention" : "agent"} ${recipient.name} ${recipient.pubkey}`}
            disabled={disabled}
            onClick={() => remove(recipient.pubkey)}
            icon={
              <span
                className={styles.mentionRecipientArtwork}
                data-avatar-shape={
                  agentPubkeys.has(recipient.pubkey) ? "squircle" : "circle"
                }
                aria-hidden="true"
              >
                <Avatar
                  alt=""
                  fallback={recipient.name}
                  src={avatarMedia(profile?.picture, session.media)}
                  size="small"
                  shape={
                    agentPubkeys.has(recipient.pubkey) ? "squircle" : "circle"
                  }
                />
                <span className={styles.mentionRecipientRemove}>
                  <XIcon size={16} />
                </span>
              </span>
            }
          />
        );
      })}
    </section>
  );
}
