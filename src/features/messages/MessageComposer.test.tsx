// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { PluginRuntime } from "../../plugins/runtime";
import { ConversationService } from "../conversation/service";
import * as emojiPlugin from "../../bundled/emoji";
import { File as NodeFile } from "node:buffer";
import { createMemberAdditions } from "../channel-members/operations";
import { addChannelMember } from "../channel-members/members";
import "@testing-library/jest-dom/vitest";
import { mentionHistory } from "./mention-history";
import {
  composerDOMFixture,
  longMentionDraft,
  longRichDraft,
  pasteRichDraft,
  placeholderPeople,
  typedDraft,
} from "./composer-testing";
import { bindNames } from "../identity-names/service";
import { createAgentDirectory } from "../identity-names/testing";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useLayoutEffect } from "react";
import { createRecovery } from "../relay/recovery";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerCompletion,
  ComposerCompletionProps,
  ComposerTool,
  ComposerToolProps,
  CompletionPending,
  CompletionResolution,
  CompletionResult,
  InlineRenderer,
} from "../conversation/contracts";
import { MENTION_RESOLVE_TIMEOUT_MS } from "../conversation/completion";
import { mentionQuery } from "../../bundled/mentions/mention-query";
import { MentionCompletion } from "../../bundled/mentions/MentionCompletion";
import type { MentionRecipient } from "./mention-draft";
import type { AgentLibrarySnapshot } from "../agents/library";
import { createAgentChoices } from "../agents/choices";
import type { LocalAgents } from "../agents/local";
import { localAgentsFixture } from "../agents/local-testing";
import { UploadError, UPLOAD_FAILURES } from "../relay/attachments";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import type { Outbox, OutgoingEvent } from "../relay/outbox";
import { createMessages } from "../relay/messages";
import { ClaudeProcess } from "../../bundled/claude-code/claude";
import { fakeSpawn } from "../../bundled/claude-code/claude-testing";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
import { AgentsContext } from "../agents/react";
import type { Agents, Models } from "../agents/service";
import { MessageComposer, type MessageComposerProps } from "./MessageComposer";
import { MessageMarkdown } from "./MessageMarkdown";
import { InlineChip } from "../../shared/design-system/ui/InlineChip";
import { MessageEditScope, useMessageEditScope } from "./MessageEditScope";
import { registerMessageList } from "./message-selection";
import { createRelaySession, type RelaySession } from "../relay/session";
import { keypair, metadata, roster, signed } from "../relay/testing";
import type { EventTemplate } from "nostr-tools";
import type { RelayEvent } from "../relay/events";
import type {
  ChannelMessage,
  ChannelSummary,
  Profile,
} from "../relay/contracts";
import { readView, viewRevision, writeView } from "../../shared/view-state";
import { followupDraft } from "./mention-draft";
import { emojiMatches, type CustomEmoji } from "../relay/emoji";
import { CustomEmoji as CustomEmojiImage } from "../../bundled/emoji/CustomEmoji";
import { EmojiCompletion } from "../../bundled/emoji/EmojiCompletion";
import * as emojiSearch from "../../bundled/emoji/emoji-search";
import type { EmojiSnapshot } from "../relay/emoji-directory";
import { emojiQuery } from "../../bundled/emoji/emoji-query";
import type { ComposerInputElement } from "./composer-dom";
import { profileTarget } from "../profiles/target";
import { fromMarkdown } from "mdast-util-from-markdown";
import { setRememberAgentsPreference } from "./mention-preferences";
import { setDefaultAgent } from "../solo/default-agent";
import { ResourcePicker } from "../../bundled/repos/ResourcePicker";
import { entityHref } from "../repos/routes";
import type { Entity, RepositoryHome } from "../repos/destinations";
import { HELPFUL_HINT_REST_MS } from "../../shared/design-system/ui/hoverIntent";

// Pass-through spies: the real renderers run; tests count chip redraws.
vi.mock("./MessageMarkdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./MessageMarkdown")>();
  return { ...actual, MessageMarkdown: vi.fn(actual.MessageMarkdown) };
});
vi.mock("../../shared/design-system/ui/InlineChip", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../shared/design-system/ui/InlineChip")
    >();
  return { ...actual, InlineChip: vi.fn(actual.InlineChip) };
});

composerDOMFixture();

const owners: ReturnType<typeof createRelaySession>[] = [];

const first = { pubkey: "a".repeat(64), name: "Honey" };
const noArchives = Object.freeze({ status: "ready" as const, archived: [] });
const firstArchived = Object.freeze({
  status: "ready" as const,
  archived: [first.pubkey],
});
const second = { pubkey: "b".repeat(64), name: "Honey" };
/** The mounted channel listed as a Solo chat. */
const soloList = {
  status: "ready" as const,
  channels: [
    {
      id: "channel",
      channelType: "solo" as const,
      members: [first.pubkey, second.pubkey],
    },
  ],
};
/** What every send saves for its key; remembered agents are not a draft. */
const emptied = { text: "", recipients: [] };
/** The message the fixture send ("channel-id") started, as ThreadPanel supplies
 * the viewer's latest message in that thread. */
const startedSeed = (mentions: readonly string[]) =>
  editableMessage({ id: "channel-id", mentions });
const resourceOwner = "c".repeat(64);
const resourceRoute = {
  type: "issue",
  owner: resourceOwner,
  dtag: "game",
  id: "d".repeat(64),
} as const;
const resource = { uri: entityHref(resourceRoute), label: "Fix login" };

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _name: string,
        options: unknown,
        callback?: (lock: unknown) => unknown,
      ) => (callback ? callback({}) : (options as () => unknown)()),
    },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  Reflect.deleteProperty(navigator, "locks");
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

const localAgent = {
  pubkey: "ab".repeat(32),
  name: "Fixture agent",
  relayUrl: "wss://relay.example.test",
  owner: "d".repeat(64),
};

function mount(
  options: Partial<MessageComposerProps> = {},
  control?: LocalAgents,
  viewer?: string,
  agents?: Agents,
) {
  let commands: ComposerToolProps;
  const completionRequests: ComposerCompletionProps["publish"][] = [];
  function Completion({ publish }: ComposerCompletionProps) {
    useLayoutEffect(() => {
      completionRequests.push(publish);
    }, [publish]);
    return null;
  }
  const completionListeners = new Set<() => void>();
  const completion = (revision: string): Contribution<ComposerCompletion> => ({
    id: "delayed",
    key: "test/delayed",
    pluginId: "test",
    revision,
    title: "Delayed",
    match: ({ text, start }) =>
      text.startsWith("!") && start > 0
        ? { start: 0, end: start, query: text.slice(1, start) }
        : null,
    component: Completion,
  });
  let completions: readonly Contribution<ComposerCompletion>[] = [
    completion("1"),
  ];
  function Tool(props: ComposerToolProps) {
    useLayoutEffect(() => {
      commands = props;
    });
    return (
      <>
        <button type="button" onClick={() => props.insertMention(first)}>
          First Honey
        </button>
        <button type="button" onClick={() => props.insertMention(second)}>
          Second Honey
        </button>
        {props.audience && (
          // Stands in for the picker's pill: same name, same audience contract.
          <output
            aria-label={`Sending to ${props.audience.recipients
              .map((person) => person.name)
              .join(", ")}. Change agents`}
          />
        )}
      </>
    );
  }
  const tools: readonly Contribution<ComposerTool>[] = [
    {
      id: "fixture",
      key: "test/fixture",
      pluginId: "test",
      revision: "1",
      title: "Fixture tools",
      component: Tool,
    },
  ];
  const emojiListeners = new Set<() => void>();
  let emoji: Pick<EmojiSnapshot, "status" | "entries"> = {
    status: "ready",
    entries: [],
  };
  const outboxListeners = new Set<() => void>();
  let pending: readonly OutgoingEvent[] = [];
  let rows: readonly ChannelMessage[] = [];
  let history: "idle" | "loading" | "ready" = "ready";
  const rowListeners = new Set<() => void>();
  const setPending = (next: readonly OutgoingEvent[]) => {
    pending = next;
    for (const listener of outboxListeners) listener();
  };
  const messages = {
    edit: vi.fn<RelaySession["messages"]["edit"]>((id, content) => {
      setPending([
        {
          event: {
            id: "edit-id",
            kind: 40003,
            pubkey: first.pubkey,
            created_at: 100,
            content,
            tags: [
              ["h", "channel"],
              ["e", id],
            ],
          },
          delivery: "sending",
        },
      ]);
      return "edit-id";
    }),
    send: vi.fn<RelaySession["messages"]["send"]>(() => "channel-id"),
    reply: vi.fn<RelaySession["messages"]["reply"]>(() => "reply-id"),
  };
  const typing: ReturnType<RelaySession["typing"]["snapshot"]> = [];
  let profiles: ReadonlyMap<string, Profile> = new Map();
  const profileListeners = new Set<() => void>();
  const libraryListeners = new Set<() => void>();
  let library: AgentLibrarySnapshot = {
    status: "ready",
    identities: [],
    definitions: [],
  };
  const channelList = {
    status: "ready" as const,
    channels: [{ id: "channel", members: [first.pubkey, second.pubkey] }],
  };
  const rawSession = {
    // Full-session fixture; the detached editor intentionally omits this capability.
    unread: undefined,
    viewer,
    messages,
    typing: { snapshot: () => typing, subscribe: () => () => {} },
    profiles: {
      snapshot: () => profiles,
      subscribe(listener: () => void) {
        profileListeners.add(listener);
        return () => {
          profileListeners.delete(listener);
        };
      },
      ensure: vi.fn(async () => {}),
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe(listener: () => void) {
        libraryListeners.add(listener);
        return () => libraryListeners.delete(listener);
      },
      refresh: vi.fn(async () => {}),
      retain: () => () => {},
    },
    emoji: {
      snapshot: () => emoji,
      subscribe(listener: () => void) {
        emojiListeners.add(listener);
        return () => {
          emojiListeners.delete(listener);
        };
      },
      ensure: vi.fn(() => Promise.resolve()),
      refresh: vi.fn(() => Promise.resolve()),
    },
    media: (url: string) => url,
    outbox: {
      ready: async () => {},
      recovery: async (key: string) =>
        pending.find((item) => item.recovery?.key === key),
      recover: async (
        _id: string,
        _recovery: unknown,
        consume?: () => void,
      ) => {
        consume?.();
      },
      acknowledge: async () => {},
      observeDismiss: () => () => {},
      supports: () => true,
      snapshot: () => pending,
      subscribe(listener: () => void) {
        outboxListeners.add(listener);
        return () => outboxListeners.delete(listener);
      },
      retry: vi.fn((id: string) =>
        setPending(
          pending.map((item) =>
            item.event.id === id
              ? { ...item, delivery: "sending", error: undefined }
              : item,
          ),
        ),
      ),
    },
    channels: {
      window: () => ({ rows, status: history }),
      subscribeWindow(_id: string, listener: () => void) {
        rowListeners.add(listener);
        return () => rowListeners.delete(listener);
      },
      list: () => channelList,
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  const session = {
    ...rawSession,
    names: bindNames(rawSession, {
      snapshot: () => [createAgentDirectory()],
      subscribe: () => () => {},
    }),
  };
  const onSend = vi.fn();
  const inline: readonly Contribution<InlineRenderer>[] = [
    {
      id: "emoji",
      key: "test/emoji",
      pluginId: "test",
      revision: "1",
      title: "Emoji",
      matches: ({ text, message }) => [
        ...emojiMatches(text, message.emoji ?? []),
      ],
      component: ({ text, content, media }) => {
        const entry = content.message.emoji?.find(
          (entry) => `:${entry.shortcode}:` === text.toLowerCase(),
        );
        return entry ? <CustomEmojiImage emoji={entry} media={media} /> : text;
      },
    },
  ];
  let props: Omit<MessageComposerProps, "session"> & { session: RelaySession } =
    {
      session,
      onSend,
      scope: "scope",
      channelId: "channel",
      channelName: "General",
      extensions: {
        tools: { snapshot: () => tools, subscribe: () => () => {} },
        inline: { snapshot: () => inline, subscribe: () => () => {} },
        completions: {
          snapshot: () => completions,
          subscribe(listener) {
            completionListeners.add(listener);
            return () => completionListeners.delete(listener);
          },
        },
      },
      ...options,
    } as Omit<MessageComposerProps, "session"> & { session: RelaySession };
  const bindChoices = () => {
    const library = props.session.agentLibrary;
    props = {
      ...props,
      session: {
        ...props.session,
        scope: props.scope,
        agentChoices: createAgentChoices({
          scope: props.scope,
          library: { ...library, retain: () => () => {} },
          native: control,
          signal: new AbortController().signal,
        }),
      },
    };
  };
  bindChoices();
  let presented = true;
  const tree = () => (
    <AgentsContext.Provider value={agents}>
      <ConversationPresentation value={presented}>
        <div hidden={!presented} inert={!presented}>
          <MessageComposer {...props} />
        </div>
      </ConversationPresentation>
    </AgentsContext.Provider>
  );
  const view = render(tree(), {
    reactStrictMode: true,
  });
  const input = () =>
    within(view.container).getByRole<ComposerInputElement>("textbox");
  return {
    ...view,
    input,
    messages,
    present(active: boolean) {
      presented = active;
      view.rerender(tree());
    },
    setRows(next: readonly ChannelMessage[]) {
      act(() => {
        rows = next;
        for (const listener of rowListeners) listener();
      });
    },
    setHistory(next: typeof history) {
      act(() => {
        history = next;
        for (const listener of rowListeners) listener();
      });
    },
    setDelivery(delivery: OutgoingEvent["delivery"]) {
      act(() =>
        setPending(
          pending.map((item) => ({
            ...item,
            delivery,
            error:
              delivery === "failed" ? "Relay rejected this edit" : undefined,
          })),
        ),
      );
    },
    onSend,
    session: props.session,
    emojiListeners,
    user: userEvent.setup(),
    commands: () => commands,
    completionRequests,
    publish(index: number, text = "chosen") {
      const request = completionRequests[index];
      if (!request) throw new Error("No observed completion request");
      const result: CompletionResult = {
        items: [{ id: text, label: text, edit: { text } }],
      };
      let published: ReturnType<ComposerCompletionProps["publish"]> = false;
      act(() => {
        published = request(result);
      });
      return published;
    },
    replaceCompletionProvider(pluginId = "test") {
      act(() => {
        completions = [{ ...completion("2"), pluginId }];
        for (const listener of completionListeners) listener();
      });
    },
    retarget(
      next: Partial<
        Omit<MessageComposerProps, "session"> & { session: RelaySession }
      >,
    ) {
      const changedSession =
        (next.session !== undefined && next.session !== props.session) ||
        (next.scope !== undefined && next.scope !== props.scope);
      props = { ...props, ...next };
      if (changedSession) bindChoices();
      view.rerender(tree());
    },
    setProfiles(next: ReadonlyMap<string, Profile>) {
      act(() => {
        profiles = next;
        for (const listener of profileListeners) listener();
      });
    },
    setLibrary(
      identities: AgentLibrarySnapshot["identities"],
      status: AgentLibrarySnapshot["status"] = "ready",
    ) {
      act(() => {
        library = { ...library, identities, status };
        for (const listener of libraryListeners) listener();
      });
    },
    setEmoji(
      entries: readonly CustomEmoji[],
      status: EmojiSnapshot["status"] = "ready",
    ) {
      act(() => {
        emoji = { status, entries };
        for (const listener of emojiListeners) listener();
      });
    },
    fill(text: string) {
      const field = input();
      act(() => {
        field.focus();
        field.value = text;
        field.setSelectionRange(text.length, text.length);
      });
      fireEvent.input(field);
      // Browsers queue selectionchange after the editor restores its native
      // selection. Deliver that boundary explicitly in this synchronous fixture.
      fireEvent(document, new Event("selectionchange"));
    },
    submit() {
      fireEvent.submit(within(view.container).getByRole("form"));
    },
  };
}

it.each([undefined, "thread-root"])(
  "shows only human typing above the composer in scope %s",
  (threadRootId) => {
    const scope = threadRootId ? { threadRootId } : {};
    const h = mount(scope);
    const human = "c".repeat(64);
    h.setProfiles(
      new Map([
        [human, { name: "Sam" }],
        [first.pubkey, { name: "Assistant", isAgent: true }],
      ]),
    );
    const entries = [
      { pubkey: human, channelId: "channel", ...scope },
      { pubkey: first.pubkey, channelId: "channel", ...scope },
      {
        pubkey: second.pubkey,
        channelId: "channel",
        threadRootId: "another-thread",
      },
    ];
    h.retarget({
      session: {
        ...h.session,
        typing: { ...h.session.typing, snapshot: () => entries },
      },
    });
    const status = within(h.container).getByRole("status", {
      name: "Conversation activity",
    });
    expect(status).toHaveTextContent(/^Assistant is working\. Sam is typing$/);
    expect(
      within(h.container).getByText("Sam is typing", {
        selector: "span[aria-hidden] span",
      }),
    ).toBeVisible();
    expect(
      within(h.container).queryByRole("button", { name: /Activity:/ }),
    ).toBeNull();
  },
);

it("publishes typing for text edits but not caret-driven token expansion", () => {
  const text = `[Honey](${profileTarget(first.pubkey)})`;
  writeView("scope", "draft:channel", text);
  const h = mount();
  const send = vi.fn(async () => {});
  h.retarget({
    session: { ...h.session, typing: { ...h.session.typing, send } },
  });
  expect(h.input().querySelector("[data-source]")).not.toBeNull();
  act(() => h.input().setSelectionRange(text.length, text.length));
  fireEvent.keyDown(h.input(), { key: "ArrowLeft" });
  expect(h.input().querySelector("[data-source]")).toBeNull();
  expect(h.input()).toHaveValue(text);
  expect(send).not.toHaveBeenCalled();
  h.fill(`${text}x`);
  expect(send).toHaveBeenCalledTimes(1);
});

it("types into a long chip-heavy draft without redrawing its link chips", async () => {
  const h = mount();
  const renders = vi.mocked(MessageMarkdown);
  renders.mockClear();
  pasteRichDraft(h.input(), longRichDraft());
  expect(h.input().querySelectorAll("[data-source]")).toHaveLength(45);
  // The paste drew the chips, each as its link label.
  expect(renders).toHaveBeenCalled();
  const chip = h.input().querySelector<HTMLElement>("[data-source]");
  expect(chip?.textContent).toBe(
    chip?.dataset.source?.match(/^\[(.*)\]\(/)?.[1],
  );
  const text = h.input().value;
  const middle = text.indexOf(" bravo", text.length / 2) + 1;
  act(() => h.input().setSelectionRange(middle, middle));
  renders.mockClear();
  await h.user.keyboard("xyz");
  // The composer re-renders per keystroke to save the draft; the chips'
  // props (emoji, extensions, directory, members) must hold across it.
  expect(renders).not.toHaveBeenCalled();
  expect(h.input()).toHaveValue(
    `${text.slice(0, middle)}xyz${text.slice(middle)}`,
  );
  expect(h.input().querySelectorAll("[data-source]")).toHaveLength(45);
});

it("types into a mention-heavy draft without redrawing its recipient chips", async () => {
  const people = placeholderPeople(20);
  writeView("scope", "draft:channel", longMentionDraft(people));
  const h = mount();
  const chips = () =>
    [...h.input().querySelectorAll("[data-source] .inline-chip")].map((chip) =>
      chip.getAttribute("aria-label"),
    );
  expect(chips()).toEqual(people.map((person) => `Person ${person.name}`));
  const text = h.input().value;
  act(() => {
    h.input().focus();
    h.input().setSelectionRange(text.length, text.length);
  });
  const renders = vi.mocked(InlineChip);
  renders.mockClear();
  await h.user.keyboard("xyz");
  // Members, roster and archives feed the chip names; typing must not
  // rebuild them.
  expect(renders).not.toHaveBeenCalled();
  expect(h.input()).toHaveValue(`${text}xyz`);
  expect(chips()).toHaveLength(20);
});

it("retires reply controls immediately and preserves the draft when replying again", () => {
  const h = mount({
    replyContext: <button type="button">Cancel reply to Honey</button>,
  });
  fireEvent.change(h.input(), { target: { value: "Draft in progress" } });
  const previous = screen.getByRole("button", {
    name: "Cancel reply to Honey",
  });

  h.retarget({ replyContext: undefined });
  expect(previous.closest("[inert]")).not.toBeNull();
  expect(
    screen.queryByRole("button", { name: "Cancel reply to Honey" }),
  ).toBeNull();
  expect(h.input()).toHaveValue("Draft in progress");

  h.retarget({
    replyContext: <button type="button">Cancel reply to Wes</button>,
  });
  const current = screen.getByRole("button", { name: "Cancel reply to Wes" });
  expect(current.closest("[inert]")).toBeNull();
  expect(screen.queryByText("Cancel reply to Honey")).toBeNull();
  expect(h.input()).toHaveValue("Draft in progress");
});

it("shows a local draft in the cached composer without completion, typing or transport reads", async () => {
  const viewer = keypair(),
    relay = keypair();
  const query = vi.fn(async () => []);
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      media: () => undefined,
    },
    {
      cachedOnly: true,
      prepared: true,
      persistence: {
        readStartup: async () => ({
          discovery: {
            savedAt: Date.now(),
            relayAuthor: relay.pubkey,
            events: [
              roster(relay, "channel", [viewer.pubkey]),
              metadata(relay, "channel", "General"),
            ],
          },
        }),
        read: async () => [],
        write: async () => {},
        remove: async () => {},
        retain: async () => {},
        clear: async () => {},
        close() {},
      },
    },
  );
  await owner.restore();
  writeView("cached-composer", "draft:channel", "!Saved draft");
  const typing = vi.fn(owner.session.typing.subscribe);
  const h = mount({
    session: {
      ...owner.session,
      typing: { ...owner.session.typing, subscribe: typing },
    },
    scope: "cached-composer",
  });
  try {
    expect(h.input()).toHaveValue("!Saved draft");
    expect(h.input()).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.queryByText(/does not support sending/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.focus(h.input());
    fireEvent(document, new Event("selectionchange"));
    h.submit();
    await act(async () => {}); // Flush mounted effects before the negative assertions.
    expect(h.completionRequests).toEqual([]);
    expect(typing).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(h.input()).toHaveValue("!Saved draft");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  } finally {
    h.unmount();
    owner.dispose();
  }
});

it.each([true, false])(
  "reports focused form removal only while it owns focus (focused=%s)",
  (focused) => {
    const initial = vi.fn();
    const latest = vi.fn();
    const h = mount({ autoFocus: false, onFocusedRemoval: initial });
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      if (focused) h.input().focus();
      else outside.focus();
      h.retarget({ channelName: "Renamed", onFocusedRemoval: latest });
      expect(initial).not.toHaveBeenCalled();
      expect(latest).not.toHaveBeenCalled();
      h.unmount();
      expect(initial).not.toHaveBeenCalled();
      expect(latest).toHaveBeenCalledTimes(focused ? 1 : 0);
      if (!focused) expect(outside).toHaveFocus();
    } finally {
      h.unmount();
      outside.remove();
    }
  },
);

function archiveToastFixture() {
  const base = mount({}, undefined, first.pubkey);
  base.unmount();
  const summary = (archived = false): ChannelSummary => ({
    id: "channel",
    name: "General",
    channelType: "stream",
    members: [first.pubkey, second.pubkey],
    ...(archived ? { archived: true } : {}),
  });
  let channel = summary();
  let list = { status: "ready" as const, channels: [channel] };
  const session = {
    ...base.session,
    channels: {
      ...base.session.channels,
      get: () => channel,
      list: () => list,
    },
  };
  const row = editableMessage();
  let editScope: ReturnType<typeof useMessageEditScope>;
  function Probe() {
    editScope = useMessageEditScope();
    return null;
  }
  const tree = (shown = true) => (
    <ToastProvider>
      <MessageEditScope>
        <Probe />
        <button type="button">Outside composer</button>
        {shown && (
          <MessageComposer
            session={session}
            scope="archive-toast"
            channelId="channel"
            channelName="General"
            editMessages={[row]}
          />
        )}
      </MessageEditScope>
    </ToastProvider>
  );
  userEvent.setup();
  const view = render(tree(), { reactStrictMode: true });
  const input = () => screen.getByRole("textbox") as ComposerInputElement;
  return {
    input,
    edit() {
      act(() => editScope?.current?.(row));
    },
    fill(text: string) {
      act(() => {
        input().focus();
        input().value = text;
      });
      fireEvent.input(input());
    },
    remove(archived = true) {
      channel = summary(archived);
      list = { ...list, channels: [channel] };
      view.rerender(tree(false));
    },
    restore() {
      channel = summary();
      list = { ...list, channels: [channel] };
      view.rerender(tree());
    },
  };
}

it.each(["draft", "edit"])(
  "offers the focused archived %s text for copying and restores the saved draft",
  async (mode) => {
    const h = archiveToastFixture();
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    onTestFinished(() => write.mockRestore());
    h.fill("Saved draft");
    if (mode === "edit") {
      h.edit();
      expect(h.input()).toHaveAccessibleName("Edit message");
      h.fill("Unsent **edit**");
    }
    const text = h.input().value;
    h.remove();
    fireEvent.click(await screen.findByRole("button", { name: "Copy text" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith(text));
    expect(
      await screen.findByText("Text copied", { exact: true }),
    ).toBeVisible();
    h.restore();
    expect(h.input()).toHaveValue("Saved draft");
  },
);

it.each([
  { text: "", focused: true, archived: true },
  { text: "  \n ", focused: true, archived: true },
  { text: "Saved draft", focused: false, archived: true },
  { text: "Saved draft", focused: true, archived: false },
])(
  "does not offer text for unrelated or empty removal: %j",
  async ({ text, focused, archived }) => {
    const h = archiveToastFixture();
    h.fill(text);
    if (!focused)
      screen.getByRole("button", { name: "Outside composer" }).focus();
    h.remove(archived);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Copy text" })).toBeNull();
  },
);

it("keeps the captured text retryable when clipboard copying fails", async () => {
  const h = archiveToastFixture();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("Clipboard unavailable"))
    .mockResolvedValue(undefined);
  onTestFinished(() => write.mockRestore());
  h.fill("Keep this text");
  h.remove();
  fireEvent.click(await screen.findByRole("button", { name: "Copy text" }));
  expect(
    await screen.findByText("Couldn’t copy text", { exact: true }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  expect(write).toHaveBeenLastCalledWith("Keep this text");
  expect(await screen.findByText("Text copied", { exact: true })).toBeVisible();
});

it("a first focus request starts after the retained mention and later requests preserve selection", () => {
  writeView("scope", "draft:channel", {
    text: "@Honey existing prose",
    recipients: [{ ...first, start: 0, end: 6 }],
  });
  const h = mount({ autoFocus: false });
  act(() => h.input().setSelectionRange(0, 0));
  h.retarget({ focusRequest: 1 });
  expect(h.input()).toHaveFocus();
  expect([h.input().selectionStart, h.input().selectionEnd]).toEqual([21, 21]);
  act(() => h.input().setSelectionRange(7, 7));
  h.retarget({ channelName: "Renamed" });
  expect(h.input().selectionStart).toBe(7);
  h.retarget({ focusRequest: 2 });
  expect(h.input().selectionStart).toBe(7);
  act(() => h.input().setSelectionRange(0, 6));
  h.retarget({ focusRequest: 3 });
  expect([h.input().selectionStart, h.input().selectionEnd]).toEqual([0, 6]);
});

it("autofocuses each selected conversation once without stealing focus on updates", () => {
  const h = mount({ autoFocus: true });
  expect(h.input()).toHaveFocus();
  const other = document.createElement("button");
  document.body.append(other);
  try {
    other.focus();
    h.retarget({ channelName: "Renamed", autoFocus: false });
    h.retarget({ autoFocus: true });
    expect(other).toHaveFocus();
    h.retarget({ channelId: "another-channel" });
    expect(h.input()).toHaveFocus();
    h.retarget({ channelId: "keyboard-navigation" });
    expect(h.input()).toHaveFocus();
  } finally {
    other.remove();
  }
});

it("defers initial focus until a loading conversation enables its composer", () => {
  const h = mount({ autoFocus: true, disabled: true });
  expect(h.input()).not.toHaveFocus();
  h.retarget({ disabled: false });
  expect(h.input()).toHaveFocus();
});

it("does not mistake a later focused control for a saved draft's opening row", () => {
  const row = document.createElement("button");
  const later = document.createElement("button");
  document.body.append(row, later);
  try {
    row.focus();
    later.focus();
    const h = mount({ autoFocus: { current: row } });
    expect(later).toHaveFocus();
    expect(h.input()).not.toHaveFocus();
  } finally {
    row.remove();
    later.remove();
  }
});

it("cancels a deferred draft handoff when another control takes focus and disappears", () => {
  const row = document.createElement("button");
  const later = document.createElement("button");
  document.body.append(row, later);
  try {
    row.focus();
    const h = mount({ autoFocus: { current: row }, disabled: true });
    later.focus();
    later.remove();
    h.retarget({ disabled: false });
    expect(document.activeElement).toBe(document.body);
    expect(h.input()).not.toHaveFocus();
  } finally {
    row.remove();
    later.remove();
  }
});

it("honors a draft cancellation recorded before its composer mounts", () => {
  const origin: { current: HTMLElement | null } = { current: null };
  const h = mount({ autoFocus: origin });
  expect(h.input()).not.toHaveFocus();
});

it("honors owner cancellation while the composer waits without a focus event", () => {
  const row = document.createElement("button");
  document.body.append(row);
  const origin: { current: HTMLElement | null } = { current: row };
  try {
    row.focus();
    const h = mount({ autoFocus: origin, disabled: true });
    origin.current = null;
    row.remove();
    h.retarget({ disabled: false });
    expect(h.input()).not.toHaveFocus();
  } finally {
    row.remove();
  }
});

it("hands the live draft target to its editor through StrictMode replay", () => {
  const row = document.createElement("button");
  document.body.append(row);
  const origin: { current: HTMLElement | null } = { current: row };
  const moved = (event: FocusEvent) => {
    if (event.target !== origin.current) origin.current = null;
  };
  document.addEventListener("focusin", moved, true);
  try {
    row.focus();
    writeView("scope", "draft:channel", "Saved draft");
    const h = mount({ autoFocus: origin });
    expect(h.input()).toHaveFocus();
    expect(origin.current).toBe(h.input());
    expect(h.input().selectionEnd).toBe("Saved draft".length);
  } finally {
    document.removeEventListener("focusin", moved, true);
    row.remove();
  }
});

it("does not redo initial focus when a focused composer is disabled and enabled again", () => {
  writeView("scope", "draft:channel", "Saved draft");
  const h = mount({ autoFocus: true });
  act(() => h.input().setSelectionRange(1, 4));
  h.retarget({ disabled: true });
  h.retarget({ disabled: false });
  expect(h.input().selectionStart).toBe(1);
  expect(h.input().selectionEnd).toBe(4);
});

it("does not take focus when the composer is enabled after another control takes it", () => {
  const other = document.createElement("button");
  document.body.append(other);
  try {
    const h = mount({ autoFocus: true, disabled: true });
    other.focus();
    h.retarget({ disabled: false });
    expect(other).toHaveFocus();
  } finally {
    other.remove();
  }
});

it("does not take focus when the composer is enabled after a control that took focus unmounts", () => {
  const h = mount({ autoFocus: true, disabled: true });
  const other = document.createElement("button");
  document.body.append(other);
  other.focus();
  other.remove();
  expect(document.activeElement).toBe(document.body);
  h.retarget({ disabled: false });
  expect(h.input()).not.toHaveFocus();
});

it("defers initial focus until an inert startup ancestor is revealed", async () => {
  document.body.setAttribute("inert", "");
  try {
    const h = mount({ autoFocus: true });
    expect(h.input()).not.toHaveFocus();
    document.body.removeAttribute("inert");
    await waitFor(() => expect(h.input()).toHaveFocus());
  } finally {
    document.body.removeAttribute("inert");
  }
});

it("does not reclaim startup focus after another control takes it", async () => {
  document.body.setAttribute("inert", "");
  const other = document.createElement("button");
  document.body.append(other);
  try {
    const h = mount({ autoFocus: true });
    other.focus();
    document.body.removeAttribute("inert");
    await waitFor(() => expect(other).toHaveFocus());
    expect(h.input()).not.toHaveFocus();
  } finally {
    document.body.removeAttribute("inert");
    other.remove();
  }
});

it("does not reclaim startup focus after a control that took focus unmounts", async () => {
  document.body.setAttribute("inert", "");
  try {
    const h = mount({ autoFocus: true });
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    other.remove();
    expect(document.activeElement).toBe(document.body);
    document.body.removeAttribute("inert");
    await act(async () => {}); // Observer callback runs as a microtask.
    expect(h.input()).not.toHaveFocus();
  } finally {
    document.body.removeAttribute("inert");
  }
});

it("does not take focus from a modal when the conversation mounts behind it", () => {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const search = document.createElement("input");
  dialog.append(search);
  document.body.append(dialog);
  try {
    search.focus();
    mount({ autoFocus: true });
    expect(search).toHaveFocus();
  } finally {
    dialog.remove();
  }
});

it.each([
  ["an open popup trigger", { "data-popup-open": "" }],
  ["a menu", { role: "menu" }],
])("does not take focus from %s when the conversation mounts", (_, attrs) => {
  const owner = document.createElement("button");
  for (const [name, value] of Object.entries(attrs))
    owner.setAttribute(name, value);
  document.body.append(owner);
  try {
    owner.focus();
    mount({ autoFocus: true });
    expect(owner).toHaveFocus();
  } finally {
    owner.remove();
  }
});

it("takes focus from a row whose hover preview is open when the conversation mounts", () => {
  const row = document.createElement("button");
  row.setAttribute("data-popup-open", "");
  row.setAttribute("data-popup-preview", "");
  document.body.append(row);
  try {
    row.focus();
    const h = mount({ autoFocus: true });
    expect(h.input()).toHaveFocus();
  } finally {
    row.remove();
  }
});

it("restores the draft end through StrictMode replay without resetting a deliberate selection on updates", () => {
  writeView("scope", "draft:channel", "Saved draft");
  const h = mount({ autoFocus: true });
  expect(h.input()).toHaveFocus();
  expect(h.input().selectionStart).toBe("Saved draft".length);
  expect(h.input().selectionEnd).toBe("Saved draft".length);
  act(() => h.input().setSelectionRange(1, 4));
  h.retarget({ channelName: "Renamed" });
  expect(h.input().selectionStart).toBe(1);
  expect(h.input().selectionEnd).toBe(4);
  h.retarget({ channelId: "other" });
  h.retarget({ channelId: "channel" });
  expect(h.input()).toHaveFocus();
  expect(h.input().selectionStart).toBe("Saved draft".length);
});

it("lets an explicit focus restoration in the mount commit win", () => {
  const h = mount();
  h.unmount();
  const target = document.createElement("button");
  document.body.append(target);
  function RestoreFocus() {
    useLayoutEffect(() => target.focus(), []);
    return null;
  }
  try {
    render(
      <>
        <MessageComposer
          session={h.session}
          scope="scope"
          channelId="channel"
          channelName="General"
          autoFocus
        />
        <RestoreFocus />
      </>,
      { reactStrictMode: true },
    );
    expect(target).toHaveFocus();
  } finally {
    target.remove();
  }
});

it("leaves focus alone unless an enabled composer opts into mount focus", () => {
  const h = mount();
  expect(h.input()).not.toHaveFocus();
  h.retarget({
    channelId: "disabled-channel",
    disabled: true,
    autoFocus: true,
  });
  expect(h.input()).not.toHaveFocus();
});

it("keeps unpublished completions invisible but lets Escape revoke pending work", () => {
  const h = mount();
  const input = h.input();
  input.focus();
  h.fill("!pending");
  const pending = h.completionRequests.length - 1;
  expect(pending).toBeGreaterThanOrEqual(0);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("status", { name: "" })).not.toBeInTheDocument();
  expect(input).not.toHaveAttribute("aria-controls");
  expect(input).not.toHaveAttribute("aria-haspopup");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(h.publish(pending, "late result")).toBe(false);
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(input).toHaveValue("!pending");

  h.fill("!fresh");
  expect(h.publish(h.completionRequests.length - 1)).not.toBe(false);
  expect(screen.getByRole("option", { name: "chosen" })).toBeVisible();
  expect(input).toHaveAttribute("aria-controls");
});

it("shows provider-owned pending and retry states and hides an empty publication", () => {
  const h = mount();
  const input = h.input();
  input.focus();
  h.fill("!search");
  const publish = h.completionRequests.at(-1);
  if (!publish) throw new Error("No observed completion request");
  act(() => {
    publish({ items: [], status: "Searching fixture…" });
  });
  expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
    "Searching fixture…",
  );
  const retry = vi.fn(() =>
    publish({
      items: [
        { id: "recovered", label: "Recovered", edit: { text: "recovered" } },
      ],
    }),
  );
  act(() => {
    publish({ items: [], status: "Unavailable", retry });
  });
  expect(
    screen.getByRole("option", { name: "Retry suggestions" }),
  ).toBeVisible();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(retry).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("option", { name: "Recovered" })).toBeVisible();
  expect(h.messages.send).not.toHaveBeenCalled();
  act(() => {
    publish({ items: [] });
  });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(input).not.toHaveAttribute("aria-controls");
});

it.each(["click", "Enter", "Tab", " "])(
  "accepts the displayed completion by stable ID during a publication refresh via %s",
  (key) => {
    const h = mount();
    const input = h.input();
    input.focus();
    h.fill("!search");
    const publish = h.completionRequests.at(-1);
    if (!publish) throw new Error("No observed completion request");
    const other = { id: "other", label: "Other", edit: { text: "other" } };
    const chosen = { id: "chosen", label: "Chosen", edit: { text: "old" } };
    act(() => {
      publish({ items: [other, chosen], spaceId: chosen.id });
    });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const option = screen.getByRole("option", { name: "Chosen" });
    expect(option).toHaveAttribute("aria-selected", "true");

    act(() => {
      publish({
        items: [
          { ...chosen, label: "Refreshed", edit: { text: "fresh" } },
          other,
        ],
        spaceId: chosen.id,
      });
      // Hold React's commit until after the event, as when a provider's
      // passive effect publishes just before an input event is dispatched.
      expect(option).toHaveTextContent("Chosen");
      if (key === "click") fireEvent.click(option);
      else fireEvent.keyDown(input, { key });
    });
    expect(input).toHaveValue("fresh ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(h.messages.send).not.toHaveBeenCalled();
  },
);

it("selects the exact match on Space from a publication React has not rendered yet", () => {
  const h = mount();
  const input = h.input();
  input.focus();
  h.fill("!search");
  const publish = h.completionRequests.at(-1);
  if (!publish) throw new Error("No observed completion request");
  const chosen = { id: "chosen", label: "Chosen", edit: { text: "chosen" } };
  act(() => {
    publish({ items: [chosen] });
  });
  expect(screen.getByRole("option", { name: "Chosen" })).toBeVisible();
  act(() => {
    // The provider decides Space on the keystroke that completed the name,
    // and a fast Space arrives before React commits that publication.
    publish({ items: [chosen], spaceId: chosen.id });
    expect(fireEvent.keyDown(input, { key: " " })).toBe(false);
  });
  expect(input).toHaveValue("chosen ");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(h.messages.send).not.toHaveBeenCalled();
});

/** The real `@` syntax with a provider that answers each query from its mount
 * effect, as the bundled providers do: one row named by the query, the exact
 * name decided on Space, and a settled empty result once a Space is typed.
 * `mounted` runs in that effect before the publication, after the host has
 * committed what it shows for the query on its own. */
function mountTypeahead(mounted?: (query: string) => void) {
  function Completion({ query, publish }: ComposerCompletionProps) {
    useEffect(() => {
      mounted?.(query.query);
      const withdraw = publish(
        query.query.includes(" ")
          ? { items: [] }
          : {
              items: [
                {
                  id: first.pubkey,
                  label: `Honey ${query.query}`,
                  edit: { mention: first },
                },
              ],
              ...(query.query === "honey" ? { spaceId: first.pubkey } : {}),
            },
      );
      return () => {
        if (withdraw) withdraw();
      };
    }, [query.query, publish]);
    return null;
  }
  const completions: readonly Contribution<ComposerCompletion>[] = [
    {
      id: "mentions",
      key: "buzz.mentions/mentions",
      pluginId: "buzz.mentions",
      revision: "1",
      title: "Mention",
      match: ({ text, start }) => mentionQuery(text, start),
      component: Completion,
    },
  ];
  const empty: [] = [];
  const none = { snapshot: () => empty, subscribe: () => () => {} };
  const h = mount({
    extensions: {
      tools: none,
      inline: none,
      completions: { snapshot: () => completions, subscribe: () => () => {} },
    },
  });
  return {
    ...h,
    /** The popup's row labels, or null while the popup is not in the document. */
    rows() {
      const popup = document.querySelector(
        'section[aria-label="Mention suggestions"]',
      );
      return popup
        ? [...popup.querySelectorAll('[role="option"]')].map(
            (row) => row.textContent,
          )
        : null;
    },
  };
}

it("keeps the popup up through each keystroke that continues an open @ query", async () => {
  const h = mountTypeahead();
  const input = h.input();
  input.focus();
  h.fill("@h");
  expect(h.rows()).toEqual(["Honey h"]);
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  // Each delivery of DOM changes is a point at which the browser may paint.
  // The per-query owner remounts on every keystroke, so its popup section is
  // a new node each time; a delivery whose records removed a section without
  // adding its replacement left the popup absent at a paint opportunity.
  const popup = 'section[aria-label$=" suggestions"]';
  const holds = (nodes: NodeList) =>
    [...nodes].some(
      (node) =>
        node instanceof Element &&
        (node.matches(popup) || !!node.querySelector(popup)),
    );
  const deliveries: { removed: boolean; added: boolean }[] = [];
  const observer = new MutationObserver((records) =>
    deliveries.push({
      removed: records.some((record) => holds(record.removedNodes)),
      added: records.some((record) => holds(record.addedNodes)),
    }),
  );
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    env.IS_REACT_ACT_ENVIRONMENT = false;
    for (const text of ["@ho", "@hon", "@hone", "@honey"]) {
      // The draft changes during a discrete event, as under a keystroke, so
      // React commits the new observation in a microtask rather than under
      // act; the provider's rows for it must be in the document by the end
      // of that task, with no delivery in between showing no popup.
      input.addEventListener(
        "select",
        () => {
          input.value = text;
          input.setSelectionRange(text.length, text.length);
        },
        { once: true },
      );
      input.dispatchEvent(new Event("select"));
      await Promise.resolve();
      expect(h.rows()).toEqual([`Honey ${text.slice(1)}`]);
      // The observer's own microtask was queued during React's.
      await Promise.resolve();
    }
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previous;
    observer.disconnect();
    await act(async () => {});
  }
  expect(deliveries.filter(({ removed, added }) => removed && !added)).toEqual(
    [],
  );
  expect(deliveries.filter(({ removed }) => removed)).toHaveLength(4);
  expect(h.rows()).toEqual(["Honey honey"]);
  expect(h.messages.send).not.toHaveBeenCalled();
});

it("reopens a query at the same offset after Escape with no carried rows", () => {
  // What the host showed for each query before its provider published, once
  // per query: StrictMode runs the provider's mount effect twice.
  const shown: [string, string[] | null][] = [];
  const h = mountTypeahead((query) => {
    if (shown.at(-1)?.[0] !== query) shown.push([query, h.rows()]);
  });
  const input = h.input();
  input.focus();
  h.fill("@hon");
  h.fill("@hone");
  expect(h.rows()).toEqual(["Honey hone"]);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(h.rows()).toBeNull();
  h.fill("@honey");
  expect(h.rows()).toEqual(["Honey honey"]);
  expect(shown).toEqual([
    ["hon", null],
    // A continuing keystroke carries the previous query's rows.
    ["hone", ["Honey hon"]],
    // A query reopened after the popup closed starts empty, as a first one.
    ["honey", null],
  ]);
  expect(h.messages.send).not.toHaveBeenCalled();
});

it("still closes the popup when the query closes, on Escape, and on a Space that selects", () => {
  const h = mountTypeahead();
  const input = h.input();
  input.focus();
  h.fill("@hon");
  expect(h.rows()).toEqual(["Honey hon"]);
  // A settled empty result for the continued query: `@hon ` is prose.
  h.fill("@hon ");
  expect(h.rows()).toBeNull();
  h.fill("@hone");
  expect(h.rows()).toEqual(["Honey hone"]);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(h.rows()).toBeNull();
  h.fill("@honey");
  expect(h.rows()).toEqual(["Honey honey"]);
  expect(fireEvent.keyDown(input, { key: " " })).toBe(false);
  expect(input).toHaveValue("@Honey ");
  expect(h.rows()).toBeNull();
  expect(h.messages.send).not.toHaveBeenCalled();
});

it.each(["click", "Enter", "Tab"])(
  "rejects withdrawn or ineligible refreshed completions via %s without sending",
  (key) => {
    const h = mount();
    const input = h.input();
    input.focus();
    h.fill("!search");
    const publish = h.completionRequests.at(-1);
    if (!publish) throw new Error("No observed completion request");
    const chosen = { id: "chosen", label: "Chosen", edit: { text: "old" } };
    const canSelect = vi.fn(() => false);
    const replacements: (CompletionResult | undefined)[] = [
      undefined,
      { items: [{ id: "other", label: "Other", edit: { text: "other" } }] },
      { items: [{ ...chosen, disabled: "No longer eligible" }] },
      { items: [{ ...chosen, canSelect }] },
    ];
    for (const replacement of replacements) {
      let withdraw: ReturnType<typeof publish> = false;
      act(() => {
        withdraw = publish({ items: [chosen] });
      });
      const option = screen.getByRole("option", { name: "Chosen" });
      act(() => {
        if (replacement) publish(replacement);
        else if (withdraw) withdraw();
        if (key === "click") fireEvent.click(option);
        else expect(fireEvent.keyDown(input, { key })).toBe(false);
      });
      expect(input).toHaveValue("!search");
      expect(h.messages.send).not.toHaveBeenCalled();
    }
    expect(canSelect).toHaveBeenCalledExactlyOnceWith(key);
  },
);

it.each([
  [" ", "test", undefined],
  [" ", "test", "other"],
  [":", "buzz.emoji", undefined],
  [":", "buzz.emoji", "other"],
])(
  "leaves %s alone for %s if the latest publication's exact match is %s",
  (key, pluginId, spaceId) => {
    const h = mount();
    h.replaceCompletionProvider(pluginId);
    const input = h.input();
    input.focus();
    h.fill("!search");
    const publish = h.completionRequests.at(-1);
    if (!publish) throw new Error("No observed completion request");
    const items = [
      { id: "chosen", label: "Chosen", edit: { text: "chosen" } },
      { id: "other", label: "Other", edit: { text: "other" } },
    ];
    act(() => {
      publish({ items, spaceId: "chosen" });
    });
    act(() => {
      publish({ items, spaceId });
      expect(fireEvent.keyDown(input, { key })).toBe(true);
    });
    expect(input).toHaveValue("!search");
    expect(h.messages.send).not.toHaveBeenCalled();
  },
);

it.each(["click", "Enter", "Tab"])(
  "uses only the current retry action during a publication refresh via %s",
  (key) => {
    const h = mount();
    const input = h.input();
    input.focus();
    h.fill("!search");
    const publish = h.completionRequests.at(-1);
    if (!publish) throw new Error("No observed completion request");
    const oldRetry = vi.fn();
    const retry = vi.fn();
    for (const currentRetry of [retry, undefined]) {
      act(() => {
        publish({ items: [], retry: oldRetry });
      });
      const option = screen.getByRole("option", { name: "Retry suggestions" });
      act(() => {
        // A new item at the displayed retry's index is not the user's choice.
        publish({
          items: [{ id: "other", label: "Other", edit: { text: "other" } }],
          ...(currentRetry ? { retry: currentRetry } : {}),
        });
        if (key === "click") fireEvent.click(option);
        else expect(fireEvent.keyDown(input, { key })).toBe(false);
      });
      expect(input).toHaveValue("!search");
      expect(oldRetry).not.toHaveBeenCalled();
      expect(h.messages.send).not.toHaveBeenCalled();
    }
    expect(retry).toHaveBeenCalledTimes(1);
  },
);

it("revokes stale completion publications across editor and ownership lifecycles and recovers freshly", () => {
  const h = mount();
  const input = h.input();
  input.focus();
  h.fill("!a");
  const edit = h.completionRequests.length - 1;
  h.fill("!b");
  h.fill("!a");
  expect(h.publish(edit, "stale ABA")).toBe(false);
  const afterAba = h.completionRequests.length - 1;
  expect(h.publish(afterAba)).not.toBe(false);
  expect(screen.getByRole("option", { name: "chosen" })).toBeVisible();

  fireEvent.keyDown(input, { key: "Escape" });
  expect(h.publish(afterAba, "stale dismissal")).toBe(false);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

  h.fill("!provider");
  const oldProvider = h.completionRequests.length - 1;
  h.replaceCompletionProvider();
  expect(h.publish(oldProvider, "stale provider")).toBe(false);
  const replacement = h.completionRequests.length - 1;
  expect(h.publish(replacement, "replacement fresh")).not.toBe(false);
  expect(
    screen.getByRole("option", { name: "replacement fresh" }),
  ).toBeVisible();

  h.fill("!destination");
  const oldDestination = h.completionRequests.length - 1;
  h.retarget({ threadRootId: "root" });
  expect(h.input()).toHaveValue("");
  expect(h.publish(oldDestination, "stale destination")).toBe(false);
  h.input().focus();
  h.fill("!fresh");
  const fresh = h.completionRequests.length - 1;
  expect(h.publish(fresh, "fresh recovery")).not.toBe(false);
  expect(screen.getByRole("option", { name: "fresh recovery" })).toBeVisible();

  h.unmount();
  expect(h.publish(fresh, "stale unmount")).toBe(false);
});

it.each(["disabled", "readOnly"] as const)(
  "rejects late and displayed completion results when the editor becomes %s",
  (state) => {
    const h = mount();
    const input = h.input();
    input.focus();
    h.fill("!late");
    const late = h.completionRequests.length - 1;
    if (state === "disabled") {
      h.retarget({ disabled: true });
      expect(input).toHaveAttribute("aria-disabled", "true");
      expect(input).toHaveAttribute("contenteditable", "false");
    } else input.readOnly = true;
    expect(h.publish(late, "late result")).toBe(false);

    if (state === "disabled") h.retarget({ disabled: false });
    else input.readOnly = false;
    expect(h.input().disabled).toBe(false);
    expect(h.input().readOnly).toBe(false);
    h.input().focus();
    h.fill("!displayed");
    const displayed = h.completionRequests.length - 1;
    expect(h.publish(displayed, "displayed choice")).not.toBe(false);
    expect(
      screen.getByRole("option", { name: "displayed choice" }),
    ).toBeVisible();
    if (state === "disabled") h.retarget({ disabled: true });
    else h.input().readOnly = true;
    fireEvent.keyDown(h.input(), { key: "Enter" });
    expect(h.input()).toHaveValue("!displayed");
    expect(h.messages.send).not.toHaveBeenCalled();
  },
);

function uploadDescriptor(name = "notes.txt") {
  return {
    name,
    url: `https://relay.example.test/media/${"a".repeat(64)}.txt`,
    type: "text/plain",
    size: 5,
    sha256: "a".repeat(64),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function attachmentFile(name = "notes.txt", bytes = "notes") {
  return new File([bytes], name, { type: "text/plain" });
}
function attachByPaste(target: HTMLElement, file = attachmentFile()) {
  fireEvent.paste(target, {
    clipboardData: { items: [{ kind: "file", getAsFile: () => file }] },
  });
}
function attachByDrop(target: HTMLElement, file = attachmentFile()) {
  const transfer = {
    types: ["Files"],
    files: [file],
    dropEffect: "uninitialized",
  };
  const over = new Event("dragover", { bubbles: true, cancelable: true });
  Object.defineProperty(over, "dataTransfer", { value: transfer });
  fireEvent(target, over);
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: transfer });
  fireEvent(target, drop);
}

async function mountUploadComposer(
  options: {
    threadRootId?: string;
    replyParentId?: string;
    publish?: (event: RelayEvent, signal?: AbortSignal) => Promise<void>;
    emojiRead?: () => Promise<RelayEvent[]>;
    profiles?: readonly RelayEvent[];
    editable?: boolean;
    media?: (url: string) => string | undefined;
    extensions?: MessageComposerProps["extensions"];
    agents?: Agents;
    /** Channel members besides the viewer; only members can be mentioned. */
    members?: readonly string[];
    defaultMention?: MessageComposerProps["defaultMention"];
    requireMention?: boolean;
  } = {},
) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const viewer = keypair(),
    relay = keypair();
  const uploadCalls: {
    file: File;
    signal: AbortSignal;
    progress: ((sent: number, total: number) => void) | undefined;
    result: ReturnType<typeof deferred<ReturnType<typeof uploadDescriptor>>>;
  }[] = [];
  const sign = vi.fn(async (template: EventTemplate) =>
    signed(viewer, template),
  );
  const publish = vi.fn(
    options.publish ??
      (async (_event: RelayEvent, _signal?: AbortSignal) => {}),
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://relay.example.test",
      media: options.media ?? ((url) => url),
      uploadAttachment(file, signal, progress) {
        const result = deferred<ReturnType<typeof uploadDescriptor>>();
        uploadCalls.push({ file, signal, progress, result });
        return result.promise;
      },
      async query(filters) {
        if (filters.some((filter) => filter.kinds?.includes(0)))
          return [...(options.profiles ?? [])];
        if (
          filters.some((filter) => filter.kinds?.includes(30030)) &&
          options.emojiRead
        )
          return options.emojiRead();
        return filters.flatMap((filter) =>
          filter["#d"]?.includes("other")
            ? filter.kinds?.includes(39002)
              ? [roster(relay, "other", other.members, other.time)]
              : [metadata(relay, "other", "Random", other.time)]
            : filter.kinds?.includes(39002)
              ? [
                  roster(
                    relay,
                    "channel",
                    [viewer.pubkey, ...(options.members ?? [])],
                    1700000000,
                  ),
                ]
              : filter.kinds?.includes(39000)
                ? [metadata(relay, "channel", "General", 1700000000)]
                : [],
        );
      },
      writer: { kinds: options.editable ? [9, 40003, 5] : [9], sign, publish },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  const other = { members: [] as string[], time: 1700000000 };
  /** Changes membership of an unrelated channel; losing it revokes access. */
  const otherMembership = (joined: boolean) => {
    other.members = joined ? [viewer.pubkey] : [];
    other.time++;
    return act(() =>
      owner.session.read([
        { kinds: [39002], "#d": ["other"], limit: 1 },
        { kinds: [39000], "#d": ["other"], limit: 1 },
      ]),
    );
  };
  await act(() =>
    owner.session.read([
      { kinds: [39002], "#d": ["channel"], limit: 1 },
      { kinds: [39000], "#d": ["channel"], limit: 1 },
    ]),
  );
  const scope = `https://relay.example.test:${viewer.pubkey}`;
  const composer = (presented = true, shown = true) => (
    <AgentsContext.Provider value={options.agents}>
      <ConversationPresentation value={presented}>
        <MessageComposer
          shown={shown}
          session={owner.session}
          scope={scope}
          channelId="channel"
          channelName="General"
          defaultMention={options.defaultMention}
          requireMention={options.requireMention}
          {...(options.extensions ? { extensions: options.extensions } : {})}
          {...(options.threadRootId
            ? { threadRootId: options.threadRootId }
            : {})}
          {...(options.replyParentId
            ? { replyParentId: options.replyParentId }
            : {})}
        />
      </ConversationPresentation>
    </AgentsContext.Provider>
  );
  const view = render(composer(), {
    reactStrictMode: true,
    wrapper: ToastProvider,
  });
  const input = () => within(view.container).getByRole("textbox");
  const form = () => within(view.container).getByRole("form");
  const send = () =>
    within(view.container).getByRole("button", { name: "Send message" });
  owners.push(owner);
  return {
    ...view,
    owner,
    input,
    form,
    send,
    scope,
    uploadCalls,
    sign,
    publish,
    otherMembership,
    present: (presented: boolean, shown = true) =>
      view.rerender(composer(presented, shown)),
  };
}

function pickAttachments(container: HTMLElement, files: readonly File[]) {
  const picker =
    container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!picker) throw new Error("Missing attachment picker");
  fireEvent.change(picker, { target: { files } });
}

it("focuses the composer only after the whole picker batch succeeds", async () => {
  const h = await mountUploadComposer();
  const trigger = screen.getByRole("button", { name: "Attach files" });
  trigger.focus();
  pickAttachments(h.container, [
    attachmentFile("one.txt"),
    attachmentFile("two.txt"),
  ]);
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  expect(trigger).toHaveFocus();
  await act(() =>
    h.uploadCalls[0]?.result.resolve(uploadDescriptor("one.txt")),
  );
  await waitFor(() => expect(h.uploadCalls).toHaveLength(2));
  expect(trigger).toHaveFocus();
  await act(() =>
    h.uploadCalls[1]?.result.resolve(uploadDescriptor("two.txt")),
  );
  expect(h.input()).toHaveFocus();
});

it.each(["before", "after"])(
  "keeps the picker handoff when focus returns to Attach %s change",
  async (order) => {
    const h = await mountUploadComposer();
    const trigger = screen.getByRole("button", { name: "Attach files" });
    trigger.focus();
    if (order === "before") fireEvent.focusIn(trigger);
    pickAttachments(h.container, [attachmentFile()]);
    await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
    if (order === "after") fireEvent.focusIn(trigger);
    await act(() => h.uploadCalls[0]?.result.resolve(uploadDescriptor()));
    expect(h.input()).toHaveFocus();
  },
);

it("leaves focus alone on picker cancellation or rejected files", async () => {
  const h = await mountUploadComposer();
  const trigger = screen.getByRole("button", { name: "Attach files" });
  trigger.focus();
  pickAttachments(h.container, []);
  pickAttachments(h.container, [attachmentFile("empty.txt", "")]);
  expect(
    await screen.findByText("Could not attach file", { exact: true }),
  ).toBeVisible();
  expect(h.uploadCalls).toHaveLength(0);
  expect(trigger).toHaveFocus();
});

it("does not focus after a picker upload fails or is later retried", async () => {
  const h = await mountUploadComposer();
  const trigger = screen.getByRole("button", { name: "Attach files" });
  trigger.focus();
  pickAttachments(h.container, [attachmentFile()]);
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  await act(() => h.uploadCalls[0]?.result.reject(new Error("offline")));
  expect(trigger).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Retry notes.txt" }));
  await waitFor(() => expect(h.uploadCalls).toHaveLength(2));
  await act(() => h.uploadCalls[1]?.result.resolve(uploadDescriptor()));
  expect(trigger).toHaveFocus();
});

it.each(["inactive", "hidden"])(
  "cancels picker focus when the conversation becomes %s, including a warm return",
  async (state) => {
    const h = await mountUploadComposer();
    const trigger = screen.getByRole("button", { name: "Attach files" });
    trigger.focus();
    pickAttachments(h.container, [attachmentFile()]);
    await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
    h.present(state !== "inactive", state !== "hidden");
    h.present(true);
    screen.getByRole("button", { name: "Attach files" }).focus();
    await act(() => h.uploadCalls[0]?.result.resolve(uploadDescriptor()));
    expect(screen.getByRole("button", { name: "Attach files" })).toHaveFocus();
  },
);

it("preserves deliberate focus changes even when focus returns to the picker trigger", async () => {
  const h = await mountUploadComposer();
  const trigger = screen.getByRole("button", { name: "Attach files" });
  trigger.focus();
  pickAttachments(h.container, [attachmentFile()]);
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  h.input().focus();
  trigger.focus();
  await act(() => h.uploadCalls[0]?.result.resolve(uploadDescriptor()));
  expect(trigger).toHaveFocus();
});

it("does not focus a replacement composer after a late picker completion", async () => {
  const h = await mountUploadComposer();
  screen.getByRole("button", { name: "Attach files" }).focus();
  pickAttachments(h.container, [attachmentFile()]);
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  h.unmount();
  const next = await mountUploadComposer();
  const trigger = within(next.container).getByRole("button", {
    name: "Attach files",
  });
  trigger.focus();
  await act(() => h.uploadCalls[0]?.result.resolve(uploadDescriptor()));
  expect(trigger).toHaveFocus();
});

it.each([attachByPaste, attachByDrop])(
  "keeps existing focus behavior for %s uploads",
  async (attach) => {
    const h = await mountUploadComposer();
    const trigger = screen.getByRole("button", { name: "Attach files" });
    trigger.focus();
    attach(h.form());
    await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
    await act(() => h.uploadCalls[0]?.result.resolve(uploadDescriptor()));
    expect(trigger).toHaveFocus();
  },
);

it("pauses while disabled and resumes attachment Send without Retry when re-enabled", async () => {
  const h = await mountUploadComposer();
  fireEvent.change(h.input(), { target: { value: "Keep my files" } });
  attachByPaste(h.input(), attachmentFile("paused.txt"));
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  const tree = (disabled: boolean) => (
    <MessageComposer
      session={h.owner.session}
      scope={h.scope}
      channelId="channel"
      channelName="General"
      disabled={disabled}
    />
  );
  h.rerender(tree(true));
  expect(h.uploadCalls[0]?.signal.aborted).toBe(true);
  expect(screen.queryByRole("button", { name: "Retry paused.txt" })).toBeNull();
  expect(h.send()).toBeDisabled();
  h.rerender(tree(false));
  await waitFor(() => expect(h.uploadCalls).toHaveLength(2));
  expect(h.send()).toBeEnabled();
  fireEvent.click(h.send());
  await act(async () =>
    h.uploadCalls[1]?.result.resolve(uploadDescriptor("paused.txt")),
  );
  await waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
  expect(h.uploadCalls).toHaveLength(2);
});

it("starts picker, paste and drop uploads eagerly and publishes only after Send", async () => {
  const h = await mountUploadComposer();
  const picker =
    h.container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!picker) throw new Error("Missing attachment picker");
  const picked = attachmentFile("picker.txt");
  Object.defineProperty(picker, "files", {
    value: [picked],
    configurable: true,
  });
  fireEvent.change(picker);
  attachByPaste(h.input(), attachmentFile("pasted.txt"));
  attachByDrop(h.form(), attachmentFile("dropped.txt"));
  await waitFor(() =>
    expect(within(h.form()).getAllByText(/\.txt$/)).toHaveLength(3),
  );
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();

  fireEvent.click(h.send());
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  expect(h.uploadCalls[0]?.file.name).toBe("picker.txt");
  expect(screen.queryByText("Adding agent to this channel…")).toBeNull();
  // Send hands the files to the background upload and frees the composer.
  await waitFor(() =>
    expect(within(h.form()).queryAllByText(/\.txt$/)).toHaveLength(0),
  );
  expect(screen.getByText("Uploading", { exact: true })).toHaveAttribute(
    "role",
    "status",
  );
  const bar = screen.getByRole("progressbar", { name: "Uploading" });
  expect(h.input()).toBeEnabled();
  await act(async () => {
    h.uploadCalls[0]?.result.resolve(uploadDescriptor("picker.txt"));
  });
  await waitFor(() => expect(h.uploadCalls).toHaveLength(2));
  // Without byte reports, a finished file does not step the bar to 33%.
  expect(bar).not.toHaveAttribute("aria-valuenow");
  act(() => h.uploadCalls[1]?.progress?.(4, 5));
  // The third file is not prepared yet; its transfer total is unknown.
  expect(bar).not.toHaveAttribute("aria-valuenow");
  expect(screen.queryByText(/%|\d/)).toBeNull();
  await act(async () => {
    h.uploadCalls[1]?.result.resolve(uploadDescriptor("pasted.txt"));
  });
  await waitFor(() => expect(h.uploadCalls).toHaveLength(3));
  await act(async () => {
    h.uploadCalls[2]?.result.resolve(uploadDescriptor("dropped.txt"));
  });
  await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
  expect(h.sign).toHaveBeenCalledTimes(1);
  expect(h.publish.mock.calls[0]?.[0].content).toContain(
    "[picker.txt](<https://relay.example.test/media/",
  );
  expect(h.publish.mock.calls[0]?.[0].content).toContain("[pasted.txt](<");
  expect(h.publish.mock.calls[0]?.[0].content).toContain("[dropped.txt](<");
  expect(screen.queryByText(/^Uploading/)).toBeNull();
});

it.each([false, true])(
  "restores failed background upload before inserting any next-draft default (default=%s)",
  async (tagged) => {
    const agent = { pubkey: "b".repeat(64), name: "Honey" };
    const h = await mountUploadComposer(
      tagged
        ? {
            members: [agent.pubkey],
            defaultMention: agent,
            requireMention: true,
          }
        : {},
    );
    if (tagged) await waitFor(() => expect(h.input()).toHaveValue("@Honey "));
    attachByPaste(h.input(), attachmentFile("metadata.txt"));
    await waitFor(() =>
      expect(within(h.form()).getByText("metadata.txt")).toBeVisible(),
    );
    // jsdom cannot place a pointer caret around the inserted chip. Exercise
    // keyboard continuation at the editor's own end without a synthetic click.
    const editor = screen.getByRole<ComposerInputElement>("textbox");
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
    await userEvent.type(h.input(), "caption", { skipClick: true });

    fireEvent.click(h.send());
    await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
    await act(async () => {
      h.uploadCalls[0]?.result.reject(new UploadError("metadata"));
    });
    await waitFor(() =>
      expect(
        screen.getAllByRole("alert").map((node) => node.textContent),
      ).toEqual([`metadata.txt: ${UPLOAD_FAILURES.metadata}`]),
    );
    expect(
      screen.getByText(`Upload failed: ${UPLOAD_FAILURES.metadata}`),
    ).toBeVisible();
    expect(h.input()).toHaveValue(tagged ? "@Honey caption" : "caption");
    expect(h.publish).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: "Remove metadata.txt" }),
    );
    expect(h.input()).toHaveFocus();

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(h.form()).queryByText("metadata.txt"),
      ).not.toBeInTheDocument(),
    );
  },
);

// Remounting after the failure covers the usual leave-and-return case: the
// recovery lands with no mounted listener and must wait for the composer.
it.each(["never", "before the failure", "after the failure"])(
  "restores the model and effort picks of a failed background upload (remounted: %s)",
  async (remounted) => {
    // Snapshots are stable, as the service's are.
    const snapshot = {
      status: "ready",
      agents: [
        {
          key: first.pubkey,
          pubkey: first.pubkey,
          name: "Honey",
          type: "test/agent",
        },
      ],
    };
    const models = {
      current: "fast",
      models: [
        {
          id: "fast",
          label: "Fast",
          efforts: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
      ],
    };
    const types = [{ key: "test/agent", models: () => models }];
    const agents = {
      find: (pubkey: string) =>
        snapshot.agents.find((agent) => agent.pubkey === pubkey),
      joinable: () => [],
      sessionState: () => "unavailable" as const,
      subscribe: () => () => {},
      snapshot: () => snapshot,
      types: () => types,
    } as unknown as Agents;
    const tools: readonly Contribution<ComposerTool>[] = [
      {
        id: "fixture",
        key: "test/fixture",
        pluginId: "test",
        revision: "1",
        title: "Fixture tools",
        component: (props: ComposerToolProps) => (
          <button type="button" onClick={() => props.insertMention(first)}>
            First Honey
          </button>
        ),
      },
    ];
    const extensions = {
      tools: { snapshot: () => tools, subscribe: () => () => {} },
      inline: { snapshot: () => [], subscribe: () => () => {} },
    };
    const h = await mountUploadComposer({
      agents,
      members: [first.pubkey],
      extensions,
    });
    const picker = () =>
      screen.findByRole("button", {
        name: /Model.*effort/,
      });
    attachByPaste(h.input(), attachmentFile("tuned.txt"));
    await userEvent.type(h.input(), "think hard");
    await userEvent.click(screen.getByRole("button", { name: "First Honey" }));
    await userEvent.click(await picker());
    const slider = await screen.findByLabelText("Effort for Honey's next run");
    slider.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(slider).toHaveAttribute("aria-valuetext", "High");
    await userEvent.keyboard("{Escape}");
    fireEvent.click(h.send());
    await waitFor(() => expect(h.uploadCalls).toHaveLength(1));

    let container = h.container;
    if (remounted !== "never") h.unmount();
    const remount = () => {
      container = render(
        <AgentsContext.Provider value={agents}>
          <MessageComposer
            session={h.owner.session}
            scope={h.scope}
            channelId="channel"
            channelName="General"
            extensions={extensions}
          />
        </AgentsContext.Provider>,
        { wrapper: ToastProvider },
      ).container;
    };
    if (remounted === "before the failure") remount();
    await act(async () => {
      h.uploadCalls[0]?.result.reject(new Error("offline"));
    });
    if (remounted === "after the failure") remount();
    const input = () => within(container).getByRole("textbox");
    await waitFor(() => expect(input()).toHaveValue("think hard@Honey "));
    await waitFor(() =>
      expect(within(container).getByText("tuned.txt")).toBeVisible(),
    );
    // The restored draft brings its pick back with it, not the default run.
    const button = await picker();
    expect(button).toHaveAttribute("data-selected");
    await userEvent.hover(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "next run: High",
    );
    await userEvent.unhover(button);
    expect(h.publish).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: "Retry tuned.txt" }),
    );
    fireEvent.click(
      within(container).getByRole("button", { name: "Send message" }),
    );
    await waitFor(() => expect(h.uploadCalls).toHaveLength(2));
    await act(async () => {
      h.uploadCalls[1]?.result.resolve(uploadDescriptor("tuned.txt"));
    });
    await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
    expect(h.publish.mock.calls[0]?.[0].tags).toEqual(
      expect.arrayContaining([
        ["p", first.pubkey],
        ["effort", first.pubkey, "high"],
      ]),
    );
  },
);

it.each(["cleanup", "restore"] as const)(
  "retains a failed attachment send until %s storage recovers",
  async (phase) => {
    const h = await mountUploadComposer();
    attachByPaste(h.input(), attachmentFile("retained.txt"));
    await userEvent.type(h.input(), "recover this caption");
    const key = `buzz-view.v1:${JSON.stringify([h.scope, "draft:channel"])}`;
    const original = Storage.prototype.setItem;
    let failWrites = phase === "cleanup";
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, name, value) {
        if (name === key && failWrites) throw Error("storage full");
        return original.call(this, name, value);
      });
    try {
      fireEvent.click(h.send());
      await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
      if (phase === "cleanup") {
        expect(h.input()).toHaveAttribute("contenteditable", "false");
        expect(readView(h.scope, "draft:channel", null)).toMatchObject({
          text: "recover this caption",
        });
      }
      if (phase === "restore") {
        expect(readView(h.scope, "draft:channel", null)).toMatchObject({
          text: "",
        });
        failWrites = true;
      }
      await act(async () =>
        h.uploadCalls[0]?.result.reject(new Error("upload unavailable")),
      );
      if (phase === "restore") {
        await screen.findByRole("button", {
          name: "Retry failed send recovery",
        });
        expect(h.input()).toHaveValue("");
        failWrites = false;
        await userEvent.click(
          screen.getByRole("button", { name: "Retry failed send recovery" }),
        );
      } else {
        await waitFor(() =>
          expect(h.input()).toHaveValue("recover this caption"),
        );
      }
      await waitFor(() =>
        expect(h.input()).toHaveValue("recover this caption"),
      );
      await waitFor(() =>
        expect(within(h.form()).getByText("retained.txt")).toBeVisible(),
      );
      expect(
        screen.queryByRole("button", { name: "Retry draft cleanup" }),
      ).toBeNull();
      expect(h.publish).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  },
);

it("offers emoji catalog refresh after an attachment publication fails preparation", async () => {
  let available = false;
  const h = await mountUploadComposer({
    emojiRead: async () => {
      if (!available) throw Error("catalog offline");
      return [];
    },
  });
  await waitFor(() =>
    expect(h.owner.session.emoji.snapshot().status).toBe("error"),
  );
  attachByPaste(h.input(), attachmentFile("emoji.txt"));
  await userEvent.type(h.input(), "caption :party:");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  await act(async () =>
    h.uploadCalls[0]?.result.resolve(uploadDescriptor("emoji.txt")),
  );
  await waitFor(() => expect(h.input()).toHaveValue("caption :party:"));
  expect(within(h.form()).getByRole("alert")).toHaveTextContent(
    "Community emoji isn't ready",
  );
  // The refused send retried the catalog; recovery is offered once that fails.
  expect(
    await screen.findByRole("button", { name: "Retry message preparation" }),
  ).toBeVisible();
  // The retained refusal stays accurate once that retry has failed.
  expect(h.owner.session.emoji.snapshot().status).toBe("error");
  expect(within(h.form()).getByRole("alert")).toHaveTextContent(
    "Community emoji isn't ready. Your draft is kept; try sending again shortly.",
  );
  available = true;
  fireEvent.click(
    screen.getByRole("button", { name: "Retry message preparation" }),
  );
  await waitFor(() =>
    expect(h.owner.session.emoji.snapshot().status).toBe("ready"),
  );
  expect(h.input()).toHaveValue("caption :party:");
  expect(within(h.form()).getByText("emoji.txt")).toBeVisible();
  expect(h.publish).not.toHaveBeenCalled();
});

it("sends once the catalog retry started by a refused emoji send loads", async () => {
  let available = false;
  const h = await mountUploadComposer({
    emojiRead: async () => {
      if (!available) throw Error("catalog offline");
      return [];
    },
  });
  await waitFor(() =>
    expect(h.owner.session.emoji.snapshot().status).toBe("error"),
  );
  available = true;
  await userEvent.type(h.input(), ":party:");
  fireEvent.click(h.send());
  expect(within(h.form()).getByRole("alert")).toHaveTextContent(
    "Community emoji isn't ready. Your draft is kept; try sending again shortly.",
  );
  await waitFor(() =>
    expect(h.owner.session.emoji.snapshot().status).toBe("ready"),
  );
  expect(
    screen.queryByRole("button", { name: "Retry message preparation" }),
  ).toBeNull();
  expect(h.input()).toHaveValue(":party:");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
  expect(within(h.form()).queryByRole("alert")).toBeNull();
});

it("does not overwrite a later local edit when a background upload fails", async () => {
  const h = await mountUploadComposer();
  attachByPaste(h.input(), attachmentFile("original.txt"));
  await userEvent.type(h.input(), "original caption");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  await userEvent.type(h.input(), "later work");
  await act(async () => h.uploadCalls[0]?.result.reject(new Error("offline")));
  expect(h.input()).toHaveValue("later work");
  expect(readView(h.scope, "draft:channel", null)).toMatchObject({
    text: "later work",
  });
  expect(
    await screen.findByText(/Failed send was kept because this draft changed/),
  ).toBeVisible();
  const retry = await screen.findByRole("button", {
    name: "Retry failed send recovery",
  });
  await userEvent.click(retry);
  expect(h.input()).toHaveValue("later work");
  await userEvent.clear(h.input());
  await userEvent.click(retry);
  await waitFor(() => expect(h.input()).toHaveValue("original caption"));
  await waitFor(() =>
    expect(within(h.form()).getByText("original.txt")).toBeVisible(),
  );
  expect(
    screen.queryByRole("button", { name: "Retry failed send recovery" }),
  ).toBeNull();
  expect(h.publish).not.toHaveBeenCalled();
});

it("restores a failed upload after the composer remounts in the same session", async () => {
  const h = await mountUploadComposer();
  attachByPaste(h.input(), attachmentFile("remount.txt"));
  await userEvent.type(h.input(), "remount caption");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  h.unmount();
  const again = render(
    <MessageComposer
      session={h.owner.session}
      scope={h.scope}
      channelId="channel"
      channelName="General"
    />,
    { wrapper: ToastProvider },
  );
  await act(async () => h.uploadCalls[0]?.result.reject(new Error("offline")));
  await waitFor(() =>
    expect(within(again.container).getByRole("textbox")).toHaveValue(
      "remount caption",
    ),
  );
  await waitFor(() =>
    expect(within(again.container).getByText("remount.txt")).toBeVisible(),
  );
});

it("reconciles failed-cleanup recovery after remount before stale cleanup can overwrite the caption", async () => {
  const h = await mountUploadComposer();
  attachByPaste(h.input(), attachmentFile("retained.txt"));
  await userEvent.type(h.input(), "recover this caption");
  const key = `buzz-view.v1:${JSON.stringify([h.scope, "draft:channel"])}`;
  const original = Storage.prototype.setItem;
  let failCleanup = true;
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, name, value) {
      if (name === key && failCleanup) throw Error("storage full");
      return original.call(this, name, value);
    });
  try {
    fireEvent.click(h.send());
    await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
    expect(h.input()).toHaveAttribute("contenteditable", "false");
    h.unmount();
    const again = render(
      <MessageComposer
        session={h.owner.session}
        scope={h.scope}
        channelId="channel"
        channelName="General"
      />,
      { wrapper: ToastProvider },
    );
    const replacement = within(again.container).getByRole("textbox");
    expect(replacement).toHaveAttribute("contenteditable", "false");
    failCleanup = false;
    await act(async () =>
      h.uploadCalls[0]?.result.reject(new Error("offline")),
    );
    await waitFor(() =>
      expect(replacement).toHaveValue("recover this caption"),
    );
    expect(replacement).toHaveAttribute("contenteditable", "true");
    await waitFor(() =>
      expect(within(again.container).getByText("retained.txt")).toBeVisible(),
    );
    expect(
      within(again.container).queryByRole("button", {
        name: "Retry draft cleanup",
      }),
    ).toBeNull();
    await userEvent.type(replacement, " again");
    expect(replacement).toHaveValue(" againrecover this caption");
    expect(readView(h.scope, "draft:channel", null)).toMatchObject({
      text: " againrecover this caption",
    });
    expect(h.publish).not.toHaveBeenCalled();
  } finally {
    write.mockRestore();
  }
});

it("retains a remounted later edit conflict until clearing it and explicitly retrying recovery", async () => {
  const h = await mountUploadComposer();
  attachByPaste(h.input(), attachmentFile("original.txt"));
  await userEvent.type(h.input(), "original caption");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  h.unmount();
  const again = render(
    <MessageComposer
      session={h.owner.session}
      scope={h.scope}
      channelId="channel"
      channelName="General"
    />,
    { wrapper: ToastProvider },
  );
  const replacement = within(again.container).getByRole("textbox");
  await userEvent.type(replacement, "later edit");
  await act(async () => h.uploadCalls[0]?.result.reject(new Error("offline")));
  const retry = await screen.findByRole("button", {
    name: "Retry failed send recovery",
  });
  expect(replacement).toHaveValue("later edit");
  await userEvent.click(retry);
  expect(replacement).toHaveValue("later edit");
  expect(within(again.container).queryByText("original.txt")).toBeNull();
  await userEvent.clear(replacement);
  expect(readView(h.scope, "draft:channel", null)).toMatchObject({ text: "" });
  await userEvent.click(retry);
  await waitFor(() => expect(replacement).toHaveValue("original caption"));
  expect(replacement).toHaveAttribute("contenteditable", "true");
  await waitFor(() =>
    expect(within(again.container).getByText("original.txt")).toBeVisible(),
  );
  expect(
    screen.queryByRole("button", { name: "Retry failed send recovery" }),
  ).toBeNull();
  expect(h.publish).not.toHaveBeenCalled();
});

it("does not replace an active message edit when a remounted upload recovers", async () => {
  const h = await mountUploadComposer({ editable: true });
  attachByPaste(h.input(), attachmentFile("original.txt"));
  await userEvent.type(h.input(), "original caption");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  h.unmount();
  const viewer = h.owner.session.viewer;
  if (!viewer) throw new Error("Expected upload viewer");
  const row = editableMessage({ authorId: viewer });
  const again = render(
    <MessageComposer
      session={h.owner.session}
      scope={h.scope}
      channelId="channel"
      channelName="General"
      editMessages={[row]}
    />,
    { wrapper: ToastProvider },
  );
  const replacement = within(again.container).getByRole("textbox");
  fireEvent.keyDown(replacement, { key: "ArrowUp" });
  expect(replacement).toHaveAccessibleName("Edit message");
  expect(replacement).toHaveValue("Original message");
  await act(async () => h.uploadCalls[0]?.result.reject(new Error("offline")));
  expect(replacement).toHaveAccessibleName("Edit message");
  expect(replacement).toHaveValue("Original message");
  expect(readView(h.scope, "draft:channel", null)).toMatchObject({
    text: "original caption",
  });
  fireEvent.click(
    within(again.container).getByRole("button", { name: "Cancel edit" }),
  );
  await waitFor(() => expect(replacement).toHaveValue("original caption"));
  await waitFor(() =>
    expect(within(again.container).getByText("original.txt")).toBeVisible(),
  );
  expect(h.publish).not.toHaveBeenCalled();
});

it("defers a failed upload recovery until an empty active message edit ends", async () => {
  const h = await mountUploadComposer({ editable: true });
  attachByPaste(h.input(), attachmentFile("original.txt"));
  await userEvent.type(h.input(), "original caption");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  const viewer = h.owner.session.viewer;
  if (!viewer) throw new Error("Expected upload viewer");
  const row = editableMessage({ authorId: viewer });
  h.rerender(
    <MessageComposer
      session={h.owner.session}
      scope={h.scope}
      channelId="channel"
      channelName="General"
      editMessages={[row]}
    />,
  );
  const editor = h.input();
  fireEvent.keyDown(editor, { key: "ArrowUp" });
  expect(editor).toHaveAccessibleName("Edit message");
  await userEvent.clear(editor);
  expect(editor).toHaveValue("");
  await act(async () => h.uploadCalls[0]?.result.reject(new Error("offline")));
  expect(editor).toHaveAccessibleName("Edit message");
  expect(editor).toHaveValue("");
  expect(within(h.form()).queryByText("original.txt")).toBeNull();
  expect(readView(h.scope, "draft:channel", null)).toMatchObject({
    text: "original caption",
  });
  fireEvent.click(
    within(h.form()).getByRole("button", { name: "Save changes" }),
  );
  expect(h.publish).not.toHaveBeenCalled();
  fireEvent.click(
    within(h.form()).getByRole("button", { name: "Cancel edit" }),
  );
  await waitFor(() => expect(editor).toHaveValue("original caption"));
  await waitFor(() =>
    expect(within(h.form()).getByText("original.txt")).toBeVisible(),
  );
});

it("retains preparation retry when recovery is deferred by an edit then unmounted", async () => {
  const h = await mountUploadComposer({
    editable: true,
    emojiRead: async () => {
      throw Error("catalog offline");
    },
  });
  await waitFor(() =>
    expect(h.owner.session.emoji.snapshot().status).toBe("error"),
  );
  attachByPaste(h.input(), attachmentFile("edit-remount.txt"));
  await userEvent.type(h.input(), "caption :party:");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  const viewer = h.owner.session.viewer;
  if (!viewer) throw new Error("Expected upload viewer");
  const row = editableMessage({ authorId: viewer });
  h.rerender(
    <MessageComposer
      session={h.owner.session}
      scope={h.scope}
      channelId="channel"
      channelName="General"
      editMessages={[row]}
    />,
  );
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  await userEvent.clear(h.input());
  await act(async () =>
    h.uploadCalls[0]?.result.resolve(uploadDescriptor("edit-remount.txt")),
  );
  expect(h.input()).toHaveAccessibleName("Edit message");
  await waitFor(() =>
    expect(h.owner.session.emoji.snapshot().status).toBe("error"),
  );
  expect(
    within(h.form()).queryByRole("button", {
      name: "Retry message preparation",
    }),
  ).toBeNull();
  h.unmount();
  const returned = render(
    <MessageComposer
      session={h.owner.session}
      scope={h.scope}
      channelId="channel"
      channelName="General"
      editMessages={[row]}
    />,
    { wrapper: ToastProvider },
  );
  const composer = within(returned.container);
  expect(composer.getByRole("textbox")).toHaveValue("caption :party:");
  await waitFor(() =>
    expect(composer.getByText("edit-remount.txt")).toBeVisible(),
  );
  expect(composer.getByRole("alert")).toHaveTextContent(
    "Community emoji isn't ready",
  );
  // The refused send retried the catalog; recovery is offered once that fails.
  expect(
    await composer.findByRole("button", { name: "Retry message preparation" }),
  ).toBeVisible();
});

it("offers message preparation retry after a failed attachment send remounts", async () => {
  let available = false;
  const h = await mountUploadComposer({
    emojiRead: async () => {
      if (!available) throw Error("catalog offline");
      return [];
    },
  });
  await waitFor(() =>
    expect(h.owner.session.emoji.snapshot().status).toBe("error"),
  );
  attachByPaste(h.input(), attachmentFile("emoji-remount.txt"));
  await userEvent.type(h.input(), "caption :party:");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  h.unmount();
  await act(async () =>
    h.uploadCalls[0]?.result.resolve(uploadDescriptor("emoji-remount.txt")),
  );
  const again = render(
    <MessageComposer
      session={h.owner.session}
      scope={h.scope}
      channelId="channel"
      channelName="General"
    />,
    { wrapper: ToastProvider },
  );
  const composer = within(again.container);
  await waitFor(() =>
    expect(composer.getByRole("textbox")).toHaveValue("caption :party:"),
  );
  await waitFor(() =>
    expect(composer.getByText("emoji-remount.txt")).toBeVisible(),
  );
  expect(composer.getByRole("alert")).toHaveTextContent(
    "Community emoji isn't ready",
  );
  // The refused send retried the catalog; recovery is offered once that fails.
  const retry = await composer.findByRole("button", {
    name: "Retry message preparation",
  });
  available = true;
  fireEvent.click(retry);
  await waitFor(() =>
    expect(h.owner.session.emoji.snapshot().status).toBe("ready"),
  );
  expect(composer.getByRole("textbox")).toHaveValue("caption :party:");
  await waitFor(() =>
    expect(composer.getByText("emoji-remount.txt")).toBeVisible(),
  );
  expect(h.publish).not.toHaveBeenCalled();
  again.unmount();
  const returned = render(
    <MessageComposer
      session={h.owner.session}
      scope={h.scope}
      channelId="channel"
      channelName="General"
    />,
    { wrapper: ToastProvider },
  );
  expect(
    within(returned.container).queryByRole("button", {
      name: "Retry message preparation",
    }),
  ).toBeNull();
  expect(within(returned.container).getByRole("textbox")).toHaveValue(
    "caption :party:",
  );
});

it("identifies failed filenames through retry and removal when service errors match", async () => {
  const h = await mountUploadComposer();
  attachByPaste(h.input(), attachmentFile("one.txt"));
  attachByPaste(h.input(), attachmentFile("two.txt"));
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  await act(async () => {
    h.uploadCalls[0]?.result.reject(new Error("HTTP 503"));
  });
  await waitFor(() => expect(h.uploadCalls).toHaveLength(2));
  await act(async () => {
    h.uploadCalls[1]?.result.reject(new Error("HTTP 503"));
  });
  await waitFor(() =>
    expect(
      screen.getAllByRole("alert").map((node) => node.textContent),
    ).toEqual(["one.txt: HTTP 503", "two.txt: HTTP 503"]),
  );
  await userEvent.click(screen.getByRole("button", { name: "Retry one.txt" }));
  await waitFor(() => expect(h.uploadCalls).toHaveLength(3));
  await act(async () => {
    h.uploadCalls[2]?.result.reject(new Error("first failed again"));
  });
  await waitFor(() =>
    expect(
      screen.getAllByRole("alert").map((node) => node.textContent),
    ).toEqual(["one.txt: first failed again", "two.txt: HTTP 503"]),
  );
  await userEvent.click(screen.getByRole("button", { name: "Remove one.txt" }));
  expect(h.input()).toHaveFocus();
  expect(screen.getAllByRole("alert").map((node) => node.textContent)).toEqual([
    "two.txt: HTTP 503",
  ]);
  await waitFor(() =>
    expect(within(h.form()).queryByText("one.txt")).not.toBeInTheDocument(),
  );
  expect(within(h.form()).getByText("two.txt")).toBeVisible();
  expect(h.publish).not.toHaveBeenCalled();
});

it("retains successful attachment uploads after a later file fails and retries only failed bytes", async () => {
  const h = await mountUploadComposer();
  attachByPaste(h.input(), attachmentFile("ready.txt"));
  attachByPaste(h.input(), attachmentFile("retry.txt"));
  await waitFor(() =>
    expect(within(h.form()).getAllByText(/\.txt$/)).toHaveLength(2),
  );
  await userEvent.type(h.input(), "caption");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  await act(async () => {
    h.uploadCalls[0]?.result.resolve(uploadDescriptor("ready.txt"));
  });
  await waitFor(() => expect(h.uploadCalls).toHaveLength(2));
  await act(async () => {
    h.uploadCalls[1]?.result.reject(new Error("relay down"));
  });
  await screen.findAllByRole("alert");
  expect(screen.getAllByRole("alert").map((node) => node.textContent)).toEqual([
    "retry.txt: relay down",
  ]);
  expect(screen.getByText("Upload failed: relay down")).toBeVisible();
  expect(h.input()).toHaveValue("caption");
  expect(h.publish).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await waitFor(() => expect(h.uploadCalls).toHaveLength(3));
  expect(within(h.form()).getByText(/Uploading/)).toBeVisible();
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(3));
  expect(h.uploadCalls[2]?.file.name).toBe("retry.txt");
  await act(async () => {
    h.uploadCalls[2]?.result.resolve(uploadDescriptor("retry.txt"));
  });
  await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
  expect(h.publish.mock.calls[0]?.[0].content).toContain("caption");
  expect(h.publish.mock.calls[0]?.[0].content).toContain("[ready.txt](<");
  expect(h.publish.mock.calls[0]?.[0].content).toContain("[retry.txt](<");
});

it("finishes a background send in its original channel after the composer unmounts", async () => {
  const h = await mountUploadComposer();
  attachByPaste(h.input(), attachmentFile("ready.txt"));
  attachByPaste(h.input(), attachmentFile("late.txt"));
  await waitFor(() =>
    expect(within(h.form()).getAllByText(/\.txt$/)).toHaveLength(2),
  );
  await userEvent.type(h.input(), "caption");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  await act(async () => {
    h.uploadCalls[0]?.result.resolve(uploadDescriptor("ready.txt"));
  });
  await waitFor(() => expect(h.uploadCalls).toHaveLength(2));

  h.unmount();
  expect(h.uploadCalls[1]?.signal.aborted).toBe(false);
  await act(async () => {
    h.uploadCalls[1]?.result.resolve(uploadDescriptor("late.txt"));
  });
  await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
  const event = h.publish.mock.calls[0]?.[0];
  expect(event?.tags).toContainEqual(["h", "channel"]);
  expect(event?.content).toContain("caption");
  expect(event?.content).toContain("[ready.txt](<");
  expect(event?.content).toContain("[late.txt](<");
  expect(h.sign).toHaveBeenCalledTimes(1);
});

it("keeps a background send on its original thread when the composer moves", async () => {
  const root = "b".repeat(64);
  const h = await mountUploadComposer({ threadRootId: root });
  attachByPaste(h.input(), attachmentFile());
  await waitFor(() => expect(h.send()).toBeEnabled());
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  h.rerender(
    <MessageComposer
      session={h.owner.session}
      scope={`https://relay.example.test:${h.owner.session.viewer}`}
      channelId="channel"
      channelName="General"
      threadRootId={"c".repeat(64)}
    />,
  );
  expect(h.uploadCalls[0]?.signal.aborted).toBe(false);
  await act(async () => {
    h.uploadCalls[0]?.result.resolve(uploadDescriptor());
  });
  await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
  const tags = h.publish.mock.calls[0]?.[0].tags ?? [];
  expect(tags).toContainEqual(["e", root, "", "reply"]);
  expect(tags.flat()).not.toContain("c".repeat(64));
});

it("keeps a background reply on the parent captured at Send", async () => {
  const root = "a".repeat(64);
  const child = "b".repeat(64);
  const h = await mountUploadComposer({
    threadRootId: root,
    replyParentId: child,
  });
  attachByPaste(h.input(), attachmentFile("reply.txt"));
  await waitFor(() => expect(h.send()).toBeEnabled());
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  h.rerender(
    <MessageComposer
      session={h.owner.session}
      scope={`https://relay.example.test:${h.owner.session.viewer}`}
      channelId="channel"
      channelName="General"
      threadRootId={root}
    />,
  );
  expect(h.uploadCalls[0]?.signal.aborted).toBe(false);
  await act(async () => {
    h.uploadCalls[0]?.result.resolve(uploadDescriptor("reply.txt"));
  });
  await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
  expect(h.publish.mock.calls[0]?.[0].tags).toContainEqual([
    "e",
    child,
    "",
    "reply",
  ]);
});

it("blocks Send in a conversation until its background send settles", async () => {
  const h = await mountUploadComposer();
  attachByPaste(h.input(), attachmentFile("one.txt"));
  await userEvent.type(h.input(), "look at this");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  expect(h.input()).toHaveValue("");

  // Composition stays open; only Send waits, so the text cannot overtake.
  await userEvent.type(h.input(), "thoughts?");
  expect(h.input()).toHaveValue("thoughts?");
  expect(h.send()).toBeDisabled();
  fireEvent.submit(h.form());
  await act(async () => {});
  expect(h.publish).not.toHaveBeenCalled();

  await act(async () => {
    h.uploadCalls[0]?.result.resolve(uploadDescriptor("one.txt"));
  });
  await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(h.send()).toBeEnabled());
  fireEvent.click(h.send());
  await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(2));
  expect(h.publish.mock.calls[0]?.[0].content).toContain("look at this");
  expect(h.publish.mock.calls[1]?.[0].content).toBe("thoughts?");
});

it("cancels the newest background send, restores its draft and leaves older sends running", async () => {
  const root = "b".repeat(64);
  const h = await mountUploadComposer();
  attachByPaste(h.input(), attachmentFile("one.txt"));
  await userEvent.type(h.input(), "first");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));

  h.rerender(
    <MessageComposer
      session={h.owner.session}
      scope={`https://relay.example.test:${h.owner.session.viewer}`}
      channelId="channel"
      channelName="General"
      threadRootId={root}
    />,
  );
  attachByPaste(h.input(), attachmentFile("two.txt"));
  await userEvent.type(h.input(), "second");
  await waitFor(() => expect(h.send()).toBeEnabled());
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(2));
  expect(h.input()).toHaveValue("");

  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(h.uploadCalls[1]?.signal.aborted).toBe(true);
  expect(h.uploadCalls[0]?.signal.aborted).toBe(false);
  await waitFor(() => expect(h.input()).toHaveValue("second"));
  expect(within(h.form()).getByText("two.txt")).toBeVisible();
  expect(screen.queryByText(/^Upload failed: /)).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Upload paused. Retry to continue.",
  );

  await act(async () => {
    h.uploadCalls[0]?.result.resolve(uploadDescriptor("one.txt"));
    h.uploadCalls[1]?.result.resolve(uploadDescriptor("two.txt"));
  });
  await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
  expect(h.publish.mock.calls[0]?.[0].content).toContain("first");
  expect(h.publish.mock.calls[0]?.[0].content).toContain("[one.txt](<");
  expect(h.publish.mock.calls[0]?.[0].tags).not.toContainEqual([
    "e",
    root,
    "",
    "root",
  ]);
  expect(screen.queryByText(/^Uploading/)).toBeNull();
});

it.each([
  ["an unrelated channel's access is revoked", "revoke"],
  ["the cache is cleared", "clear"],
] as const)("restores a background send when %s", async (_case, trigger) => {
  const h = await mountUploadComposer();
  if (trigger === "revoke") await h.otherMembership(true);
  attachByPaste(h.input(), attachmentFile());
  await userEvent.type(h.input(), "caption");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  expect(h.input()).toHaveValue("");

  if (trigger === "revoke") await h.otherMembership(false);
  else await act(() => h.owner.clearCache());
  expect(h.uploadCalls[0]?.signal.aborted).toBe(true);
  await act(async () => {
    h.uploadCalls[0]?.result.resolve(uploadDescriptor());
  });
  await waitFor(() => expect(h.input()).toHaveValue("caption"));
  expect(within(h.form()).getByText("notes.txt")).toBeVisible();
  expect(screen.getByText(/^Upload failed: /)).toBeVisible();
  expect(screen.queryByText(/^Uploading/)).toBeNull();
  expect(h.publish).not.toHaveBeenCalled();
});

it("uses transferred sizes after image preparation and resets unknown totals on retry", async () => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:photo"),
      revokeObjectURL: vi.fn(),
    }),
  );
  const h = await mountUploadComposer();
  // A GIF comment is metadata: preparation strips it before transfer.
  const gif = new File(
    [
      new Uint8Array([
        ...new TextEncoder().encode("GIF89a"),
        1,
        0,
        1,
        0,
        0,
        0,
        0,
        0x21,
        0xfe,
        4,
        1,
        2,
        3,
        4,
        0,
        0x3b,
      ]),
    ],
    "photo.gif",
    { type: "image/gif" },
  );
  attachByPaste(h.input(), gif);
  attachByPaste(h.input(), attachmentFile("note.txt", "1234567890"));
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  const first = h.uploadCalls[0];
  expect(first?.file.size).toBeLessThan(gif.size);
  const bar = screen.getByRole("progressbar", { name: "Uploading" });
  act(() => first?.progress?.(first.file.size, first.file.size));
  // The next file has not been prepared: its transfer size is still unknown.
  expect(bar).not.toHaveAttribute("aria-valuenow");
  await act(async () =>
    first?.result.resolve({
      ...uploadDescriptor("photo.gif"),
      size: first.file.size,
    }),
  );
  await waitFor(() => expect(h.uploadCalls).toHaveLength(2));
  act(() => h.uploadCalls[1]?.progress?.(5, 10));
  const expected = Math.round(
    (((first?.file.size ?? 0) + 5) / ((first?.file.size ?? 0) + 10)) * 100,
  );
  expect(bar).toHaveAttribute("aria-valuenow", String(expected));
  expect(bar.firstElementChild).toHaveStyle({
    transform: `scaleX(${((first?.file.size ?? 0) + 5) / ((first?.file.size ?? 0) + 10)})`,
  });
  expect(h.publish).not.toHaveBeenCalled();
  await act(async () =>
    h.uploadCalls[1]?.result.reject(new Error("relay down")),
  );
  await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(3));
  const retryBar = screen.getByRole("progressbar", { name: "Uploading" });
  expect(retryBar).not.toHaveAttribute("aria-valuenow");
  act(() => h.uploadCalls[2]?.progress?.(2, 20));
  expect(retryBar).toHaveAttribute(
    "aria-valuenow",
    String(
      Math.round(
        (((first?.file.size ?? 0) + 2) / ((first?.file.size ?? 0) + 20)) * 100,
      ),
    ),
  );
  await act(async () =>
    h.uploadCalls[2]?.result.resolve({
      ...uploadDescriptor("note.txt"),
      size: 10,
    }),
  );
  await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
});

it("fills the bar for a single-chunk upload while its response is held", async () => {
  const h = await mountUploadComposer();
  attachByPaste(h.input(), attachmentFile());
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  const bar = screen.getByRole("progressbar", { name: "Uploading" });
  expect(bar).not.toHaveAttribute("aria-valuenow");
  // The host's only report for a body within one chunk is the whole body.
  act(() => h.uploadCalls[0]?.progress?.(5, 5));
  expect(bar).toHaveAttribute("aria-valuenow", "100");
  expect(screen.getByText("Uploading", { exact: true })).toBeVisible();
  expect(h.publish).not.toHaveBeenCalled();
  await act(async () => {
    h.uploadCalls[0]?.result.resolve(uploadDescriptor());
  });
  await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("progressbar")).toBeNull();
});

it("never publishes a background send after its session closes", async () => {
  const h = await mountUploadComposer();
  attachByPaste(h.input(), attachmentFile());
  await userEvent.type(h.input(), "caption");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  expect(screen.getByText("Uploading", { exact: true })).toBeVisible();

  act(() => h.owner.dispose());
  expect(h.uploadCalls[0]?.signal.aborted).toBe(true);
  await act(async () => {
    h.uploadCalls[0]?.result.resolve(uploadDescriptor());
  });
  await waitFor(() => expect(screen.queryByText(/^Uploading/)).toBeNull());
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.sign).not.toHaveBeenCalled();
});

it("retries publish-unknown attachment sends with the same signed event and no re-upload", async () => {
  let attempts = 0;
  const h = await mountUploadComposer({
    publish: async () => {
      attempts++;
      if (attempts === 1) throw new Error("lost acknowledgement");
    },
  });
  attachByPaste(h.input(), attachmentFile());
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  await act(async () => {
    h.uploadCalls[0]?.result.resolve(uploadDescriptor());
  });
  await waitFor(() =>
    expect(h.owner.session.outbox?.snapshot()[0]?.delivery).toBe("unknown"),
  );
  const firstEvent = h.publish.mock.calls[0]?.[0];
  if (!firstEvent) throw new Error("Missing first publish");
  h.owner.session.messages.retry(firstEvent.id);
  await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(2));
  expect(h.publish.mock.calls[1]?.[0]).toEqual(firstEvent);
  expect(h.sign).toHaveBeenCalledTimes(1);
  expect(h.uploadCalls).toHaveLength(1);
});

it("opens the model picker while discovery is pending, then fills its controls", async () => {
  const models = {
    current: "fast",
    models: [
      {
        id: "fast",
        label: "Fast",
        efforts: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ],
  };
  const pending = deferred<typeof models>();
  const snapshot = {
    status: "ready",
    agents: [
      {
        key: first.pubkey,
        pubkey: first.pubkey,
        name: "Honey",
        type: "test/agent",
      },
    ],
  };
  const types = [{ key: "test/agent", models: () => pending.promise }];
  const agents = {
    find: (pubkey: string) =>
      snapshot.agents.find((agent) => agent.pubkey === pubkey),
    joinable: () => [],
    sessionState: () => "unavailable" as const,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    types: () => types,
  } as unknown as Agents;
  const h = mount({}, undefined, undefined, agents);
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  await h.user.click(screen.getByRole("button", { name: /Model.*effort/ }));
  expect(
    screen.getByText("Loading model and effort…").closest("[role=status]"),
  ).toHaveAttribute("aria-busy", "true");
  await act(async () => {
    pending.resolve(models);
  });
  expect(
    await screen.findByLabelText("Effort for Honey's next run"),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("Loading model and effort…"),
  ).not.toBeInTheDocument();
});

/** Honey, whose type offers High effort, and a type it can be retyped to
 * whose discovery is pending or failed. */
function retypableHoney(other: "pending" | "failed") {
  const tunable = {
    current: "fast",
    models: [
      {
        id: "fast",
        label: "Fast",
        efforts: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ],
  };
  const agent = {
    key: first.pubkey,
    pubkey: first.pubkey,
    name: "Honey",
    type: "test/agent",
  };
  let snapshot = { status: "ready", agents: [agent] };
  const listeners = new Set<() => void>();
  const listing = { fails: false };
  const types = [
    {
      key: "test/agent",
      models: () =>
        listing.fails ? Promise.reject(new Error("offline")) : tunable,
    },
    {
      key: "test/other",
      models: () =>
        other === "pending"
          ? new Promise(() => {})
          : Promise.reject(new Error("offline")),
    },
  ];
  const agents = {
    find: (pubkey: string) =>
      snapshot.agents.find((agent) => agent.pubkey === pubkey),
    joinable: () => [],
    sessionState: () => "unavailable" as const,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
    types: () => types,
  } as unknown as Agents;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const h = mount({}, undefined, undefined, agents);
  /** A new snapshot of Honey, of `type`; discovery runs again. */
  const refresh = (type = agent.type) =>
    act(() => {
      snapshot = { status: "ready", agents: [{ ...agent, type }] };
      for (const listener of listeners) listener();
    });
  const pickHigh = async () => {
    await h.user.click(screen.getByRole("button", { name: "First Honey" }));
    await h.user.click(
      await screen.findByRole("button", { name: /Model.*effort/ }),
    );
    const slider = await screen.findByLabelText("Effort for Honey's next run");
    slider.focus();
    await h.user.keyboard("{ArrowRight}");
    expect(slider).toHaveAttribute("aria-valuetext", "High");
    await h.user.keyboard("{Escape}");
  };
  const sentPick = async () => {
    await h.user.click(screen.getByRole("button", { name: "Send message" }));
    expect(h.messages.send).toHaveBeenCalledOnce();
    return h.messages.send.mock.calls[0]?.[6]?.[first.pubkey];
  };
  return { h, listing, refresh, pickHigh, sentPick };
}

it.each(["pending", "failed"] as const)(
  "drops a pick made for the agent's previous type while the new type's discovery is %s",
  async (discovery) => {
    const honey = retypableHoney(discovery);
    await honey.pickHigh();
    // Retyped elsewhere: the new type's choices never show the old pick.
    honey.refresh("test/other");
    expect(await honey.sentPick()).toBeUndefined();
  },
);

it("drops a pick when its agent is retyped while the picker is unmounted", async () => {
  const honey = retypableHoney("pending");
  await honey.pickHigh();
  // Without a mention the picker unmounts; the draft keeps the pick.
  honey.h.fill("hi");
  honey.refresh("test/other");
  await honey.h.user.click(screen.getByRole("button", { name: "First Honey" }));
  expect(await honey.sentPick()).toBeUndefined();
});

it("keeps a pick through a failed discovery of the agent's same type", async () => {
  const honey = retypableHoney("pending");
  await honey.pickHigh();
  honey.listing.fails = true;
  honey.refresh();
  await honey.h.user.click(
    await screen.findByRole("button", { name: /Model.*effort/ }),
  );
  await screen.findByText("Model and effort could not be loaded.");
  honey.listing.fails = false;
  await honey.h.user.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByLabelText("Effort for Honey's next run");
  await honey.h.user.keyboard("{Escape}");
  expect(await honey.sentPick()).toEqual({ effort: "high" });
});

/** Agents with none here yet, where an earlier Buzz saved `first` and `second`. */
const oldBuzzAgents = () => {
  const port = vi.fn<Agents["port"]>(async () => ({
    agent: {} as never,
    notes: [],
  }));
  const snapshot = { status: "ready", agents: [] };
  const types = [{ key: "test/agent", title: "Test agent" }];
  const agents = {
    sessionState: () => "unavailable" as const,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    types: () => types,
    find: () => undefined,
    joinable: () => [],
    portable: async () => ({
      agents: [first, second].map((agent) => ({
        ...agent,
        source: "installed",
        relay: "wss://relay.example.test",
      })),
      teams: [],
      warnings: [],
      here: [],
    }),
    port,
  } as unknown as Agents;
  return { agents, port };
};

it("Enter on import entry keeps the draft without importing or sending", async () => {
  const { agents, port } = oldBuzzAgents();
  const h = mount({}, undefined, undefined, agents);
  fireEvent.click(screen.getByRole("button", { name: "First Honey" }));
  h.submit();
  await screen.findByRole("dialog", { name: "Import Honey?" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus(),
  );
  await userEvent.setup().keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(h.input()).toHaveValue("@Honey ");
  expect(port).not.toHaveBeenCalled();
  expect(h.messages.send).not.toHaveBeenCalled();
});

it("imports a mentioned agent an earlier Buzz runs before sending to it", async () => {
  const { agents, port } = oldBuzzAgents();
  const h = mount({}, undefined, undefined, agents);
  fireEvent.click(screen.getByRole("button", { name: "First Honey" }));
  h.submit();
  const dialog = await screen.findByRole("dialog", { name: "Import Honey?" });
  expect(dialog).toHaveTextContent(
    "Honey is set up in the preview version of Buzz. Are you ready to import it to Buzz 1.0?",
  );
  expect(h.messages.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Import and send" }));
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(port).toHaveBeenCalledExactlyOnceWith({
    source: "installed",
    pubkey: first.pubkey,
    type: "test/agent",
  });
  expect(h.messages.send.mock.calls[0]?.slice(0, 3)).toEqual([
    "channel",
    "@Honey ",
    [first.pubkey],
  ]);
});

it("sends without importing, and asks about that agent no more", async () => {
  const { agents, port } = oldBuzzAgents();
  const h = mount({}, undefined, undefined, agents);
  fireEvent.click(screen.getByRole("button", { name: "Second Honey" }));
  h.submit();
  await screen.findByRole("dialog", { name: "Import Honey?" });
  fireEvent.click(screen.getByRole("button", { name: "Just send" }));
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Second Honey" }));
  h.submit();
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(port).not.toHaveBeenCalled();
});

it("shows what an import still needs before sending", async () => {
  const { agents, port } = oldBuzzAgents();
  port.mockResolvedValueOnce({
    agent: {} as never,
    notes: ["Honey's picture didn't come over."],
  });
  const h = mount({}, undefined, undefined, agents);
  fireEvent.click(screen.getByRole("button", { name: "First Honey" }));
  h.submit();
  await screen.findByRole("dialog", { name: "Import Honey?" });
  fireEvent.click(screen.getByRole("button", { name: "Import and send" }));
  const done = await screen.findByRole("dialog", {
    name: "Honey was imported",
  });
  expect(done).toHaveTextContent("Honey's picture didn't come over.");
  expect(h.messages.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(port).toHaveBeenCalledOnce();
});

it.each([
  ["without notes", []],
  ["with notes", ["Honey's picture didn't come over."]],
])(
  "drops an import that finishes %s after its send stopped",
  async (_, notes) => {
    const { agents, port } = oldBuzzAgents();
    const late = deferred<Awaited<ReturnType<Agents["port"]>>>();
    port.mockReturnValueOnce(late.promise);
    const h = mount({}, undefined, undefined, agents);
    fireEvent.click(screen.getByRole("button", { name: "First Honey" }));
    h.submit();
    await screen.findByRole("dialog", { name: "Import Honey?" });
    fireEvent.click(screen.getByRole("button", { name: "Import and send" }));
    h.retarget({ disabled: true });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    h.retarget({ disabled: false });
    h.submit();
    await screen.findByRole("dialog", { name: "Import Honey?" });
    await act(async () => late.resolve({ agent: {} as never, notes }));
    expect(
      screen.getByRole("dialog", { name: "Import Honey?" }),
    ).toBeInTheDocument();
    expect(h.messages.send).not.toHaveBeenCalled();
  },
);

it("keeps focus on the import action while it runs, fails and finishes", async () => {
  const { agents, port } = oldBuzzAgents();
  const failed = deferred<Awaited<ReturnType<Agents["port"]>>>();
  const done = deferred<Awaited<ReturnType<Agents["port"]>>>();
  port.mockReturnValueOnce(failed.promise).mockReturnValueOnce(done.promise);
  const h = mount({}, undefined, undefined, agents);
  fireEvent.click(screen.getByRole("button", { name: "First Honey" }));
  h.submit();
  await screen.findByRole("dialog", { name: "Import Honey?" });
  const action = screen.getByRole("button", { name: "Import and send" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus(),
  );
  await userEvent.setup().click(action);
  expect(action).toHaveAttribute("aria-busy", "true");
  expect(action).toHaveFocus();
  await act(async () => failed.reject(new Error("No disk space.")));
  expect(await screen.findByRole("alert")).toHaveTextContent("No disk space.");
  expect(action).toHaveFocus();
  fireEvent.click(action);
  await act(async () =>
    done.resolve({ agent: {} as never, notes: ["Honey stays archived."] }),
  );
  await screen.findByRole("dialog", { name: "Honey was imported" });
  expect(action).toHaveTextContent("Send");
  expect(action).toHaveFocus();
  expect(h.messages.send).not.toHaveBeenCalled();
});

it("asks again when a send without importing stops at a later prompt", async () => {
  const { agents, port } = oldBuzzAgents();
  const h = mount({}, undefined, undefined, agents);
  const list = {
    status: "ready",
    channels: [
      { id: "channel", channelType: "stream", members: ["d".repeat(64)] },
    ],
  };
  Object.assign(h.session, {
    viewer: "d".repeat(64),
    channels: { list: () => list, subscribeList: () => () => {} },
    memberAdditions: { add: vi.fn() },
  });
  act(() => h.commands().insertMention(first));
  h.submit();
  await screen.findByRole("dialog", { name: "Import Honey?" });
  fireEvent.click(screen.getByRole("button", { name: "Just send" }));
  await screen.findByRole("button", { name: "Invite" });
  await userEvent.setup().keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  h.submit();
  expect(
    await screen.findByRole("dialog", { name: "Import Honey?" }),
  ).toBeInTheDocument();
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(port).not.toHaveBeenCalled();
});

it("keeps the draft when the import dialog is closed", async () => {
  const { agents, port } = oldBuzzAgents();
  const h = mount({}, undefined, undefined, agents);
  fireEvent.click(screen.getByRole("button", { name: "First Honey" }));
  const draft = h.input().value;
  h.submit();
  await screen.findByRole("dialog", { name: "Import Honey?" });
  await userEvent.setup().keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(h.input()).toHaveValue(draft);
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(port).not.toHaveBeenCalled();
});

/** Agents of one type whose sessions have `scope`, with one model and no
 * efforts unless `models` are given. */
const sessionAgents = (
  scope: "thread" | "channel",
  models: readonly {
    id: string;
    label: string;
    efforts: readonly { id: string; label: string }[];
  }[] = [{ id: "fast", label: "Fast", efforts: [] }],
  pubkeys: readonly string[] = [first.pubkey],
) => {
  const snapshot = {
    status: "ready",
    agents: pubkeys.map((pubkey) => ({
      key: pubkey,
      pubkey,
      name: "Honey",
      type: "test/agent",
    })),
  };
  let state: "idle" | "active" | "compacting" | "unavailable" = "idle";
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const serviceListeners = new Set<() => void>();
  const types = [
    {
      key: "test/agent",
      models: () => ({ current: "fast", models }),
      sessionControls: {
        scope: () => scope,
        state: () => state,
        run: async () => {},
        subscribe,
      },
    },
  ];
  const session = vi.fn<Agents["session"]>(async () => {});
  return {
    subscribe: (listener: () => void) => {
      serviceListeners.add(listener);
      return () => {
        serviceListeners.delete(listener);
      };
    },
    snapshot: () => snapshot,
    types: () => types,
    find: (pubkey: string) =>
      snapshot.agents.find((agent) => agent.pubkey === pubkey),
    joinable: () => [],
    sessionState: () => state,
    session,
    setSessionState(
      next: typeof state,
      source: "harness" | "agents" = "harness",
    ) {
      state = next;
      for (const listener of source === "agents" ? serviceListeners : listeners)
        listener();
    },
  } as unknown as Agents & {
    session: typeof session;
    setSessionState(next: typeof state, source?: "harness" | "agents"): void;
  };
};

it("restores an attachment draft instead of publishing when compaction starts during upload", async () => {
  const agents = sessionAgents("channel");
  const h = await mountUploadComposer({
    agents,
    members: [first.pubkey],
    defaultMention: first,
  });
  attachByPaste(h.input(), attachmentFile("waiting.txt"));
  await userEvent.type(h.input(), "keep this caption");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  await waitFor(() => expect(h.input()).toHaveValue(""));
  act(() => agents.setSessionState("compacting"));
  await act(async () => {
    h.uploadCalls[0]?.result.resolve(uploadDescriptor("waiting.txt"));
  });
  await waitFor(() =>
    expect(h.input()).toHaveValue("keep this caption@Honey "),
  );
  expect(screen.getByText("waiting.txt")).toBeVisible();
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.send()).toHaveAttribute("aria-disabled", "true");
  act(() => agents.setSessionState("idle"));
  fireEvent.click(h.send());
  await waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
  expect(h.publish.mock.calls[0]?.[0].content).toContain("keep this caption");
});

it("refreshes unavailable session buttons when runner ownership changes without changing the agent", async () => {
  const agents = sessionAgents("channel");
  agents.setSessionState("unavailable", "agents");
  const h = mount({}, undefined, undefined, agents);
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  await h.user.click(
    await screen.findByRole("button", {
      name: /Model.*effort/,
    }),
  );
  const compact = await screen.findByRole("button", {
    name: "Compact session",
  });
  const fresh = screen.getByRole("button", { name: "Start a new session" });
  const interrupt = screen.getByRole("button", { name: "Interrupt" });
  expect(compact).toHaveAttribute("aria-disabled", "true");
  expect(fresh).toHaveAttribute("aria-disabled", "true");
  expect(interrupt).toHaveAttribute("aria-disabled", "true");
  act(() => agents.setSessionState("idle", "agents"));
  expect(compact).not.toHaveAttribute("aria-disabled", "true");
  expect(fresh).not.toHaveAttribute("aria-disabled", "true");
  expect(interrupt).toHaveAttribute("aria-disabled", "true");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await act(async () => fireEvent.click(fresh));
    expect(agents.session).toHaveBeenCalledWith(
      first.pubkey,
      { channelId: "channel" },
      "new",
    );
    expect(
      within(screen.getByRole("group", { name: "Honey's session" })).getByRole(
        "status",
      ),
    ).toHaveTextContent("New session started");
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "New session started",
    );
    act(() => vi.advanceTimersByTime(2999));
    expect(
      within(screen.getByRole("group", { name: "Honey's session" })).getByRole(
        "status",
      ),
    ).toHaveTextContent("New session started");
    // A repeated attempt clears the live announcement, then announces its
    // own success and restarts the full feedback interval.
    const announcement = within(
      screen.getByRole("group", { name: "Honey's session" }),
    ).getByRole("status");
    const pending = deferred<void>();
    agents.session.mockImplementationOnce(() => pending.promise);
    try {
      await act(async () => fireEvent.click(fresh));
      expect(agents.session).toHaveBeenCalledTimes(2);
      expect(announcement).toBeInTheDocument();
      expect(announcement).toBeEmptyDOMElement();
    } finally {
      await act(async () => pending.resolve());
    }
    expect(announcement).toHaveTextContent("New session started");
    act(() => fresh.focus());
    await act(async () => fireEvent.keyDown(fresh, { key: "Escape" }));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(fresh).toHaveFocus();
    expect(announcement).toHaveTextContent("New session started");
    act(() => vi.advanceTimersByTime(2999));
    expect(
      within(screen.getByRole("group", { name: "Honey's session" })).getByRole(
        "status",
      ),
    ).toHaveTextContent("New session started");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("New session started")).not.toBeInTheDocument();
    expect(fresh).not.toHaveAttribute("aria-disabled", "true");

    // A failed retry inside the success interval must replace the prior
    // success feedback rather than show success alongside the error.
    await act(async () => fireEvent.click(fresh));
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "New session started",
    );
    const retry = deferred<void>();
    agents.session.mockImplementationOnce(() => retry.promise);
    try {
      await act(async () => fireEvent.click(fresh));
      expect(agents.session).toHaveBeenCalledTimes(4);
      expect(announcement).toBeEmptyDOMElement();
    } finally {
      await act(async () => retry.reject(new Error("Disk is full")));
    }
    expect(screen.getByText("Disk is full")).toBeInTheDocument();
    expect(announcement).toBeEmptyDOMElement();
    await act(async () => fireEvent.mouseLeave(fresh));
    await act(async () => fireEvent.mouseEnter(fresh));
    await act(async () => fireEvent.mouseMove(fresh));
    act(() => vi.advanceTimersByTime(HELPFUL_HINT_REST_MS));
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Start a new session",
    );
    expect(screen.queryByText("New session started")).not.toBeInTheDocument();
    expect(fresh).not.toHaveAttribute("aria-disabled", "true");
  } finally {
    vi.useRealTimers();
  }
});

it("acts on the idle session immediately and keeps Send independent while active", async () => {
  const agents = sessionAgents("channel");
  const h = mount({}, undefined, undefined, agents);
  await h.user.type(h.input(), "tidy up");
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  await h.user.click(
    await screen.findByRole("button", {
      name: /Model.*effort/,
    }),
  );
  const compact = await screen.findByRole("button", {
    name: "Compact session",
  });
  const fresh = screen.getByRole("button", { name: "Start a new session" });
  const interrupt = screen.getByRole("button", {
    name: "Interrupt",
  });
  expect(compact).not.toHaveAttribute("aria-disabled", "true");
  expect(fresh).not.toHaveAttribute("aria-disabled", "true");
  expect(interrupt).toHaveAttribute("aria-disabled", "true");
  await h.user.click(compact);
  expect(agents.session).toHaveBeenCalledWith(
    first.pubkey,
    { channelId: "channel" },
    "compact",
  );
  expect(h.messages.send).not.toHaveBeenCalled();
  await h.user.click(fresh);
  expect(agents.session).toHaveBeenLastCalledWith(
    first.pubkey,
    { channelId: "channel" },
    "new",
  );
  act(() => agents.setSessionState("active"));
  expect(compact).toHaveAttribute("aria-disabled", "true");
  expect(fresh).toHaveAttribute("aria-disabled", "true");
  expect(interrupt).not.toHaveAttribute("aria-disabled", "true");
  await h.user.click(compact);
  expect(agents.session).toHaveBeenCalledTimes(2);
  await h.user.click(interrupt);
  expect(agents.session).toHaveBeenLastCalledWith(
    first.pubkey,
    { channelId: "channel" },
    "interrupt",
  );
  await h.user.keyboard("{Escape}");
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.send).toHaveBeenLastCalledWith(
    "channel",
    expect.stringContaining("tidy up"),
    [first.pubkey],
    [],
  );
});

it.each(["success", "failure", "interrupt"] as const)(
  "blocks sending during compaction, preserves editing, and recovers after %s",
  async (outcome) => {
    const agents = sessionAgents("channel");
    const pending = deferred<void>();
    agents.session.mockImplementation(async (_pubkey, _place, action) => {
      if (action === "compact") await pending.promise;
    });
    const h = mount({}, undefined, undefined, agents);
    await h.user.type(h.input(), "saved draft ");
    await h.user.click(screen.getByRole("button", { name: "First Honey" }));
    await h.user.click(
      await screen.findByRole("button", {
        name: /Model.*effort/,
      }),
    );
    const compact = await screen.findByRole("button", {
      name: "Compact session",
    });
    await h.user.click(compact);
    expect(agents.session).toHaveBeenCalledWith(
      first.pubkey,
      { channelId: "channel" },
      "compact",
    );
    act(() => agents.setSessionState("compacting"));
    try {
      expect(compact).toHaveAttribute("aria-busy", "true");
      expect(compact).toHaveAttribute("aria-disabled", "true");
      expect(
        screen.getByRole("button", { name: "Start a new session" }),
      ).toHaveAttribute("aria-disabled", "true");
      const interrupt = screen.getByRole("button", { name: "Interrupt" });
      expect(interrupt).not.toHaveAttribute("aria-disabled", "true");
      expect(screen.getByText("Compacting session…")).toBeInTheDocument();
      await h.user.keyboard("{Escape}");
      const send = screen.getByRole("button", { name: "Send message" });
      expect(send).toHaveAttribute("aria-disabled", "true");
      await h.user.type(h.input(), "keep editing{Enter}");
      await h.user.click(send);
      fireEvent.submit(screen.getByRole("form"));
      expect(h.messages.send).not.toHaveBeenCalled();
      expect(h.input()).toHaveTextContent("saved draft");
      expect(h.input()).toHaveTextContent("keep editing");
      if (outcome === "interrupt") {
        await h.user.click(
          screen.getByRole("button", {
            name: /Model.*effort/,
          }),
        );
        await h.user.click(screen.getByRole("button", { name: "Interrupt" }));
        expect(agents.session).toHaveBeenLastCalledWith(
          first.pubkey,
          { channelId: "channel" },
          "interrupt",
        );
        await h.user.keyboard("{Escape}");
      }
    } finally {
      await act(async () => {
        if (outcome === "success") pending.resolve();
        else
          pending.reject(
            new Error(
              outcome === "failure"
                ? "Compaction failed"
                : "Compaction interrupted",
            ),
          );
        agents.setSessionState("idle");
      });
    }
    expect(screen.queryByText("Compacting session…")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    await h.user.click(screen.getByRole("button", { name: "Send message" }));
    expect(h.messages.send).toHaveBeenCalledOnce();
    expect(h.messages.send.mock.calls[0]?.[1]).toContain("keep editing");
  },
);

it("blocks plain-text DM sends during compaction even after removing the mention", async () => {
  const agents = sessionAgents("thread");
  const pending = deferred<void>();
  agents.session.mockReturnValueOnce(pending.promise);
  const h = mount({}, undefined, second.pubkey, agents);
  const dm = {
    status: "ready" as const,
    channels: [
      {
        id: "channel",
        name: "Honey DM",
        channelType: "dm" as const,
        members: [first.pubkey, second.pubkey],
      },
    ],
  };
  h.retarget({
    session: {
      ...h.session,
      channels: {
        ...h.session.channels,
        list: () => dm,
        get: () => dm.channels[0],
      },
    },
  });
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  await h.user.click(
    await screen.findByRole("button", { name: /Model.*effort/ }),
  );
  await h.user.click(
    await screen.findByRole("button", { name: "Compact session" }),
  );
  expect(agents.session).toHaveBeenCalledWith(
    first.pubkey,
    { channelId: "channel" },
    "compact",
  );
  act(() => agents.setSessionState("compacting"));
  try {
    await h.user.keyboard("{Escape}");
    await h.user.clear(h.input());
    await h.user.type(h.input(), "plain text");
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Compacting session…")).toBeVisible();
    await h.user.keyboard("{Enter}");
    await h.user.click(send);
    fireEvent.submit(screen.getByRole("form"));
    expect(h.messages.send).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      pending.resolve();
      agents.setSessionState("idle");
    });
  }
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.send).toHaveBeenCalledWith("channel", "plain text", [], []);
});

it("offers a one-to-one DM's agent its model and effort without a mention", async () => {
  const agents = sessionAgents("channel", [
    {
      id: "fast",
      label: "Fast",
      efforts: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    },
  ]);
  const h = mount({}, undefined, second.pubkey, agents);
  const dm = (members: string[]) => ({
    status: "ready" as const,
    channels: [
      { id: "channel", name: "Honey DM", channelType: "dm" as const, members },
    ],
  });
  const retarget = (members: string[]) => {
    const list = dm(members);
    h.retarget({
      session: {
        ...h.session,
        channels: {
          ...h.session.channels,
          list: () => list,
          get: () => list.channels[0],
        },
      },
    });
  };
  const picker = () => screen.queryByRole("button", { name: /Model.*effort/ });
  // A group DM still needs the mention.
  retarget([first.pubkey, second.pubkey, "c".repeat(64)]);
  await h.user.type(h.input(), "think hard");
  expect(picker()).toBeNull();
  retarget([first.pubkey, second.pubkey]);
  await h.user.click(
    await screen.findByRole("button", { name: /Model.*effort/ }),
  );
  expect(
    await screen.findByRole("button", { name: "Compact session" }),
  ).toBeVisible();
  const slider = await screen.findByLabelText("Effort for Honey's next run");
  slider.focus();
  await h.user.keyboard("{ArrowRight}");
  expect(slider).toHaveAttribute("aria-valuetext", "High");
  await h.user.keyboard("{Escape}");
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.send).toHaveBeenLastCalledWith(
    "channel",
    "think hard",
    [],
    [],
    undefined,
    [],
    { [first.pubkey]: { effort: "high" } },
  );
});

it("keeps session controls available when model discovery fails", async () => {
  const agents = sessionAgents("channel");
  const type = agents.types()[0];
  if (!type) throw new Error("Missing fixture type");
  vi.spyOn(type, "models").mockImplementation(() => {
    throw new Error("Catalog unavailable");
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const h = mount({}, undefined, undefined, agents);
    await h.user.click(screen.getByRole("button", { name: "First Honey" }));
    await h.user.click(
      await screen.findByRole("button", { name: /Model.*effort/ }),
    );
    await h.user.click(
      await screen.findByRole("button", { name: "Start a new session" }),
    );
    expect(agents.session).toHaveBeenCalledWith(
      first.pubkey,
      { channelId: "channel" },
      "new",
    );
    expect(
      screen.getByRole("button", { name: /Model.*effort/ }),
    ).toHaveAccessibleName("Model, effort, and session controls");
  } finally {
    warn.mockRestore();
  }
});

it("shows action failures and lets an idle session retry", async () => {
  const agents = sessionAgents("channel");
  agents.session.mockRejectedValueOnce(new Error("Disk is full"));
  const h = mount({}, undefined, undefined, agents);
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  await h.user.click(
    await screen.findByRole("button", {
      name: /Model.*effort/,
    }),
  );
  await h.user.click(
    await screen.findByRole("button", { name: "Start a new session" }),
  );
  expect(await screen.findByText("Disk is full")).toHaveTextContent(
    "Disk is full",
  );
  await h.user.click(
    screen.getByRole("button", { name: "Start a new session" }),
  );
  expect(
    await screen.findByRole("tooltip", { name: "New session started" }),
  ).toHaveTextContent("New session started");
});

it("offers a thread-scoped agent session actions in a thread, not on a message that starts one", async () => {
  const agents = sessionAgents("thread", [
    { id: "fast", label: "Fast", efforts: [] },
    { id: "deep", label: "Deep", efforts: [] },
  ]);
  const h = mount({}, undefined, undefined, agents);
  const open = async () => {
    await h.user.type(h.input(), "tidy up");
    await h.user.click(screen.getByRole("button", { name: "First Honey" }));
    await h.user.click(
      await screen.findByRole("button", {
        name: /Model.*effort/,
      }),
    );
    await screen.findByRole("button", { name: "Model for Honey's next run" });
  };
  await open();
  expect(screen.queryByRole("button", { name: "Compact session" })).toBeNull();
  await h.user.keyboard("{Escape}");
  h.retarget({ threadRootId: "root" });
  await open();
  await h.user.click(screen.getByRole("button", { name: "Compact session" }));
  expect(agents.session).toHaveBeenLastCalledWith(
    first.pubkey,
    { channelId: "channel", root: "root" },
    "compact",
  );
});

it.each([
  "claude-sonnet-4-5@20250929",
  "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5",
])(
  "sends an untouched Claude cloud model without an override: %s",
  async (current) => {
    const snapshot = {
      status: "ready",
      agents: [
        {
          key: first.pubkey,
          pubkey: first.pubkey,
          name: "Honey",
          type: "claude",
        },
      ],
    };
    const types = [
      {
        key: "claude",
        models: () => ({
          current,
          models: [
            { id: current, label: "Configured Claude", efforts: [] },
            { id: "haiku", label: "Haiku", efforts: [] },
          ],
        }),
      },
    ];
    const agents = {
      find: (pubkey: string) =>
        snapshot.agents.find((agent) => agent.pubkey === pubkey),
      joinable: () => [],
      sessionState: () => "unavailable" as const,
      subscribe: () => () => {},
      snapshot: () => snapshot,
      types: () => types,
    } as unknown as Agents;
    const h = mount({}, undefined, undefined, agents);
    const publish = vi.fn<Outbox["send"]>(() => "sent");
    const messages = createMessages(
      { supports: () => true, send: publish } as unknown as Outbox,
      first.pubkey,
      () => undefined,
      () => [],
      () => {},
    );
    h.messages.send.mockImplementation(messages.send);
    await h.user.type(h.input(), "use the configured model");
    await h.user.click(screen.getByRole("button", { name: "First Honey" }));
    await h.user.click(
      await screen.findByRole("button", {
        name: /Model.*effort/,
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Model for Honey's next run" }),
    ).toHaveTextContent("Configured Claude");
    await h.user.keyboard("{Escape}");
    await h.user.click(screen.getByRole("button", { name: "Send message" }));
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      tags: [
        ["h", "channel"],
        ["p", first.pubkey],
      ],
    });
  },
);

it("keeps an active Claude model when a follow-up composer picker is untouched", async () => {
  const { spawn, processes } = fakeSpawn();
  const claude = await ClaudeProcess.start(spawn, {
    cwd: "~/.buzz",
    systemPrompt: "test",
    model: "opus",
    sessionId: "s1",
  });
  onTestFinished(() => claude.kill());
  await claude.send("plain");
  const fake = processes[0];
  if (!fake) throw new Error("Expected Claude process");
  fake.hold = true;
  const quick = claude.send("quick", { model: "haiku" });
  const snapshot = {
    status: "ready",
    agents: [
      {
        key: first.pubkey,
        pubkey: first.pubkey,
        name: "Honey",
        type: "claude",
      },
    ],
  };
  const types = [
    {
      key: "claude",
      models: () => ({
        current: "opus",
        models: [
          { id: "opus", label: "Opus", efforts: [] },
          { id: "haiku", label: "Haiku", efforts: [] },
        ],
      }),
    },
  ];
  const agents = {
    find: (pubkey: string) =>
      snapshot.agents.find((agent) => agent.pubkey === pubkey),
    joinable: () => [],
    sessionState: () => "unavailable" as const,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    types: () => types,
  } as unknown as Agents;
  const h = mount({}, undefined, undefined, agents);
  let steered: ReturnType<ClaudeProcess["send"]> | undefined;
  h.messages.send.mockImplementation(
    (
      _channel,
      content,
      _mentions,
      _attachments,
      _recovery,
      _references,
      picks,
    ) => {
      steered = claude.send(content, picks?.[first.pubkey]);
      return "sent";
    },
  );
  try {
    await h.user.type(h.input(), "keep working");
    await h.user.click(screen.getByRole("button", { name: "First Honey" }));
    await h.user.click(
      await screen.findByRole("button", {
        name: /Model.*effort/,
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Model for Honey's next run" }),
    ).toHaveTextContent("Opus");
    await h.user.keyboard("{Escape}");
    await h.user.click(screen.getByRole("button", { name: "Send message" }));
    expect(h.messages.send).toHaveBeenCalledOnce();
    await waitFor(() => expect(fake.prompts).toHaveLength(3));
    expect(fake.models).toEqual(["opus", "haiku", "haiku"]);
  } finally {
    fake.finish();
    await Promise.all([quick, steered]);
  }
});

it("sends the model and effort shown by an untouched agent picker", async () => {
  const snapshot = {
    status: "ready",
    agents: [
      {
        key: first.pubkey,
        pubkey: first.pubkey,
        name: "Honey",
        type: "test/agent",
      },
    ],
  };
  const models = {
    current: "gpt-6.1-sol",
    sendDefaults: true,
    models: [
      {
        id: "gpt-6.1-sol",
        label: "GPT-6.1-Sol",
        effort: "high",
        efforts: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
      { id: "other", label: "Other", efforts: [] },
    ],
  };
  const types = [{ key: "test/agent", models: () => models }];
  const agents = {
    find: (pubkey: string) =>
      snapshot.agents.find((agent) => agent.pubkey === pubkey),
    joinable: () => [],
    sessionState: () => "unavailable" as const,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    types: () => types,
  } as unknown as Agents;
  const h = mount({}, undefined, undefined, agents);
  const media = vi
    .spyOn(h.session, "media")
    .mockReturnValue("buzz-media://localhost/honey-small");
  await h.user.type(h.input(), "use what you show");
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  await h.user.click(
    await screen.findByRole("button", {
      name: /Model.*effort/,
    }),
  );
  expect(
    await screen.findByRole("button", {
      name: "Model for Honey's next run",
    }),
  ).toHaveTextContent("GPT-6.1-Sol");
  expect(
    await screen.findByLabelText("Effort for Honey's next run"),
  ).toHaveAttribute("aria-valuetext", "High");
  // A mentioned agent's profile may not be loaded yet (not a member), so ask for it.
  expect(h.session.profiles.ensure).toHaveBeenCalledWith(
    [first.pubkey],
    "background",
  );
  // Artwork arriving after the picker opens must use authenticated thumbnails.
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Honey", picture: "https://art.test/honey.png" }],
    ]),
  );
  expect(
    screen.getByRole("dialog", { name: /Model.*effort/ }).querySelector("img"),
  ).toHaveAttribute("src", "buzz-media://localhost/honey-small");
  expect(media).toHaveBeenCalledWith("https://art.test/honey.png", "small");
  await h.user.keyboard("{Escape}");
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.send).toHaveBeenLastCalledWith(
    "channel",
    expect.stringContaining("use what you show"),
    [first.pubkey],
    [],
    undefined,
    [],
    { [first.pubkey]: { model: "gpt-6.1-sol", effort: "high" } },
  );
});

it.each(["settings refresh", "model pick"])(
  "follows the new model's effort after %s without inheriting an untouched effort",
  async (change) => {
    let snapshot = {
      status: "ready",
      agents: [
        {
          key: first.pubkey,
          pubkey: first.pubkey,
          name: "Honey",
          type: "test/agent",
        },
      ],
    };
    let current = "fast";
    const models = [
      {
        id: "fast",
        label: "Fast",
        effort: "medium",
        efforts: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
      {
        id: "deep",
        label: "Deep",
        effort: "high",
        efforts: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
    ];
    const listeners = new Set<() => void>();
    const types = [
      {
        key: "test/agent",
        models: () => ({ current, models, sendDefaults: true }),
      },
    ];
    const agents = {
      find: (pubkey: string) =>
        snapshot.agents.find((agent) => agent.pubkey === pubkey),
      joinable: () => [],
      sessionState: () => "unavailable" as const,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => snapshot,
      types: () => types,
    } as unknown as Agents;
    const h = mount({}, undefined, undefined, agents);
    await h.user.type(h.input(), "follow the shown defaults");
    await h.user.click(screen.getByRole("button", { name: "First Honey" }));
    const trigger = await screen.findByRole("button", {
      name: /Model.*effort/,
    });
    await h.user.click(trigger);
    expect(
      await screen.findByLabelText("Effort for Honey's next run"),
    ).toHaveAttribute("aria-valuetext", "Medium");
    expect(trigger).not.toHaveAttribute("data-selected");
    if (change === "settings refresh") {
      await act(async () => {
        current = "deep";
        snapshot = { ...snapshot };
        for (const listener of listeners) listener();
      });
    } else {
      await h.user.click(
        screen.getByRole("button", { name: "Model for Honey's next run" }),
      );
      await h.user.click(
        await screen.findByRole("menuitemradio", { name: "Deep" }),
      );
    }
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Model for Honey's next run",
        }),
      ).toHaveTextContent("Deep"),
    );
    expect(
      await screen.findByLabelText("Effort for Honey's next run"),
    ).toHaveAttribute("aria-valuetext", "High");
    if (change === "settings refresh")
      expect(trigger).not.toHaveAttribute("data-selected");
    await h.user.keyboard("{Escape}");
    await h.user.click(screen.getByRole("button", { name: "Send message" }));
    expect(h.messages.send).toHaveBeenLastCalledWith(
      "channel",
      expect.stringContaining("follow the shown defaults"),
      [first.pubkey],
      [],
      undefined,
      [],
      { [first.pubkey]: { model: "deep", effort: "high" } },
    );
  },
);

it("asks a mentioned agent of the viewer's for a model and effort on the next run only", async () => {
  // Snapshots are stable, as the service's are.
  const snapshot = {
    status: "ready",
    agents: [
      {
        key: first.pubkey,
        pubkey: first.pubkey,
        name: "Honey",
        type: "test/agent",
      },
    ],
  };
  const models = {
    current: "fast",
    models: [
      {
        id: "fast",
        label: "Fast",
        effort: "low",
        efforts: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
      {
        id: "deep",
        label: "Deep",
        efforts: [
          { id: "high", label: "High" },
          { id: "max", label: "Max" },
        ],
      },
    ],
  };
  const types = [{ key: "test/agent", models: () => models }];
  const agents = {
    find: (pubkey: string) =>
      snapshot.agents.find((agent) => agent.pubkey === pubkey),
    joinable: () => [],
    portable: async () => ({ agents: [] }),
    sessionState: () => "unavailable" as const,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    types: () => types,
  } as unknown as Agents;
  const h = mount({}, undefined, undefined, agents);
  const picker = () =>
    screen.queryByRole("button", {
      name: /Model.*effort/,
    });
  const open = async () => {
    // Choices load asynchronously each time the agent is mentioned again.
    await h.user.click(
      await screen.findByRole("button", {
        name: /Model.*effort/,
      }),
    );
    // The edge-aligned thumb stays hidden until it is measured, which jsdom
    // cannot do, so the slider is not in the accessibility tree here.
    return screen.findByLabelText("Effort for Honey's next run");
  };
  const model = () =>
    screen.getByRole("button", { name: "Model for Honey's next run" });
  // Writes the message and mentions an agent before any pick is made.
  const write = async (name: string, text: string) => {
    await h.user.type(h.input(), text);
    await h.user.click(screen.getByRole("button", { name }));
  };
  const send = async () => {
    const sent = h.messages.send.mock.calls.length;
    await h.user.keyboard("{Escape}");
    await h.user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(h.messages.send).toHaveBeenCalledTimes(sent + 1),
    );
  };
  expect(picker()).toBeNull();
  await h.user.click(screen.getByRole("button", { name: "Second Honey" }));
  // Someone else's agent, or a person, offers no choice.
  expect(picker()).toBeNull();
  await write("First Honey", "think hard");
  const slider = await open();
  expect(model()).toHaveTextContent("Fast");
  expect(slider).toHaveAttribute("aria-valuetext", "Low");
  expect(slider.closest("[data-unknown]")).toBeNull();
  slider.focus();
  await h.user.keyboard("{ArrowRight}");
  expect(slider).toHaveAttribute("aria-valuetext", "High");
  await send();
  expect(h.messages.send).toHaveBeenLastCalledWith(
    "channel",
    expect.stringContaining("think hard"),
    [second.pubkey, first.pubkey],
    [],
    undefined,
    [],
    { [first.pubkey]: { effort: "high" } },
  );
  await write("First Honey", "think deeper");
  const again = await open();
  expect(again).toHaveAttribute("aria-valuetext", "Low");
  // A new model keeps an effort it also offers.
  again.focus();
  await h.user.keyboard("{ArrowRight}");
  await h.user.click(model());
  await h.user.click(
    await screen.findByRole("menuitemradio", { name: "Deep" }),
  );
  expect(model()).toHaveTextContent("Deep");
  const deep = await screen.findByLabelText("Effort for Honey's next run");
  expect(deep).toHaveAttribute("aria-valuetext", "High");
  await send();
  expect(h.messages.send).toHaveBeenLastCalledWith(
    "channel",
    expect.stringContaining("think deeper"),
    [first.pubkey],
    [],
    undefined,
    [],
    { [first.pubkey]: { model: "deep", effort: "high" } },
  );
  await write("First Honey", "as usual");
  await open();
  await h.user.click(model());
  await h.user.click(
    await screen.findByRole("menuitemradio", { name: "Deep" }),
  );
  // Back to the agent's own model is no pick at all.
  await h.user.click(model());
  await h.user.click(
    await screen.findByRole("menuitemradio", { name: "Fast" }),
  );
  expect(model()).toHaveTextContent("Fast");
  const usual = await screen.findByLabelText("Effort for Honey's next run");
  usual.focus();
  await h.user.keyboard("{ArrowRight}{Home}");
  expect(usual).toHaveAttribute("aria-valuetext", "Low");
  await send();
  expect(h.messages.send).toHaveBeenLastCalledWith(
    "channel",
    expect.stringContaining("as usual"),
    [first.pubkey],
    [],
  );
});

function soloModelPreferenceHarness(
  agents: Agents = sessionAgents("channel", [
    {
      id: "fast",
      label: "Fast",
      efforts: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    },
    {
      id: "deep",
      label: "Deep",
      efforts: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    },
  ]),
) {
  const options = {
    soloConversation: true,
    ownSoloConversation: true,
    chatPresentation: true,
    requireMention: true,
  };
  const mountChat = (channelId = "channel") => {
    const channel = {
      id: channelId,
      channelType: "solo" as const,
      members: [first.pubkey, second.pubkey],
    };
    const channels = [channel, { ...channel, id: "other-chat" }];
    const channelList = { status: "ready" as const, channels };
    const composer = mount(
      { ...options, channelId },
      undefined,
      undefined,
      agents,
    );
    composer.setLibrary([
      { pubkey: first.pubkey, name: "Honey" },
      { pubkey: second.pubkey, name: "Honey" },
    ]);
    composer.setProfiles(
      new Map([
        [first.pubkey, { name: "Honey", isAgent: true }],
        [second.pubkey, { name: "Honey", isAgent: true }],
      ]),
    );
    Object.assign(composer.session, {
      channels: {
        ...composer.session.channels,
        list: () => channelList,
      },
      channelWrites: {
        refreshMembership: vi.fn(async () => channel),
        addAgents: vi.fn(async () => {}),
      },
    });
    return composer;
  };
  const write = async (
    composer: ReturnType<typeof mount>,
    text: string,
    recipient = "First Honey",
  ) => {
    await composer.user.type(composer.input(), text);
    await composer.user.click(screen.getByRole("button", { name: recipient }));
  };
  const openPicker = async (composer: ReturnType<typeof mount>) =>
    composer.user.click(
      await screen.findByRole("button", { name: /Model.*effort/ }),
    );
  const modelButton = () =>
    screen.getByRole("button", { name: "Model for Honey in this chat" });
  const send = async (composer: ReturnType<typeof mount>) => {
    await composer.user.keyboard("{Escape}");
    await composer.user.click(
      screen.getByRole("button", { name: "Send message" }),
    );
  };
  return { mountChat, write, openPicker, modelButton, send };
}

it.each(["different", "same"])(
  "keeps pending Solo edits from two composers for %s agents and orders a later reset",
  async (target) => {
    const gate = deferred<void>();
    let tail: Promise<unknown> = gate.promise;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (_name: string, run: () => unknown) => {
          const result = tail.then(run);
          tail = result.catch(() => {});
          return result;
        },
      },
    });
    const agents = sessionAgents(
      "channel",
      [
        { id: "fast", label: "Fast", efforts: [] },
        { id: "deep", label: "Deep", efforts: [] },
      ],
      [first.pubkey, second.pubkey],
    );
    const { mountChat } = soloModelPreferenceHarness(agents);
    const one = mountChat();
    const two = mountChat();
    const choose = async (
      h: ReturnType<typeof mount>,
      recipient: string,
      select = true,
    ) => {
      if (select)
        await h.user.click(
          within(h.container).getByRole("button", { name: recipient }),
        );
      await h.user.click(
        within(h.container).getByRole("button", { name: /Model.*effort/ }),
      );
      const model = screen
        .getAllByRole("button", { name: "Model for Honey in this chat" })
        .at(recipient === "First Honey" ? 0 : -1);
      if (!model) throw new Error("Missing addressed model control");
      await h.user.click(model);
      await h.user.click(
        await screen.findByRole("menuitemradio", { name: "Deep" }),
      );
      await h.user.keyboard("{Escape}");
    };
    try {
      await choose(one, "First Honey");
      await choose(
        two,
        target === "same" ? "First Honey" : "Second Honey",
        target !== "same",
      );
      expect(readView("scope", "solo:model-picks:channel", null)).toBeNull();
      await one.user.click(
        within(one.container).getByRole("button", { name: /Model.*effort/ }),
      );
      await one.user.click(
        screen.getByRole("button", { name: "Reset model and effort" }),
      );
    } finally {
      await act(async () => {
        gate.resolve();
        await tail;
      });
    }
    expect(readView("scope", "solo:model-picks:channel", null)).toEqual(
      target === "same"
        ? {}
        : {
            [second.pubkey]: { model: "deep", type: "test/agent" },
          },
    );
  },
);

it("keeps a pending Solo choice out of Send until its persistence settles", async () => {
  const gate = deferred<void>();
  const started = deferred<void>();
  let saved: Promise<unknown> | undefined;
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_name: string, run: () => unknown) => {
        started.resolve();
        saved = gate.promise.then(run);
        return saved;
      },
    },
  });
  const { mountChat, write, openPicker, modelButton, send } =
    soloModelPreferenceHarness();
  const h = mountChat();
  await write(h, "Keep this prompt");
  await openPicker(h);
  await h.user.click(modelButton());
  await h.user.click(
    await screen.findByRole("menuitemradio", { name: "Deep" }),
  );
  try {
    await send(h);
    expect(h.messages.send).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "choices are still saving",
    );
    expect(h.input()).toHaveTextContent("Keep this prompt");
  } finally {
    await act(async () => {
      gate.resolve();
      await saved;
    });
  }
  await started.promise;
  await send(h);
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual({
    [first.pubkey]: { model: "deep" },
  });
});

it.each(["missing", "rejected"])(
  "retains Solo intent when window ownership is %s",
  async (failure) => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value:
        failure === "missing"
          ? undefined
          : {
              request: async () => {
                throw new Error("Lock refused");
              },
            },
    });
    const { mountChat, write, openPicker, modelButton, send } =
      soloModelPreferenceHarness();
    const h = mountChat();
    await write(h, "Use my selection");
    await openPicker(h);
    await h.user.click(modelButton());
    await h.user.click(
      await screen.findByRole("menuitemradio", { name: "Deep" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save model and effort",
    );
    expect(readView("scope", "solo:model-picks:channel", null)).toBeNull();
    await send(h);
    await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
    expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual({
      [first.pubkey]: { model: "deep" },
    });
  },
);

it("sends and restores model and effort per Solo chat and agent", async () => {
  const { mountChat, write, openPicker, modelButton, send } =
    soloModelPreferenceHarness();
  const h = mountChat();
  await write(h, "a");
  await openPicker(h);
  await h.user.click(modelButton());
  await h.user.click(
    await screen.findByRole("menuitemradio", { name: "Deep" }),
  );
  const effort = await screen.findByLabelText("Effort for Honey in this chat");
  effort.focus();
  await h.user.keyboard("{ArrowRight}");
  await send(h);
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send.mock.calls[0]?.[0]).toBe("channel");
  expect(h.messages.send.mock.calls[0]?.[1]).toContain("a");
  expect(h.messages.send.mock.calls[0]?.[2]).toEqual([first.pubkey]);
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual({
    [first.pubkey]: { model: "deep", effort: "high" },
  });
  expect(readView("scope", "solo:model-picks:channel", null)).toEqual({
    [first.pubkey]: { model: "deep", effort: "high", type: "test/agent" },
  });

  await write(h, "b", "Second Honey");
  await send(h);
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledTimes(2));
  expect(h.messages.send).toHaveBeenLastCalledWith(
    "channel",
    expect.stringContaining("b"),
    [second.pubkey],
    [],
  );

  await write(h, "c");
  await send(h);
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledTimes(3));
  expect(h.messages.send).toHaveBeenLastCalledWith(
    "channel",
    expect.stringContaining("c"),
    [first.pubkey],
    [],
    undefined,
    [],
    { [first.pubkey]: { model: "deep", effort: "high" } },
  );

  h.retarget({ channelId: "other-chat" });
  await write(h, "d");
  await openPicker(h);
  await waitFor(() => expect(modelButton()).toHaveTextContent("Fast"));
  await h.user.keyboard("{Escape}");
  h.retarget({ channelId: "channel" });
  await write(h, "e");
  await openPicker(h);
  await waitFor(() => expect(modelButton()).toHaveTextContent("Deep"));
  await send(h);
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledTimes(4));

  h.unmount();
  const reopened = mountChat();
  await reopened.user.type(reopened.input(), "d");
  await reopened.user.click(
    screen.getByRole("button", { name: "First Honey" }),
  );
  await reopened.user.click(
    await screen.findByRole("button", { name: /Model.*effort/ }),
  );
  expect(
    screen.getByRole("button", { name: "Model for Honey in this chat" }),
  ).toHaveTextContent("Deep");
  expect(
    await screen.findByLabelText("Effort for Honey in this chat"),
  ).toHaveAttribute("aria-valuetext", "High");
  await send(reopened);
  await waitFor(() => expect(reopened.messages.send).toHaveBeenCalledOnce());
  expect(reopened.messages.send.mock.calls[0]?.[1]).toContain("d");
  expect(reopened.messages.send.mock.calls[0]?.[2]).toEqual([first.pubkey]);
  expect(reopened.messages.send.mock.calls[0]?.at(-1)).toEqual({
    [first.pubkey]: { model: "deep", effort: "high" },
  });
});

it("retains an explicitly selected default Solo model and effort after provider defaults change", async () => {
  const efforts = [
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
  ];
  const fast = { id: "fast", label: "Fast", effort: "low", efforts };
  const models = [fast, { id: "deep", label: "Deep", efforts }];
  const agents = sessionAgents("channel", models);
  let current = "fast";
  const type = agents.types()[0];
  if (!type) throw new Error("The fixture agent type should exist.");
  const types = [{ ...type, models: () => ({ current, models }) }];
  const { mountChat, write, openPicker, modelButton, send } =
    soloModelPreferenceHarness({ ...agents, types: () => types } as Agents);
  const h = mountChat();
  await write(h, "pin the default");
  await openPicker(h);
  for (const name of ["Deep", "Fast"]) {
    await h.user.click(modelButton());
    await h.user.click(await screen.findByRole("menuitemradio", { name }));
  }
  const effort = await screen.findByLabelText("Effort for Honey in this chat");
  effort.focus();
  await h.user.keyboard("{ArrowRight}{Home}");
  expect(effort).toHaveAttribute("aria-valuetext", "Low");
  expect(readView("scope", "solo:model-picks:channel", null)).toEqual({
    [first.pubkey]: { model: "fast", effort: "low", type: "test/agent" },
  });
  await send(h);
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  h.unmount();
  current = "deep";
  fast.effort = "high";
  const reopened = mountChat();
  await write(reopened, "keep Fast");
  await openPicker(reopened);
  expect(modelButton()).toHaveTextContent("Fast");
  expect(
    await screen.findByLabelText("Effort for Honey in this chat"),
  ).toHaveAttribute("aria-valuetext", "Low");
  await send(reopened);
  await waitFor(() => expect(reopened.messages.send).toHaveBeenCalledOnce());
  expect(reopened.messages.send).toHaveBeenLastCalledWith(
    "channel",
    expect.stringContaining("keep Fast"),
    [first.pubkey],
    [],
    undefined,
    [],
    { [first.pubkey]: { model: "fast", effort: "low" } },
  );
});

it("keeps newer Solo choices when a background upload restores its draft", async () => {
  const { mountChat, write, openPicker, modelButton, send } =
    soloModelPreferenceHarness();
  const h = mountChat();
  const gate = deferred<ReturnType<typeof uploadDescriptor>>();
  const upload = vi.fn(() => gate.promise);
  h.retarget({ session: { ...h.session, attachments: { upload } } });
  await write(h, "original caption");
  await openPicker(h);
  await h.user.click(modelButton());
  await h.user.click(
    await screen.findByRole("menuitemradio", { name: "Deep" }),
  );
  await h.user.keyboard("{Escape}");
  attachByPaste(h.input(), attachmentFile("original.txt"));
  try {
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    await send(h);
    await waitFor(() =>
      expect(h.input().value).not.toContain("original caption"),
    );
    await openPicker(h);
    await h.user.click(
      screen.getByRole("button", { name: "Reset model and effort" }),
    );
    await h.user.keyboard("{Escape}");
  } finally {
    await act(async () => gate.reject(new Error("offline")));
  }
  await waitFor(() => expect(h.input().value).toContain("original caption"));
  expect(readView("scope", "solo:model-picks:channel", null)).toEqual({});
  await openPicker(h);
  expect(modelButton()).toHaveTextContent("Fast");
  await h.user.keyboard("{Escape}");
  await h.user.click(
    screen.getByRole("button", { name: "Remove original.txt" }),
  );
  await send(h);
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send).toHaveBeenLastCalledWith(
    "channel",
    expect.stringContaining("original caption"),
    [first.pubkey],
    [],
  );
});

it("keeps Reset available when a Solo catalog has no configurable choices", async () => {
  const agents = sessionAgents("channel");
  const type = agents.types()[0];
  if (!type) throw new Error("The fixture agent type should exist.");
  const { sessionControls: _, ...modelType } = type;
  const types = [
    {
      ...modelType,
      models: () => ({
        current: "fast",
        models: [{ id: "fast", label: "Fast", efforts: [] }],
      }),
    },
  ];
  const { mountChat, write, openPicker, send } = soloModelPreferenceHarness({
    ...agents,
    types: () => types,
  });
  writeView("scope", "solo:model-picks:channel", {
    [first.pubkey]: { model: "deep", effort: "high", type: "test/agent" },
  });
  const h = mountChat();
  await write(h, "Use defaults");
  await openPicker(h);
  await h.user.click(
    screen.getByRole("button", { name: "Reset model and effort" }),
  );
  expect(readView("scope", "solo:model-picks:channel", null)).toEqual({});
  await send(h);
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send).toHaveBeenCalledWith(
    "channel",
    expect.stringContaining("Use defaults"),
    [first.pubkey],
    [],
  );
});

it("retries an unreadable initial Solo preference without silently sending defaults", async () => {
  const { mountChat, write, openPicker, modelButton, send } =
    soloModelPreferenceHarness();
  writeView("scope", "solo:model-picks:channel", {
    [first.pubkey]: { model: "deep", effort: "high", type: "test/agent" },
  });
  const storageKey = `buzz-view.v1:${JSON.stringify(["scope", "solo:model-picks:channel"])}`;
  const getItem = Storage.prototype.getItem;
  let unavailable = true;
  const read = vi
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(function (this: Storage, key) {
      if (key === storageKey && unavailable)
        throw new DOMException("Storage unavailable");
      return getItem.call(this, key);
    });
  onTestFinished(() => read.mockRestore());
  const h = mountChat();
  await write(h, "Keep my saved model");
  await send(h);
  expect(
    await screen.findByText(/Could not read saved model and effort/),
  ).toBeVisible();
  expect(h.messages.send).not.toHaveBeenCalled();
  await h.user.click(
    screen.getByRole("button", { name: "Retry saved choices" }),
  );
  expect(
    screen.getByText(/Could not read saved model and effort/),
  ).toBeVisible();
  unavailable = false;
  await h.user.click(
    screen.getByRole("button", { name: "Retry saved choices" }),
  );
  await openPicker(h);
  expect(modelButton()).toHaveTextContent("Deep");
  await send(h);
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual({
    [first.pubkey]: { model: "deep", effort: "high" },
  });
});

it("uses the supported Solo model and effort when saved choices are unavailable", async () => {
  const { mountChat, modelButton, send } = soloModelPreferenceHarness();
  writeView("scope", "solo:model-picks:channel", {
    [first.pubkey]: { model: "removed", effort: "high", type: "test/agent" },
  });
  const unsupported = mountChat();
  await unsupported.user.type(unsupported.input(), "a");
  await unsupported.user.click(
    screen.getByRole("button", { name: "First Honey" }),
  );
  const trigger = await screen.findByRole("button", { name: /Model.*effort/ });
  expect(trigger).not.toHaveAttribute("data-selected");
  await unsupported.user.click(trigger);
  expect(modelButton()).toHaveTextContent("Fast");
  expect(
    await screen.findByLabelText("Effort for Honey in this chat"),
  ).toHaveAttribute("aria-valuetext", "Default");
  await send(unsupported);
  await waitFor(() => expect(unsupported.messages.send).toHaveBeenCalledOnce());
  expect(unsupported.messages.send).toHaveBeenCalledWith(
    "channel",
    expect.stringContaining("a"),
    [first.pubkey],
    [],
  );

  unsupported.unmount();
  writeView("scope", "solo:model-picks:channel", {
    [first.pubkey]: { model: "deep", effort: "ultra", type: "test/agent" },
  });
  const unsupportedEffort = mountChat();
  await unsupportedEffort.user.type(unsupportedEffort.input(), "b");
  await unsupportedEffort.user.click(
    screen.getByRole("button", { name: "First Honey" }),
  );
  await screen.findByRole("button", { name: /Model.*effort/ });
  await send(unsupportedEffort);
  await waitFor(() =>
    expect(unsupportedEffort.messages.send).toHaveBeenCalledOnce(),
  );
  expect(unsupportedEffort.messages.send.mock.calls[0]?.[1]).toContain("b");
  expect(unsupportedEffort.messages.send.mock.calls[0]?.[2]).toEqual([
    first.pubkey,
  ]);
  expect(unsupportedEffort.messages.send.mock.calls[0]?.at(-1)).toEqual({
    [first.pubkey]: { model: "deep" },
  });
  unsupportedEffort.unmount();
});

it.each(
  ["inventory", "type"].flatMap((missing) =>
    ["retry", "reset"].map((recovery) => ({ missing, recovery })),
  ),
)(
  "recovers missing Solo $missing with $recovery and keeps retained choices usable",
  async ({ missing, recovery }) => {
    let resolveModels!: (value: Models) => void;
    const pendingModels = new Promise<Models>((resolve) => {
      resolveModels = resolve;
    });
    const readyAgents = sessionAgents("channel");
    const type = readyAgents.types()[0];
    if (!type) throw new Error("The fixture agent type should exist.");
    const delayedTypes = [{ ...type, models: () => pendingModels }];
    const readySnapshot = readyAgents.snapshot();
    let snapshot: ReturnType<Agents["snapshot"]> = {
      ...readySnapshot,
      status: missing === "type" ? "ready" : "loading",
      agents: missing === "type" ? readySnapshot.agents : [],
    };
    let typesAvailable = missing !== "type";
    const absentTypes: ReturnType<Agents["types"]> = [];
    const listeners = new Set<() => void>();
    const loadInventory = () => {
      snapshot = readySnapshot;
      typesAvailable = true;
      for (const listener of listeners) listener();
    };
    const agents = {
      ...readyAgents,
      snapshot: () => snapshot,
      find: (pubkey: string) =>
        snapshot.agents.find((agent) => agent.pubkey === pubkey),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      types: () => (typesAvailable ? delayedTypes : absentTypes),
    } as Agents;
    const { mountChat, write, send } = soloModelPreferenceHarness(agents);
    writeView("scope", "solo:model-picks:channel", {
      [first.pubkey]: { model: "deep", effort: "high", type: "test/agent" },
    });
    const h = mountChat();
    const refresh = vi.fn(async () => loadInventory());
    Object.assign(h.session, {
      agentChoices: { ...h.session.agentChoices, refresh },
    });
    try {
      await write(h, "a");
      await send(h);
      expect(h.messages.send).not.toHaveBeenCalled();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        missing === "type"
          ? "Saved model and effort choices could not be loaded"
          : "Saved model and effort choices are still loading",
      );
      act(() => {
        snapshot = { ...snapshot, status: "error", error: "Inventory offline" };
        for (const listener of listeners) listener();
      });
      await send(h);
      expect(h.messages.send).not.toHaveBeenCalled();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Saved model and effort choices could not be loaded",
      );
      await h.user.click(
        screen.getByRole("button", { name: "Model and effort for this chat" }),
      );
      if (recovery === "reset") {
        await h.user.click(
          screen.getByRole("button", { name: "Reset model and effort" }),
        );
        expect(readView("scope", "solo:model-picks:channel", null)).toEqual({});
        await send(h);
        await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
        expect(h.messages.send).toHaveBeenLastCalledWith(
          "channel",
          expect.stringContaining("a"),
          [first.pubkey],
          [],
        );
        expect(refresh).not.toHaveBeenCalled();
        return;
      }
      await h.user.click(screen.getByRole("button", { name: "Retry agents" }));
      expect(refresh).toHaveBeenCalledOnce();
      await h.user.keyboard("{Escape}");
      await send(h);
      expect(h.messages.send).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        loadInventory();
        resolveModels({
          current: "fast",
          models: [
            {
              id: "fast",
              label: "Fast",
              efforts: [{ id: "low", label: "Low" }],
            },
            {
              id: "deep",
              label: "Deep",
              efforts: [{ id: "high", label: "High" }],
            },
          ],
        });
        await pendingModels;
      });
    }
    await send(h);
    await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
    expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual({
      [first.pubkey]: { model: "deep", effort: "high" },
    });
    act(() => {
      snapshot = {
        ...readySnapshot,
        status: "error",
        error: "Inventory refresh offline",
      };
      for (const listener of listeners) listener();
    });
    await write(h, "keep using the loaded choices");
    await h.user.click(
      await screen.findByRole("button", { name: /Model.*effort/ }),
    );
    expect(
      await screen.findByRole("button", {
        name: "Model for Honey in this chat",
      }),
    ).toHaveTextContent("Deep");
    expect(
      await screen.findByLabelText("Effort for Honey in this chat"),
    ).toHaveAttribute("aria-valuetext", "High");
    await send(h);
    await waitFor(() => expect(h.messages.send).toHaveBeenCalledTimes(2));
    expect(h.messages.send).toHaveBeenLastCalledWith(
      "channel",
      expect.stringContaining("keep using the loaded choices"),
      [first.pubkey],
      [],
      undefined,
      [],
      { [first.pubkey]: { model: "deep", effort: "high" } },
    );
  },
);

it("keeps saved Solo choices after catalog failure and retries before sending", async () => {
  const agents = sessionAgents("channel", [
    { id: "fast", label: "Fast", efforts: [] },
    {
      id: "deep",
      label: "Deep",
      efforts: [{ id: "high", label: "High" }],
    },
  ]);
  const type = agents.types()[0];
  if (!type?.models) throw new Error("Expected a model catalog");
  const models = vi
    .fn(type.models)
    .mockRejectedValue(new Error("Catalog offline"));
  const types = [{ ...type, models }];
  const { mountChat, write, openPicker, modelButton, send } =
    soloModelPreferenceHarness({ ...agents, types: () => types });
  writeView("scope", "solo:model-picks:channel", {
    [first.pubkey]: { model: "deep", effort: "high", type: "test/agent" },
  });
  const h = mountChat();
  await write(h, "Keep my choices");
  await openPicker(h);
  await screen.findByText(
    /Model unavailable|Model and effort could not be loaded/,
  );
  await send(h);
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Saved model and effort choices could not be loaded",
  );
  await openPicker(h);
  models.mockImplementation(type.models);
  await h.user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(modelButton()).toHaveTextContent("Deep"));
  await send(h);
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual({
    [first.pubkey]: { model: "deep", effort: "high" },
  });
});

it("resets all displayed Solo agents against storage before its event arrives", async () => {
  const agents = sessionAgents(
    "channel",
    [
      { id: "fast", label: "Fast", efforts: [] },
      { id: "deep", label: "Deep", efforts: [] },
    ],
    [first.pubkey, second.pubkey],
  );
  const { mountChat, write, openPicker, send } =
    soloModelPreferenceHarness(agents);
  const unrelated = { model: "deep", type: "test/agent" };
  writeView("scope", "solo:model-picks:channel", {
    [first.pubkey]: { model: "deep", type: "test/agent" },
    [resourceOwner]: unrelated,
  });
  const h = mountChat();
  await write(h, "a");
  await h.user.click(screen.getByRole("button", { name: "Second Honey" }));
  await openPicker(h);
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", {
        name: "Model for Honey in this chat",
      }),
    ).toHaveLength(2),
  );
  // Another window has written, but this window has not received its event.
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify(["scope", "solo:model-picks:channel"])}`,
    JSON.stringify({
      [first.pubkey]: { model: "deep", type: "test/agent" },
      [second.pubkey]: { model: "deep", type: "test/agent" },
      [resourceOwner]: unrelated,
    }),
  );
  await h.user.click(
    screen.getByRole("button", { name: "Reset model and effort" }),
  );
  expect(readView("scope", "solo:model-picks:channel", null)).toEqual({
    [resourceOwner]: unrelated,
  });
  await send(h);
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send).toHaveBeenCalledWith(
    "channel",
    expect.stringContaining("a"),
    [first.pubkey, second.pubkey],
    [],
  );
});

it("rebases picker edits onto storage updated before the displayed choices rerender", async () => {
  const agents = sessionAgents(
    "channel",
    [
      { id: "fast", label: "Fast", efforts: [] },
      { id: "deep", label: "Deep", efforts: [] },
    ],
    [first.pubkey, second.pubkey],
  );
  const { mountChat, write, openPicker, send } =
    soloModelPreferenceHarness(agents);
  const key = "solo:model-picks:channel";
  const fast = { model: "fast", type: "test/agent" };
  const deep = { model: "deep", type: "test/agent" };
  writeView("scope", key, { [first.pubkey]: fast, [second.pubkey]: fast });
  const h = mountChat();
  await write(h, "a");
  await h.user.click(screen.getByRole("button", { name: "Second Honey" }));
  await openPicker(h);
  const models = await screen.findAllByRole("button", {
    name: "Model for Honey in this chat",
  });
  expect(models).toHaveLength(2);
  const firstModel = models[0];
  if (!firstModel) throw new Error("Expected the first agent's model control");
  await h.user.click(firstModel);
  const option = await screen.findByRole("menuitemradio", { name: "Deep" });
  const storageKey = `buzz-view.v1:${JSON.stringify(["scope", key])}`;
  act(() => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ [first.pubkey]: fast, [second.pubkey]: deep }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: storageKey,
        storageArea: localStorage,
      }),
    );
    fireEvent.click(option);
  });
  expect(readView("scope", key, null)).toEqual({
    [first.pubkey]: deep,
    [second.pubkey]: deep,
  });
  await send(h);
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual({
    [first.pubkey]: { model: "deep" },
    [second.pubkey]: { model: "deep" },
  });
});

it("keeps unsaved Solo choices across edits to another agent and storage updates", async () => {
  const agents = sessionAgents(
    "channel",
    [
      { id: "fast", label: "Fast", efforts: [] },
      { id: "deep", label: "Deep", efforts: [] },
    ],
    [first.pubkey, second.pubkey],
  );
  const { mountChat, write, openPicker, modelButton, send } =
    soloModelPreferenceHarness(agents);
  const storageKey = `buzz-view.v1:${JSON.stringify(["scope", "solo:model-picks:channel"])}`;
  const h = mountChat();
  await write(h, "a");
  const originalSetItem = Storage.prototype.setItem;
  const failedWrite = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key === storageKey) throw new DOMException("Storage is full");
      originalSetItem.call(this, key, value);
    });
  onTestFinished(() => failedWrite.mockRestore());
  await openPicker(h);
  await h.user.click(modelButton());
  await h.user.click(
    await screen.findByRole("menuitemradio", { name: "Deep" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not save model and effort for this chat",
  );
  await h.user.keyboard("{Escape}");
  const unrelated = { model: "deep", type: "test/agent" };
  act(() => {
    originalSetItem.call(
      localStorage,
      storageKey,
      JSON.stringify({ [resourceOwner]: unrelated }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: storageKey,
        storageArea: localStorage,
      }),
    );
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not save model and effort for this chat",
  );
  await h.user.click(screen.getByRole("button", { name: "Second Honey" }));
  await openPicker(h);
  const models = await waitFor(() => {
    const buttons = screen.getAllByRole("button", {
      name: "Model for Honey in this chat",
    });
    expect(buttons).toHaveLength(2);
    return buttons;
  });
  expect(models[0]).toHaveTextContent("Deep");
  const secondModel = models[1];
  if (!secondModel) throw new Error("The second agent's model should exist.");
  await h.user.click(secondModel);
  await h.user.click(
    await screen.findByRole("menuitemradio", { name: "Deep" }),
  );
  await send(h);
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual({
    [first.pubkey]: { model: "deep" },
    [second.pubkey]: { model: "deep" },
  });
  failedWrite.mockRestore();
  await write(h, "b");
  await h.user.click(screen.getByRole("button", { name: "Second Honey" }));
  await openPicker(h);
  const restoredSecondModel = screen.getAllByRole("button", {
    name: "Model for Honey in this chat",
  })[1];
  if (!restoredSecondModel)
    throw new Error("The second agent's model should exist after sending.");
  await h.user.click(restoredSecondModel);
  await h.user.click(
    await screen.findByRole("menuitemradio", { name: "Fast" }),
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(readView("scope", "solo:model-picks:channel", null)).toEqual({
    [first.pubkey]: { model: "deep", type: "test/agent" },
    [second.pubkey]: { model: "fast", type: "test/agent" },
    [resourceOwner]: unrelated,
  });
});

it("resets saved Solo choices and reports persistence failures", async () => {
  const { mountChat, openPicker, modelButton, send } =
    soloModelPreferenceHarness();
  writeView("scope", "solo:model-picks:channel", {
    [first.pubkey]: { model: "deep", effort: "high", type: "test/agent" },
    [second.pubkey]: { model: "deep", effort: "low", type: "test/agent" },
  });
  const resetChat = mountChat();
  await resetChat.user.type(resetChat.input(), "a");
  await resetChat.user.click(
    screen.getByRole("button", { name: "First Honey" }),
  );
  await openPicker(resetChat);
  await resetChat.user.click(
    screen.getByRole("button", { name: "Reset model and effort" }),
  );
  expect(readView("scope", "solo:model-picks:channel", null)).toEqual({
    [second.pubkey]: { model: "deep", effort: "low", type: "test/agent" },
  });
  await send(resetChat);
  await waitFor(() => expect(resetChat.messages.send).toHaveBeenCalledOnce());
  expect(resetChat.messages.send).toHaveBeenCalledWith(
    "channel",
    expect.stringContaining("a"),
    [first.pubkey],
    [],
  );
  const key = `buzz-view.v1:${JSON.stringify([
    "scope",
    "solo:model-picks:channel",
  ])}`;
  const originalSetItem = Storage.prototype.setItem;
  const failedWrite = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, storageKey, value) {
      if (storageKey === key) throw new DOMException("Storage is full");
      originalSetItem.call(this, storageKey, value);
    });
  onTestFinished(() => failedWrite.mockRestore());

  await resetChat.user.type(resetChat.input(), "b");
  await openPicker(resetChat);
  await resetChat.user.click(modelButton());
  await resetChat.user.click(
    await screen.findByRole("menuitemradio", { name: "Deep" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not save model and effort for this chat",
  );
  await send(resetChat);
  await waitFor(() => expect(resetChat.messages.send).toHaveBeenCalledTimes(2));
  expect(resetChat.messages.send.mock.calls[1]?.[1]).toContain("b");
  expect(resetChat.messages.send.mock.calls[1]?.[2]).toEqual([first.pubkey]);
  expect(resetChat.messages.send.mock.calls[1]?.at(-1)).toEqual({
    [first.pubkey]: { model: "deep" },
  });
});

it("publishes a queued Solo message with the model and effort captured at submit", async () => {
  localStorage.setItem("buzz-follow-up-behavior.v1", "queue");
  const agents = sessionAgents("channel", [
    { id: "fast", label: "Fast", efforts: [] },
    {
      id: "deep",
      label: "Deep",
      efforts: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    },
  ]);
  const h = mount(
    {
      soloConversation: true,
      ownSoloConversation: true,
      chatPresentation: true,
      requireMention: true,
    },
    undefined,
    "viewer",
    agents,
  );
  h.setLibrary([first]);
  h.setProfiles(new Map([[first.pubkey, { name: "Honey", isAgent: true }]]));
  const activityListeners = new Set<() => void>();
  let activity = {
    status: "unavailable",
    records: [],
    turns: [],
    typing: [],
    local: [
      {
        agent: first.pubkey,
        channelId: "channel",
        messageId: "previous",
        state: "working",
        scope: "scope",
        threadRootId: "",
        startedAt: 1,
      },
    ],
  };
  const channel = {
    id: "channel",
    channelType: "solo" as const,
    creator: "viewer",
    archived: false,
    readOnly: false,
  };
  const channelList = { status: "ready" as const, channels: [channel] };
  h.retarget({
    ownSoloConversation: true,
    requireMention: true,
    session: {
      ...h.session,
      viewer: "viewer",
      channels: {
        ...h.session.channels,
        list: () => channelList,
      },
      channelWrites: {
        refreshMembership: async () => ({
          id: "channel",
          members: [first.pubkey],
        }),
        addAgents: vi.fn(),
      },
      agentActivity: {
        activate: () => () => {},
        snapshot: () => activity,
        subscribe: (listener: () => void) => {
          activityListeners.add(listener);
          return () => activityListeners.delete(listener);
        },
      },
    } as unknown as RelaySession,
  });

  await h.user.type(h.input(), "Queued with the deep model");
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  await h.user.click(
    await screen.findByRole("button", { name: /Model.*effort/ }),
  );
  await h.user.click(
    await screen.findByRole("button", { name: "Model for Honey in this chat" }),
  );
  await h.user.click(
    await screen.findByRole("menuitemradio", { name: "Deep" }),
  );
  const effort = await screen.findByLabelText("Effort for Honey in this chat");
  effort.focus();
  await h.user.keyboard("{ArrowRight}");
  await h.user.keyboard("{Escape}");
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("region", { name: "Queued follow-ups" });
  expect(h.messages.send).not.toHaveBeenCalled();

  await h.user.type(h.input(), "Next message");
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  await h.user.click(
    await screen.findByRole("button", { name: /Model.*effort/ }),
  );
  await h.user.click(
    await screen.findByRole("button", { name: "Model for Honey in this chat" }),
  );
  await h.user.click(
    await screen.findByRole("menuitemradio", { name: "Fast" }),
  );
  activity = {
    ...activity,
    local: activity.local.map((row) => ({ ...row, state: "done" })),
  };
  act(() => {
    for (const listener of activityListeners) listener();
  });

  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send.mock.calls[0]?.[0]).toBe("channel");
  expect(h.messages.send.mock.calls[0]?.[1]).toContain(
    "Queued with the deep model",
  );
  expect(h.messages.send.mock.calls[0]?.[2]).toEqual([first.pubkey]);
  expect(h.messages.send.mock.calls.at(-1)?.at(-1)).toEqual({
    [first.pubkey]: { model: "deep", effort: "high" },
  });
});

it("opens the effort picker at the effort the agent's next run uses", async () => {
  const snapshot = {
    status: "ready",
    agents: [
      {
        key: first.pubkey,
        pubkey: first.pubkey,
        name: "Honey",
        type: "test/agent",
      },
    ],
  };
  const models = {
    current: "fast",
    models: [
      {
        id: "fast",
        label: "Fast",
        efforts: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
        effort: "medium",
      },
    ],
  };
  const types = [{ key: "test/agent", models: () => models }];
  const agents = {
    find: (pubkey: string) =>
      snapshot.agents.find((agent) => agent.pubkey === pubkey),
    joinable: () => [],
    sessionState: () => "unavailable" as const,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    types: () => types,
  } as unknown as Agents;
  const h = mount({}, undefined, undefined, agents);
  const open = async () => {
    await h.user.click(
      await screen.findByRole("button", {
        name: /Model.*effort/,
      }),
    );
    return screen.findByLabelText("Effort for Honey's next run");
  };
  const send = async () => {
    await h.user.keyboard("{Escape}");
    await h.user.click(screen.getByRole("button", { name: "Send message" }));
  };
  await h.user.type(h.input(), "think hard");
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  const slider = await open();
  expect(slider).toHaveAttribute("aria-valuetext", "Medium");
  // A known level is drawn like a picked one, not muted.
  expect(slider.closest("[data-unknown]")).toBeNull();
  slider.focus();
  await h.user.keyboard("{ArrowRight}");
  expect(slider).toHaveAttribute("aria-valuetext", "High");
  // Back to the agent's own effort is no pick at all.
  await h.user.keyboard("{ArrowLeft}");
  expect(slider).toHaveAttribute("aria-valuetext", "Medium");
  await send();
  expect(h.messages.send).toHaveBeenLastCalledWith(
    "channel",
    expect.stringContaining("think hard"),
    [first.pubkey],
    [],
  );
});

it("sends channel messages and thread replies through real form and keyboard events", async () => {
  const h = mount();
  await h.user.type(h.input(), "channel draft");
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "channel draft",
    [],
    [],
  );
  expect(h.messages.reply).not.toHaveBeenCalled();
  h.retarget({ threadRootId: "root" });
  await h.user.type(h.input(), "thread draft");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}");
  expect(h.input()).toHaveValue("thread draft\n");
  // This checks the composition guard, not native IME behavior.
  fireEvent.keyDown(h.input(), { key: "Enter", isComposing: true });
  expect(h.messages.reply).not.toHaveBeenCalled();
  await h.user.keyboard("{Enter}");
  expect(h.messages.reply).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "root",
    "thread draft\n",
    [],
    [],
  );
  expect(h.messages.send).toHaveBeenCalledTimes(1);
  expect(h.onSend.mock.calls).toEqual([["channel-id"], ["reply-id"]]);
  expect(h.input()).toHaveValue("");
});

it.each([
  ["- ", "ul", "- first\n- second"],
  ["3. ", "ol", "3. first\n4. second"],
])(
  "continues a typed %s list on Enter and sends with the button",
  async (marker, tag, markdown) => {
    const h = mount();
    await h.user.type(h.input(), `${marker}first`);
    expect(h.input().querySelector(`${tag} > li`)).toHaveTextContent("first");
    // Composition confirmation must neither split nor send the list.
    fireEvent.keyDown(h.input(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(h.input(), { key: "Enter", keyCode: 229 });
    expect(h.input().querySelectorAll(`${tag} > li`)).toHaveLength(1);
    await h.user.keyboard("{Enter}second");
    expect(h.input().querySelectorAll(`${tag} > li`)).toHaveLength(2);
    expect(h.messages.send).not.toHaveBeenCalled();
    await h.user.click(screen.getByRole("button", { name: "Send message" }));
    expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
      "channel",
      markdown,
      [],
      [],
    );
    expect(h.input()).toHaveValue("");
  },
);

it("exits an empty list item on Enter, then sends from ordinary prose", async () => {
  const h = mount();
  await h.user.type(h.input(), "- first");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}second{Enter}{Enter}");
  expect(h.input().querySelectorAll("ul > li")).toHaveLength(2);
  expect(h.input().querySelector(":scope > p")).not.toBeNull();
  fireEvent.keyDown(h.input(), { key: "Enter", repeat: true });
  expect(h.messages.send).not.toHaveBeenCalled();
  await h.user.keyboard("outside{Enter}");
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "- first\n- second\n\noutside",
    [],
    [],
  );
});

it("uses Enter to leave a nested empty item without sending", async () => {
  const h = mount();
  await h.user.type(h.input(), "- first{Enter}nested{Tab}{Enter}{Enter}");
  expect(h.input().querySelector("ul ul > li")).toHaveTextContent("nested");
  expect(h.input().querySelectorAll(":scope > ul > li")).toHaveLength(2);
  expect(h.messages.send).not.toHaveBeenCalled();
  await h.user.keyboard("{Enter}");
  expect(h.input().querySelector(":scope > p")).not.toBeNull();
  expect(h.messages.send).not.toHaveBeenCalled();
});

it("accepts a completion before handling list Enter", async () => {
  const h = mount();
  await h.user.type(h.input(), "- !search");
  expect(h.publish(h.completionRequests.length - 1)).not.toBe(false);
  await h.user.keyboard("{Enter}");
  expect(h.input().querySelectorAll("ul > li")).toHaveLength(1);
  expect(h.input()).toHaveValue("chosen ");
  expect(h.messages.send).not.toHaveBeenCalled();
});

it("sends a pasted fenced block verbatim on Enter instead of opening a block from its closing fence", async () => {
  const h = mount();
  act(() => {
    h.input().focus();
    fireEvent.paste(h.input(), {
      clipboardData: {
        items: [],
        getData: (type: string) =>
          type === "text/plain" ? "```\ncode\n```" : "",
      },
    });
  });
  expect(h.input()).toHaveValue("```\ncode\n```");
  await h.user.keyboard("{Enter}");
  expect(h.input().querySelector("pre")).toBeNull();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "```\ncode\n```",
    [],
    [],
  );
  expect(h.input()).toHaveValue("");
});

it("keeps a composed message unchanged through caret keys at its end and refuses a Right Arrow committed as text in either form", async () => {
  const h = mount();
  await h.user.type(h.input(), "```");
  expect(h.input().querySelector("pre")).not.toBeNull();
  await h.user.keyboard(
    "Hello!{Shift>}{Enter}{Enter}{/Shift}acascac{Shift>}{Enter}{/Shift}a**a** _a_{Shift>}{Enter}{/Shift}- acacs{Shift>}{Enter}{Enter}{/Shift}",
  );
  expect(h.input().querySelector("pre code")).toHaveTextContent("Hello!");
  expect(h.input().querySelector("strong")).toHaveTextContent("a");
  expect(h.input().querySelector("em")).toHaveTextContent("a");
  expect(h.input().querySelector("ul > li")).toHaveTextContent("acacs");
  expect(h.input()).toHaveValue("Hello!\nacascac\naa a\nacacs\n");
  const html = h.input().innerHTML;
  for (let i = 0; i < 11; i++) await h.user.keyboard("{ArrowRight}");
  for (const key of [
    "ArrowLeft",
    "ArrowUp",
    "ArrowDown",
    "Shift",
    "Meta",
    "Escape",
  ])
    await h.user.keyboard(`{${key}}`);
  // jsdom does not model Home and End on a contenteditable element.
  for (const key of ["Home", "End"]) {
    fireEvent.keyDown(h.input(), { key, code: key });
    fireEvent.keyUp(h.input(), { key, code: key });
  }
  expect(h.input()).toHaveValue("Hello!\nacascac\naa a\nacacs\n");
  expect(h.input().innerHTML).toBe(html);
  expect(h.messages.send).not.toHaveBeenCalled();
  // The desktop build committed Right Arrow's raw keyboard-layout translation
  // U+001D; AppKit's function-key character for the key is U+F703. Neither
  // has a glyph, so each assertion names its form rather than the character.
  for (const [label, character] of [
    ["Right Arrow's layout translation U+001D", "\u001D"],
    ["Right Arrow's function-key character U+F703", "\uF703"],
  ] as const) {
    let prevented = false;
    act(() => {
      h.input().focus();
      prevented = !h.input().dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: character,
        }),
      );
    });
    expect(prevented, label).toBe(true);
    expect(h.input(), label).toHaveValue("Hello!\nacascac\naa a\nacacs\n");
    expect(h.input().innerHTML, label).toBe(html);
    expect(h.messages.send, label).not.toHaveBeenCalled();
  }
});

it("prefixes thread replies with the selected media time and clears it after send", async () => {
  const clearMediaTime = vi.fn();
  const h = mount({
    threadRootId: "root",
    mediaTimeSeconds: 72.8,
    clearMediaTime,
  });
  expect(screen.getByText("Commenting at 1:12")).toBeVisible();
  await h.user.type(h.input(), "trim this ");
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.reply).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "root",
    "⏱ 1:12 — trim this",
    [],
    [],
  );
  expect(clearMediaTime).toHaveBeenCalledOnce();
  expect(h.input()).toHaveValue("");
});

it("lets the visible media time indicator dismiss without sending", async () => {
  const clearMediaTime = vi.fn();
  const h = mount({
    threadRootId: "root",
    mediaTimeSeconds: 12,
    clearMediaTime,
  });
  await h.user.click(screen.getByRole("button", { name: "Remove video time" }));
  expect(clearMediaTime).toHaveBeenCalledOnce();
  expect(h.messages.reply).not.toHaveBeenCalled();
});

it("hides the media time indicator while keeping the send prefix", async () => {
  const clearMediaTime = vi.fn();
  const h = mount({
    threadRootId: "root",
    mediaTimeSeconds: 12,
    clearMediaTime,
    hideMediaTimeIndicator: true,
  });
  expect(screen.queryByText("Commenting at 0:12")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Remove video time" }),
  ).not.toBeInTheDocument();
  await h.user.type(h.input(), "hidden frame");
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.reply).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "root",
    "⏱ 0:12 — hidden frame",
    [],
    [],
  );
  expect(clearMediaTime).toHaveBeenCalledOnce();
});

it("isolates channel, thread and identity drafts through retargeting and remounting", () => {
  const h = mount();
  h.fill("channel draft");
  h.retarget({ threadRootId: "one" });
  expect(h.input()).toHaveValue("");
  h.fill("first thread");
  h.retarget({ threadRootId: "two" });
  h.fill("second thread");
  h.retarget({ threadRootId: "one", scope: "other identity" });
  expect(h.input()).toHaveValue("");
  h.fill("other identity");
  h.retarget({ threadRootId: "one", scope: "scope" });
  expect(h.input()).toHaveValue("first thread");
  h.retarget({ threadRootId: "two" });
  expect(h.input()).toHaveValue("second thread");
  h.unmount();
  const restored = mount();
  expect(restored.input()).toHaveValue("channel draft");
  restored.retarget({ threadRootId: "one", scope: "other identity" });
  expect(restored.input()).toHaveValue("other identity");
});

it("retains rejected intent and clears the draft only after the outbox accepts it", async () => {
  const h = mount({ threadRootId: "root" });
  h.fill("retry me");
  h.messages.reply.mockImplementationOnce(() => {
    throw new Error("outbox full");
  });
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.input()).toHaveValue("retry me");
  expect(h.onSend).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("outbox full");
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.reply).toHaveBeenCalledTimes(2);
  expect(h.input()).toHaveValue("");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("labels simultaneous composers independently and prevents disabled or unsupported writes", async () => {
  const channel = mount();
  const thread = mount({ threadRootId: "root" });
  expect(screen.getByLabelText("Message #General")).toBe(channel.input());
  expect(screen.getByRole("textbox", { name: "Reply to thread" })).toBe(
    thread.input(),
  );
  expect(thread.input().id).not.toBe(channel.input().id);
  thread.fill("retain me");
  thread.retarget({ disabled: true });
  expect(thread.input()).toHaveAttribute("aria-disabled", "true");
  expect(thread.input()).toHaveAttribute("contenteditable", "false");
  await thread.user.click(
    within(thread.container).getByRole("button", { name: "Send message" }),
  );
  expect(thread.messages.reply).not.toHaveBeenCalled();
  expect(thread.input()).toHaveValue("retain me");
  thread.retarget({
    session: {
      ...thread.session,
      outbox: { supports: () => false },
    } as unknown as RelaySession,
  });
  expect(
    within(thread.container).queryByRole("textbox"),
  ).not.toBeInTheDocument();
  expect(
    within(thread.container).getByText(
      "This relay connection supports reading only.",
    ),
  ).toBeVisible();
});

it("subscribes to emoji changes and releases the subscription when unmounted", () => {
  const h = mount();
  h.fill(":party:");
  expect(h.input().querySelectorAll("img[alt=':party:']")).toHaveLength(0);
  expect(h.emojiListeners.size).toBe(1);
  expect(h.session.emoji.ensure).toHaveBeenCalled();
  h.setEmoji([{ shortcode: "party", url: "https://emoji.test/party.png" }]);
  expect(h.input().querySelectorAll("img[alt=':party:']")).toHaveLength(1);
  h.setEmoji([]);
  expect(h.input().querySelectorAll("img[alt=':party:']")).toHaveLength(0);
  h.unmount();
  expect(h.emojiListeners.size).toBe(0);
});

it.each([undefined, "root"])(
  "persists exact namesake recipients for %s without resolving typed prose",
  async (root) => {
    const options = root ? { threadRootId: root } : {};
    let h = mount(options);
    h.fill("@Honey prose only");
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.[root ? 3 : 2],
    ).toEqual([]);
    h.fill("Please help ");
    await h.user.click(screen.getByRole("button", { name: "First Honey" }));
    await h.user.click(screen.getByRole("button", { name: "Second Honey" }));
    h.unmount();
    h = mount(options);
    expect(h.input()).toHaveValue("Please help @Honey @Honey ");
    expect(
      within(h.input()).getAllByRole("img", {
        name: /^Person Honey, public key ending/,
      }),
    ).toHaveLength(2);
    expect(
      within(
        screen.getByRole("region", { name: "Explicit mentions" }),
      ).getAllByRole("button"),
    ).toHaveLength(2);
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.[root ? 3 : 2],
    ).toEqual([first.pubkey, second.pubkey]);
    expect(h.input()).toHaveValue("");
    h.unmount();
    h = mount(options);
    h.fill("@Honey typed after send");
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.[root ? 3 : 2],
    ).toEqual([]);
  },
);

it("restores live profile avatars with one removal control per exact recipient", async () => {
  const h = mount();
  const media = vi
    .spyOn(h.session, "media")
    .mockImplementation((url) =>
      url.replace("https://art.test", "https://media.test"),
    );
  act(() => {
    h.commands().insertMention(first);
    h.commands().insertMention(second);
    h.commands().insertMention(second);
  });
  let region = screen.getByRole("region", {
    name: "Explicit mentions",
  });
  const controls = within(region).getAllByRole("button");
  expect(controls).toHaveLength(2);
  expect(controls[1]).toHaveTextContent("H");
  // Profiles can arrive after draft restoration; artwork must update without an edit.
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Honey", picture: "https://art.test/person.png" }],
      [
        second.pubkey,
        { name: "Honey", picture: "https://art.test/agent.png", isAgent: true },
      ],
    ]),
  );
  expect(controls[0]?.querySelector(".buzz-avatar")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  expect(controls[1]?.querySelector(".buzz-avatar")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  expect(controls[1]?.querySelector("img")).toHaveAttribute(
    "src",
    "https://media.test/agent.png",
  );
  expect(media).toHaveBeenCalledWith("https://art.test/agent.png", "small");
  // Loaded-library hints update both artwork layers without another keystroke;
  // clearing them removes only that fallback, not self-declared agent metadata.
  for (const control of controls)
    expect(control.querySelectorAll("[data-avatar-shape]")).toHaveLength(2);
  for (const identities of [[first], []]) {
    h.setLibrary(identities);
    for (const [index, control] of controls.entries())
      for (const artwork of control.querySelectorAll("[data-avatar-shape]"))
        expect(artwork).toHaveAttribute(
          "data-avatar-shape",
          index === 1 || identities.length ? "squircle" : "circle",
        );
  }
  expect(h.session.agentLibrary.refresh).not.toHaveBeenCalled();
  h.retarget({ disabled: true });
  for (const control of controls) expect(control).toBeDisabled();
  h.retarget({ disabled: false, extensions: undefined });
  // The optional picker does not own saved intent or its removal controls.
  region = screen.getByRole("region", { name: "Explicit mentions" });
  await h.user.click(
    within(region).getByRole("button", {
      name: `Remove mention Honey ${second.pubkey}`,
    }),
  );
  expect(within(region).getAllByRole("button")).toHaveLength(1);
  expect(h.input()).toHaveValue("@Honey @Honey @Honey ");
  expect(h.input().querySelectorAll(".inline-chip")).toHaveLength(1);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledWith(
    "channel",
    "@Honey @Honey @Honey ",
    [first.pubkey],
    [],
  );
  expect(
    screen.queryByRole("region", { name: "Explicit mentions" }),
  ).not.toBeInTheDocument();
});

// Explicit notification intent must remain visible even where Markdown previews are suppressed.
it.each([
  ["inline code", "`", " `"],
  ["fenced code", "```\n", "\n```"],
  ["indented code", "    ", ""],
  ["image", "![", "](https://example.test/image.png)"],
  [
    "image reference",
    "![",
    "][image]\n\n[image]: https://example.test/image.png",
  ],
  ["definition", '[image]: https://example.test/image.png "', '"'],
  ["HTML", "<!-- ", " -->"],
  ["link label", "[", "](https://example.test)"],
  ["deep Markdown", "> ".repeat(101), ""],
])(
  "discloses selected namesakes in %s before and after restoring a draft",
  (_kind, prefix, suffix) => {
    let h = mount();
    h.fill(`${prefix}@Honey ${suffix}`);
    expect(h.input().querySelector(".inline-chip")).toBeNull();
    h.submit();
    expect(h.messages.send.mock.calls.at(-1)?.[2]).toEqual([]);
    h.fill(`${prefix}${suffix}`);
    h.input().setSelectionRange(prefix.length, prefix.length);
    act(() => {
      h.commands().insertMention(first);
      h.commands().insertMention(second);
    });
    const text = `${prefix}@Honey @Honey ${suffix}`;
    const labels = [
      "Person Honey, public key ending r c a j",
      "Person Honey, public key ending 0 4 h u",
    ];
    const check = () => {
      expect(h.input()).toHaveValue(text);
      for (const name of labels)
        expect(within(h.input()).getByRole("img", { name })).toBeVisible();
    };
    check();
    h.unmount();
    h = mount();
    check();
    h.submit();
    expect(h.messages.send).toHaveBeenCalledWith(
      "channel",
      text,
      [first.pubkey, second.pubkey],
      [],
    );
  },
);

it.each([undefined])(
  "keeps an untouched mention when smart punctuation replaces text behind the caret in %s",
  async (root) => {
    const h = mount(root ? { threadRootId: root } : {});
    act(() => {
      h.commands().insertMention(first);
      h.commands().insertText("can you see this is's");
    });
    const input = h.input();
    const paragraph = input.querySelector("p");
    if (!paragraph) throw new Error("Missing editor paragraph");
    const text = [...paragraph.childNodes].find(
      (node) => node instanceof Text && node.data.includes("is's"),
    );
    if (!(text instanceof Text)) throw new Error("Missing editable text");
    const quote = text.data.indexOf("'");
    expect(quote).toBeGreaterThan(0);
    const target = document.createRange();
    target.setStart(text, quote);
    target.setEnd(text, quote + 1);
    // WebKit's replacement range is behind the caret, not the selection.
    act(() => input.setSelectionRange(input.value.length, input.value.length));
    const before = new InputEvent("beforeinput", {
      bubbles: true,
      inputType: "insertReplacementText",
      data: "’",
    });
    Object.defineProperty(before, "getTargetRanges", {
      value: () => [target],
    });
    fireEvent(input, before);
    text.replaceData(quote, 1, "’");
    fireEvent.input(input, {
      inputType: "insertReplacementText",
      data: "’",
    });
    await waitFor(() =>
      expect(input).toHaveValue("@Honey can you see this is’s"),
    );
    expect(
      within(input).getByRole("img", { name: "Person Honey" }),
    ).toBeVisible();
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.[root ? 3 : 2],
    ).toEqual([first.pubkey]);
  },
);

it("qualifies both namesakes retroactively without changing source and removes qualifiers with ambiguity", () => {
  const h = mount();
  act(() => {
    h.commands().insertMention(first);
  });
  expect(
    within(h.input()).getByRole("img", { name: "Person Honey" }),
  ).toBeVisible();
  act(() => {
    h.commands().insertMention(first);
  });
  expect(h.input().textContent).not.toContain("npub");
  act(() => {
    h.commands().insertMention(second);
  });
  expect(h.input()).toHaveValue("@Honey @Honey @Honey ");
  expect(
    within(h.input()).getAllByRole("img", {
      name: "Person Honey, public key ending r c a j",
    }),
  ).toHaveLength(2);
  expect(
    within(h.input()).getByRole("img", {
      name: "Person Honey, public key ending 0 4 h u",
    }),
  ).toHaveTextContent("Honey · 04hu");
  h.input().setSelectionRange(14, 20);
  act(() => {
    h.commands().insertText("");
  });
  expect(h.input()).toHaveValue("@Honey @Honey  ");
  expect(h.input().textContent).not.toContain("npub");
  h.submit();
  expect(h.messages.send).toHaveBeenCalledWith(
    "channel",
    "@Honey @Honey  ",
    [first.pubkey, first.pubkey],
    [],
  );
});

it.each([0, 7])(
  "does not replay qualifier motion after removing at %i or restoring a destination draft",
  (start) => {
    const h = mount();
    act(() => {
      h.commands().insertMention(first);
    });
    act(() => {
      h.commands().insertMention(second);
    });
    expect(h.input().querySelectorAll("[data-reveal]")).toHaveLength(1);
    h.input().setSelectionRange(start, start + 6);
    act(() => {
      h.commands().insertText("");
    });
    act(() => {
      h.commands().insertMention(start === 0 ? first : second);
    });
    expect(h.input().querySelectorAll("[data-reveal]")).toHaveLength(0);
    h.retarget({ channelId: "other" });
    act(() => {
      h.commands().insertMention(first);
    });
    h.retarget({ channelId: "channel" });
    expect(h.input().querySelectorAll(".inline-chip-qualifier")).toHaveLength(
      2,
    );
    expect(h.input().querySelectorAll("[data-reveal]")).toHaveLength(0);
  },
);

it("replacing an inline mention with ordinary prose removes notification intent", async () => {
  const h = mount();
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  expect(
    screen.getByRole("region", { name: "Explicit mentions" }),
  ).toBeVisible();
  h.fill("no recipient now");
  h.submit();
  expect(h.messages.send.mock.calls[0]?.[2]).toEqual([]);
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  expect(
    within(h.input()).getByRole("img", { name: "Person Honey" }),
  ).toBeVisible();
  h.input().setSelectionRange(0, 6);
  act(() => {
    h.commands().insertText("Honey");
  });
  expect(within(h.input()).queryByRole("img")).not.toBeInTheDocument();
  h.submit();
  expect(h.messages.send.mock.calls[1]?.[2]).toEqual([]);
});

it("ambiguous namesake replacement cannot notify the wrong remaining identity", async () => {
  const h = mount();
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  await h.user.click(screen.getByRole("button", { name: "Second Honey" }));
  h.fill("@Honey help");
  h.submit();
  expect(h.messages.send.mock.calls[0]?.[2]).toEqual([]);
});

it("shows tools who the draft mentions, keeping the list while only prose changes", async () => {
  const h = mount();
  expect(h.commands().recipients).toEqual([]);
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  const mentioned = h.commands().recipients;
  expect(mentioned).toEqual([first]);
  act(() => {
    h.commands().insertText("hi ");
  });
  expect(h.commands().recipients).toBe(mentioned);
  await h.user.click(screen.getByRole("button", { name: "Second Honey" }));
  expect(h.commands().recipients).toEqual([first, second]);
  h.fill("no recipient now");
  expect(h.commands().recipients).toEqual([]);
});

it("serializes tool commands in one React batch and rejects malformed recipients", () => {
  const h = mount();
  h.fill("Hi ");
  act(() => {
    const { insertText, insertMention } = h.commands();
    expect(insertText("there ")).toBe(true);
    expect(insertMention(first)).toBe(true);
    expect(insertText("and ")).toBe(true);
    expect(insertMention(second)).toBe(true);
    expect(insertMention({ pubkey: "wrong", name: "Honey" })).toBe(false);
    expect(insertMention({ ...first, name: "  " })).toBe(false);
    expect(insertMention(null as unknown as typeof first)).toBe(false);
  });
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "Hi there @Honey and @Honey ",
    [first.pubkey, second.pubkey],
    [],
  );
});

it("revokes captured tool commands after retargeting, disabling and unmounting", () => {
  const h = mount();
  h.fill("channel draft");
  const channel = h.commands();
  h.retarget({ threadRootId: "root" });
  act(() => {
    expect(channel.insertText("stale")).toBe(false);
    expect(channel.insertMention(first)).toBe(false);
    expect(channel.insertResource(resource)).not.toBe(true);
  });
  expect(h.input()).toHaveValue("");
  const thread = h.commands();
  h.retarget({ disabled: true });
  act(() => {
    expect(thread.insertText("disabled")).toBe(false);
    expect(thread.insertResource(resource)).not.toBe(true);
  });
  h.retarget({ disabled: false });
  act(() => {
    expect(h.commands().insertText("current")).toBe(true);
  });
  expect(h.input()).toHaveValue("current");
  const current = h.commands();
  h.unmount();
  act(() => {
    expect(current.insertText("unmounted")).toBe(false);
  });
});

it("keeps custom emoji text readable and sends repeated shortcodes unchanged", () => {
  const h = mount();
  h.setEmoji([{ shortcode: "party", url: "https://emoji.test/party.png" }]);
  act(() => {
    expect(h.commands().insertText(":party:")).toBe(true);
  });
  expect(h.input()).toHaveValue(":party:");
  expect(h.input()).toHaveAttribute("data-single-emoji", "true");
  act(() => {
    expect(h.commands().insertText(":party:")).toBe(true);
  });
  expect(h.input()).toHaveValue(":party::party:");
  expect(h.input().querySelectorAll("img[alt=':party:']")).toHaveLength(2);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    ":party::party:",
    [],
    [],
  );
});

it.each([
  ["  :party: \n\t :party:  ", true],
  [":party:".repeat(24), true],
  [`${Array(24).fill(":party:").join(" ")} 😀`, false],
])(
  "classifies images-only emoji drafts without changing their text: %s",
  (draft, imagesOnly) => {
    const h = mount();
    h.setEmoji([{ shortcode: "party", url: "https://emoji.test/party.png" }]);
    h.fill(draft);
    expect(h.input()).toHaveValue(draft);
    expect(h.input()).toHaveAttribute("data-single-emoji", "true");
    if (imagesOnly)
      expect(h.input()).toHaveAttribute("data-emoji-images-only", "true");
    else expect(h.input()).not.toHaveAttribute("data-emoji-images-only");
  },
);

it("renders a leading custom emoji inline without changing trailing text", () => {
  const h = mount();
  h.setEmoji([{ shortcode: "bufo", url: "https://emoji.test/bufo.png" }]);
  h.fill(":bufo:lakjsdlkjflakjsdf");
  expect(h.input()).not.toHaveAttribute("data-single-emoji");
  expect(h.input()).toHaveValue(":bufo:lakjsdlkjflakjsdf");
  expect(h.container.querySelectorAll("img")).toHaveLength(1);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    ":bufo:lakjsdlkjflakjsdf",
    [],
    [],
  );
});

/** The real Emoji provider; the fixture provider above never publishes an exact match. */
function mountEmojiTypeahead() {
  // jsdom has no canvas; previews fall back to the uncentred glyph.
  const context = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(() => null);
  onTestFinished(() => context.mockRestore());
  const empty: [] = [];
  const none = { snapshot: () => empty, subscribe: () => () => {} };
  const completions: readonly Contribution<ComposerCompletion>[] = [
    {
      id: "typeahead",
      key: "buzz.emoji/typeahead",
      pluginId: "buzz.emoji",
      revision: "1",
      title: "Emoji",
      match: ({ text, start }) => emojiQuery(text, start),
      component: EmojiCompletion,
    },
  ];
  return mount({
    extensions: {
      tools: none,
      inline: none,
      completions: { snapshot: () => completions, subscribe: () => () => {} },
    },
  });
}
// ":" is Shift+; on US layouts, so the typed colon arrives with shiftKey set.
const colon = (input: ComposerInputElement) =>
  fireEvent.keyDown(input, { key: ":", shiftKey: true });

it.each([
  ["hello :-1", "hello 👎"],
  [":+1", "👍"],
  ["say :SMILE", "say 😄"],
  // The second shortcode may follow a converted emoji with no space between them.
  ["😄:wave", "😄👋"],
])(
  "replaces an exact shortcode with its emoji on the closing colon: %s",
  async (typed, expected) => {
    const h = mountEmojiTypeahead();
    h.fill(typed);
    const label = `:${typed.slice(typed.lastIndexOf(":") + 1).toLowerCase()}:`;
    await screen.findByRole("option", { name: label });
    expect(colon(h.input())).toBe(false);
    expect(h.input()).toHaveValue(expected);
    expect([h.input().selectionStart, h.input().selectionEnd]).toEqual([
      expected.length,
      expected.length,
    ]);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  },
);

it("keeps the typed colon after a partial shortcode and never accepts emoji on Space", async () => {
  const h = mountEmojiTypeahead();
  h.fill("hello :smil");
  await screen.findByRole("option", { name: ":smile:" });
  expect(colon(h.input())).toBe(true);
  expect(h.input()).toHaveValue("hello :smil");
  h.fill("hello :-1");
  await screen.findByRole("option", { name: ":-1:" });
  expect(fireEvent.keyDown(h.input(), { key: " " })).toBe(true);
  expect(h.input()).toHaveValue("hello :-1");
});

it.each(["at 10:30"])(
  "leaves the colon in times and URLs alone: %s",
  (typed) => {
    const h = mountEmojiTypeahead();
    h.fill(typed);
    // No syntax match means no provider mounts, so no asynchronous search is pending.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(colon(h.input())).toBe(true);
    expect(h.input()).toHaveValue(typed);
  },
);

it("keeps a shortcode literal inside inline code", async () => {
  const h = mountEmojiTypeahead();
  h.fill("run :-1");
  act(() => {
    h.input().setSelectionRange(0, 7);
    h.input().toggleFormat("code");
    h.input().setSelectionRange(7, 7);
  });
  fireEvent(document, new Event("selectionchange"));
  await screen.findByRole("option", { name: ":-1:" });
  expect(colon(h.input())).toBe(true);
  expect(h.input()).toHaveValue("run :-1");
});

it("waits for the community catalog before authorizing a Unicode replacement", async () => {
  const h = mountEmojiTypeahead();
  h.setEmoji([], "loading");
  h.fill(":smile");
  await screen.findByRole("option", { name: ":smile:" });
  expect(colon(h.input())).toBe(true);
  expect(h.input()).toHaveValue(":smile");
  // Release the pending catalog with a namesake after Unicode has settled.
  h.setEmoji([{ shortcode: "smile", url: "https://emoji.test/smile.png" }]);
  await screen.findByRole("option", { name: ":smile: Unicode emoji" });
  expect(colon(h.input())).toBe(true);
  // A later complete, unambiguous catalog permits the same query without typing.
  h.setEmoji([]);
  await screen.findByRole("option", { name: ":smile:" });
  expect(colon(h.input())).toBe(false);
  expect(h.input()).toHaveValue("😄");
});

it("keeps Unicode suggestions and retry without replacement after a community failure", async () => {
  const h = mountEmojiTypeahead();
  h.setEmoji([], "error");
  h.fill(":smile");
  await screen.findByText(
    "Community emoji unavailable; Unicode results shown.",
  );
  expect(screen.getByRole("option", { name: ":smile:" })).toBeInTheDocument();
  expect(colon(h.input())).toBe(true);
  await h.user.click(screen.getByRole("option", { name: "Retry suggestions" }));
  expect(h.session.emoji.refresh).toHaveBeenCalledOnce();
  h.setEmoji([]);
  await screen.findByRole("option", { name: ":smile:" });
  expect(colon(h.input())).toBe(false);
});

it("keeps custom suggestions and retry without replacement after a Unicode failure", async () => {
  const search = vi
    .spyOn(emojiSearch, "searchEmoji")
    .mockRejectedValue(new Error("chunk unavailable"));
  onTestFinished(() => search.mockRestore());
  const h = mountEmojiTypeahead();
  h.setEmoji([{ shortcode: "party", url: "https://emoji.test/party.png" }]);
  h.fill(":party");
  await screen.findByText("Unicode emoji unavailable. Custom matches shown.");
  expect(screen.getByRole("option", { name: ":party:" })).toBeInTheDocument();
  expect(colon(h.input())).toBe(true);
  search.mockRestore();
  await h.user.click(screen.getByRole("option", { name: "Retry suggestions" }));
  await waitFor(() =>
    expect(
      screen.queryByText("Unicode emoji unavailable. Custom matches shown."),
    ).toBeNull(),
  );
  expect(colon(h.input())).toBe(false);
  expect(h.input()).toHaveValue(":party:");
});

it.each([
  ["```\n:-1\n```", 7],
  ["~~~\n:-1", 7],
  ["`run :-1`", 8],
  ["    :-1", 7],
])(
  "keeps a shortcode literal inside raw Markdown code: %s",
  async (text, caret) => {
    const h = mountEmojiTypeahead();
    h.fill(text);
    act(() => h.input().setSelectionRange(caret, caret));
    fireEvent(document, new Event("selectionchange"));
    await screen.findByRole("option", { name: ":-1:" });
    expect(colon(h.input())).toBe(true);
    expect(h.input()).toHaveValue(text);
  },
);

it("restores the typed colon and collapsed caret with one undo, and isolates subsequent typing", async () => {
  const h = mountEmojiTypeahead();
  h.fill("hello :-1");
  await screen.findByRole("option", { name: ":-1:" });
  expect(colon(h.input())).toBe(false);
  expect(h.input()).toHaveValue("hello 👎");
  act(() => h.input().undo(false));
  expect(h.input()).toHaveValue("hello :-1:");
  expect([h.input().selectionStart, h.input().selectionEnd]).toEqual([10, 10]);
  act(() => h.input().undo(true));
  expect(h.input()).toHaveValue("hello 👎");
  await h.user.type(h.input(), "!");
  act(() => h.input().undo(false));
  expect(h.input()).toHaveValue("hello 👎");
  act(() => h.input().undo(false));
  expect(h.input()).toHaveValue("hello :-1:");
});

it("rejects overlong and over-limit tool edits without changing accepted intent", () => {
  const h = mount();
  h.fill("x".repeat(15999));
  act(() => {
    expect(h.commands().insertMention(first)).toBe(false);
  });
  expect(h.input()).toHaveValue("x".repeat(15999));
  expect(screen.getByRole("alert")).toHaveTextContent("too long");
  h.fill("");
  act(() => {
    for (let i = 0; i < 32; i++)
      expect(h.commands().insertMention(first)).toBe(true);
  });
  const before = h.input().value;
  act(() => {
    expect(h.commands().insertMention(first)).toBe(false);
  });
  expect(h.input()).toHaveValue(before);
  expect(screen.getByRole("alert")).toHaveTextContent("at most 32 recipients");
});

// The production composer must perform enrollment, not a pre-populated test roster.
for (const threadRootId of [undefined, "f".repeat(64)])
  it(`adds a selected local agent only on Send, then sends after membership confirmation (thread=${!!threadRootId})`, async () => {
    const control = localAgentsFixture([
      { ...localAgent, pubkey: first.pubkey, owner: "d".repeat(64) },
    ]);
    const h = mount(
      {
        scope: `https://relay.example.test:${"d".repeat(64)}`,
        ...(threadRootId ? { threadRootId } : {}),
      },
      control,
    );
    const channel = {
      id: "channel",
      name: "General",
      channelType: "stream" as const,
      members: ["d".repeat(64)],
    };
    const listeners = new Set<() => void>();
    // An acknowledged old invitation does not replace this explicit addition.
    const invitation: OutgoingEvent = {
      acknowledged: true,
      delivery: "failed",
      event: {
        id: "c".repeat(64),
        pubkey: "d".repeat(64),
        kind: 9000,
        content: "",
        created_at: Math.floor(Date.now() / 1000) - 16 * 60,
        tags: [
          ["h", "channel"],
          ["p", first.pubkey],
        ],
      },
    };
    let operations: readonly OutgoingEvent[] = [invitation];
    const retry = vi.fn();
    const add = vi.fn((input) => {
      operations = [
        {
          event: {
            ...input,
            pubkey: "d".repeat(64),
            id: "e".repeat(64),
            created_at: Math.floor(Date.now() / 1000),
          },
          delivery: "sending",
        },
      ];
      return "e".repeat(64);
    });
    const list = { status: "ready", channels: [channel] };
    Object.assign(h.session, {
      channels: { list: () => list, subscribeList: () => () => {} },
      viewer: "d".repeat(64),
      archives: {
        state: () => "not-archived",
        snapshot: () => noArchives,
      },
      channelWrites: {
        refreshMembership: vi.fn(async () => {
          if (operations[0]?.delivery === "accepted")
            channel.members = [...channel.members, first.pubkey];
          return channel;
        }),
      },
      outbox: {
        supports: () => true,
        send: add,
        retry,
        ready: async () => {},
        recover: async (
          _id: string,
          _recovery: unknown,
          consume?: () => void,
        ) => {
          consume?.();
        },
        acknowledge: async () => {},
        snapshot: () => operations,
        subscribe: (fn: () => void) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      },
    });
    Object.assign(h.session, {
      memberAdditions: createMemberAdditions(
        new AbortController().signal,
        (channelId, key, intent) =>
          addChannelMember(
            h.session,
            channelId,
            key,
            new AbortController().signal,
            intent,
          ),
      ),
    });
    fireEvent.click(screen.getByRole("button", { name: "First Honey" }));
    expect(add).not.toHaveBeenCalled();
    fireEvent.submit(screen.getByRole("form"));
    await act(async () => {});
    expect(add).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    await act(async () => {});
    expect(add).toHaveBeenCalledWith(
      {
        kind: 9000,
        content: "",
        tags: [
          ["h", "channel"],
          ["p", first.pubkey],
          ["role", "bot"],
        ],
      },
      { key: `member-add:channel:${first.pubkey}`, value: "1" },
    );
    expect(h.messages.send).not.toHaveBeenCalled();
    expect(h.messages.reply).not.toHaveBeenCalled();
    await act(async () => {
      operations = operations.map((item) => ({
        ...item,
        delivery: "accepted",
      }));
      for (const listener of listeners) listener();
    });
    const send = threadRootId ? h.messages.reply : h.messages.send;
    expect(send).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[threadRootId ? 3 : 2]).toEqual([first.pubkey]);
    // Native evidence now shares the ordinary remember-agent classification.
    // The follow-up stays in memory under the draft's own name; the started
    // thread seeds the agent under its current known name: with no profile,
    // the native inventory's.
    expect(h.input().value).toBe("@Honey ");
    if (!threadRootId) {
      h.retarget({
        threadRootId: "channel-id",
        threadSeed: startedSeed([first.pubkey]),
      });
      expect(h.input().value).toBe("@Fixture agent ");
    }
  });

it.each([false, true])(
  "keeps the selected draft on an enrollment error (expired=%s) without sending the message",
  async (expired) => {
    const control = localAgentsFixture([
      { ...localAgent, pubkey: first.pubkey, owner: "d".repeat(64) },
    ]);
    const h = mount(
      { scope: `https://relay.example.test:${"d".repeat(64)}` },
      control,
    );
    const add = vi.fn(() => {
      throw new Error("Cannot add agent");
    });
    const list = {
      status: "ready",
      channels: [
        { id: "channel", channelType: "stream", members: ["d".repeat(64)] },
      ],
    };
    const operations = expired
      ? [
          {
            delivery: "failed",
            event: {
              id: "e".repeat(64),
              kind: 9000,
              created_at: Math.floor(Date.now() / 1000) - 16 * 60,
              tags: [
                ["h", "channel"],
                ["p", first.pubkey],
                ["role", "bot"],
              ],
            },
          },
        ]
      : [];
    Object.assign(h.session, {
      channels: { list: () => list, subscribeList: () => () => {} },
      viewer: "d".repeat(64),
      archives: {
        state: () => "not-archived",
        snapshot: () => noArchives,
      },
      channelWrites: { refreshMembership: async () => list.channels[0] },
      outbox: {
        supports: () => true,
        send: add,
        snapshot: () => operations,
        ready: async () => {},
        recover: async (
          _id: string,
          _recovery: unknown,
          consume?: () => void,
        ) => {
          consume?.();
        },
        acknowledge: async () => {},
      },
    });
    Object.assign(h.session, {
      memberAdditions: createMemberAdditions(
        new AbortController().signal,
        (channelId, key, intent) =>
          addChannelMember(
            h.session,
            channelId,
            key,
            new AbortController().signal,
            intent,
          ),
      ),
    });
    fireEvent.click(screen.getByRole("button", { name: "First Honey" }));
    fireEvent.submit(screen.getByRole("form"));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    await act(async () => {});
    expect(screen.getByRole("alert")).toHaveTextContent(
      expired ? "addition expired" : "Cannot add agent",
    );
    expect(
      (screen.getByRole("textbox", { hidden: true }) as HTMLInputElement).value,
    ).toBe("@Honey ");
    expect(h.messages.send).not.toHaveBeenCalled();
    if (expired) expect(add).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => {});
    expect(h.input()).not.toHaveAttribute("aria-disabled", "true");
  },
);

it.each(
  ["send", "unmount", "disabled", "denied"].flatMap((outcome) =>
    ["private", "public"].map((visibility) => ({ outcome, visibility })),
  ),
)(
  "waits for agent admission before saved $visibility Solo chat messages with a Guest default: $outcome",
  async ({ outcome, visibility }) => {
    const view = mount();
    const list = {
      status: "ready",
      channels: [
        {
          id: "channel",
          channelType: "solo",
          visibility,
          joinRole: "guest",
          members: [] as string[],
        },
      ],
    };
    const library = { status: "ready", definitions: [], identities: [first] };
    let release = () => {};
    const addAgents = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          release = () => {
            if (outcome === "denied") reject(new Error("Cannot add agents"));
            else {
              list.channels[0]?.members.push(first.pubkey);
              resolve();
            }
          };
        }),
    );
    const session = {
      ...view.session,
      channels: { list: () => list, subscribeList: () => () => {} },
      agentLibrary: {
        snapshot: () => library,
        subscribe: () => () => {},
        refresh: async () => {},
        retain: () => () => {},
      },
      channelWrites: {
        addAgents,
        refreshMembership: vi.fn(async () => list.channels[0]),
      },
    } as unknown as RelaySession;
    view.retarget({ session, soloConversation: true });
    expect(view.commands().inviteAgents).toBe(true);
    await view.user.click(screen.getByRole("button", { name: "First Honey" }));
    expect(addAgents).not.toHaveBeenCalled();
    expect(session.channelWrites.refreshMembership).not.toHaveBeenCalled();
    expect(view.messages.send).not.toHaveBeenCalled();
    view.submit();
    await waitFor(() =>
      expect(addAgents).toHaveBeenCalledWith(
        "channel",
        [first.pubkey],
        expect.any(Function),
      ),
    );
    expect(view.messages.send).not.toHaveBeenCalled();
    if (outcome === "unmount") view.unmount();
    if (outcome === "disabled") view.retarget({ disabled: true });
    await act(async () => release());
    if (outcome === "send") {
      await waitFor(() => expect(view.messages.send).toHaveBeenCalledOnce());
      expect(addAgents).toHaveBeenCalledOnce();
    } else expect(view.messages.send).not.toHaveBeenCalled();
    if (outcome === "denied") {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Cannot add agents",
      );
      expect(view.input()).toHaveTextContent("Honey");
    }
  },
);

it.each(
  [undefined, "root"].flatMap((root) =>
    [false, true].map((removeMention) => ({ root, removeMention })),
  ),
)(
  "seeds a Solo chat's only agent into the pill and sends to it untagged:  root=$root, removed=$removeMention",
  async ({ root, removeMention }) => {
    const view = mount();
    const channel = {
      id: "channel",
      channelType: "solo" as const,
      members: [first.pubkey],
    };
    const list = { status: "ready" as const, channels: [channel] };
    const library = {
      status: "ready" as const,
      definitions: [],
      identities: [first],
    };
    const session = {
      ...view.session,
      viewer: "viewer",
      channels: {
        ...view.session.channels,
        list: () => list,
        subscribeList: () => () => {},
      },
      agentLibrary: {
        snapshot: () => library,
        subscribe: () => () => {},
        refresh: vi.fn(async () => {}),
      },
      channelWrites: {
        refreshMembership: vi.fn(async () => channel),
        addAgents: vi.fn(async () => {}),
      },
    } as unknown as RelaySession;
    view.retarget({
      session,
      soloConversation: true,
      ...(root ? { threadRootId: root } : {}),
    });
    view.fill("Keep going ");
    // The chat's only agent seeds the pill, so no tag is needed. A thread
    // reply is never seeded: it starts empty until an agent is picked or named.
    const sendingTo = () =>
      screen.getByRole("status", {
        name: `Sending to ${root ? "" : "Honey"}. Change agents`,
      });
    expect(sendingTo()).toBeInTheDocument();
    if (removeMention) {
      // A mention is inline text, not an explicit-mentions chip row.
      await view.user.click(
        screen.getByRole("button", { name: "First Honey" }),
      );
      expect(view.input().querySelector(".inline-chip")).not.toBeNull();
      expect(
        screen.queryByRole("region", { name: "Explicit mentions" }),
      ).not.toBeInTheDocument();
      // Deleting it brings the fallback back (nobody, in a thread).
      view.fill("Keep going ");
      expect(view.input().querySelector(".inline-chip")).toBeNull();
      expect(sendingTo()).toBeInTheDocument();
    }
    view.submit();
    const sent = root ? view.messages.reply : view.messages.send;
    if (root) {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Choose an agent to send",
      );
      expect(view.messages.reply).not.toHaveBeenCalled();
      expect(view.messages.send).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(sent).toHaveBeenCalled());
      expect(sent.mock.calls.at(-1)?.[2]).toEqual([first.pubkey]);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
    expect(session.channelWrites.addAgents).not.toHaveBeenCalled();
  },
);

it("requires explicit recipients when an ordinary Solo chat has multiple agents", async () => {
  const view = mount();
  const list = {
    status: "ready",
    channels: [
      {
        id: "channel",
        channelType: "solo",
        members: [first.pubkey, second.pubkey],
      },
    ],
  };
  const session = {
    ...view.session,
    channels: { list: () => list, subscribeList: () => () => {} },
    channelWrites: {
      refreshMembership: vi.fn(async () => list.channels[0]),
      addAgents: vi.fn(async () => {}),
    },
  } as unknown as RelaySession;
  view.retarget({ session, soloConversation: true });
  expect(screen.queryByRole("button", { name: "Choose an agent" })).toBeNull();
  await view.user.click(screen.getByRole("button", { name: "First Honey" }));
  view.submit();
  await waitFor(() =>
    expect(view.messages.send).toHaveBeenLastCalledWith(
      "channel",
      expect.any(String),
      [first.pubkey],
      [],
    ),
  );
  expect(session.channelWrites.addAgents).not.toHaveBeenCalled();
});

it.each(["ready", "failed", "unmounted"])(
  "refreshes cached membership before sending an existing mention: %s",
  async (outcome) => {
    const view = mount();
    const channel = {
      id: "channel",
      channelType: "solo",
      members: [first.pubkey],
    };
    const list = { status: "ready", channels: [channel] };
    const library = { status: "ready", identities: [first] };
    let release = () => {};
    const refreshMembership = vi.fn(
      () =>
        new Promise<typeof channel>((resolve, reject) => {
          release = () =>
            outcome === "failed"
              ? reject(new Error("Could not refresh channel membership"))
              : resolve(channel);
        }),
    );
    const addAgents = vi.fn();
    const session = {
      ...view.session,
      channels: { list: () => list, subscribeList: () => () => {} },
      agentLibrary: { snapshot: () => library, subscribe: () => () => {} },
      channelWrites: { refreshMembership, addAgents },
    } as unknown as RelaySession;
    view.retarget({ session, soloConversation: true });
    await view.user.click(screen.getByRole("button", { name: "First Honey" }));
    view.submit();
    await waitFor(() =>
      expect(refreshMembership).toHaveBeenCalledWith("channel"),
    );
    expect(view.messages.send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    if (outcome === "unmounted") view.unmount();
    await act(async () => release());
    expect(addAgents).not.toHaveBeenCalled();
    if (outcome === "ready") expect(view.messages.send).toHaveBeenCalledOnce();
    else expect(view.messages.send).not.toHaveBeenCalled();
    if (outcome === "failed") {
      expect(screen.getByRole("alert")).toHaveTextContent("Could not refresh");
      expect(view.input()).toHaveTextContent("Honey");
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled();
    }
  },
);

it("keeps retry submission available while a new Solo draft is locked", () => {
  const submit = vi.fn();
  const h = mount({
    submission: {
      draftKey: "solo-retry",
      initialDraft: "Keep this operation",
      locked: true,
      disabled: false,
      submit,
    },
  });
  expect(document.querySelector("[data-reserve-typing]")).toBeNull();
  expect(h.input()).toHaveAttribute("aria-disabled", "true");
  const send = screen.getByRole("button", { name: "Send message" });
  expect(send).toBeEnabled();
  fireEvent.click(send);
  expect(submit).toHaveBeenCalledWith(
    {
      text: "Keep this operation",
      recipients: [],
    },
    expect.objectContaining({ prepareForSend: expect.any(Function) }),
    // Outside Solo-with-agents no recipients are held apart from the text.
    undefined,
    undefined,
    undefined,
    undefined,
  );
  expect(h.messages.send).not.toHaveBeenCalled();
});

it.each([undefined, "root"])(
  "prefills only exact selected agents after an accepted send in %s",
  (threadRootId) => {
    const viewer = "e".repeat(64);
    const h = mount(threadRootId ? { threadRootId } : {}, undefined, viewer);
    vi.spyOn(h.session.profiles, "snapshot").mockReturnValue(
      new Map([[second.pubkey, { name: "Honey", isAgent: true }]]),
    );
    act(() => {
      h.commands().insertMention(first);
      h.commands().insertMention(second);
      h.commands().insertMention(second);
      h.commands().insertText("hello");
    });
    const send = threadRootId ? h.messages.reply : h.messages.send;
    send.mockImplementationOnce(() => {
      throw new Error("outbox full");
    });
    h.submit();
    expect(h.input()).toHaveValue("@Honey @Honey @Honey hello");
    h.submit();
    expect(send.mock.calls.at(-1)?.[threadRootId ? 3 : 2]).toEqual([
      first.pubkey,
      second.pubkey,
      second.pubkey,
    ]);
    expect(h.input()).toHaveValue("@Honey ");
    const recipients = screen.getByRole("region", {
      name: "Explicit mentions",
    });
    expect(within(recipients).getAllByRole("button")).toHaveLength(1);
    expect(
      within(recipients).getByRole("button", {
        name: `Remove mention Honey ${second.pubkey}`,
      }),
    ).toBeVisible();
    expect(
      within(h.input()).getAllByRole("img", { name: "Agent Honey" }),
    ).toHaveLength(1);
    expect(
      h.input().querySelector("button, a, [tabindex], [title]"),
    ).toBeNull();
    h.retarget({ channelId: "other" });
    expect(h.input()).toHaveValue("");
    // Nothing was saved: on return the composer seeds from the sent message
    // once it lands, in the thread (ThreadPanel) or the channel window.
    const sent = editableMessage({
      id: "5".repeat(64),
      authorId: viewer,
      mentions: [first.pubkey, second.pubkey, second.pubkey],
    });
    h.retarget({
      channelId: "channel",
      ...(threadRootId ? { threadSeed: sent } : {}),
    });
    if (!threadRootId) {
      expect(h.input()).toHaveValue("");
      h.setRows([sent]);
    }
    expect(h.input()).toHaveValue("@Honey ");
    h.submit();
    expect(send.mock.calls.at(-1)?.[threadRootId ? 3 : 2]).toEqual([
      second.pubkey,
    ]);
    h.input().setSelectionRange(0, 6);
    act(() => {
      h.commands().insertText("Honey");
    });
    expect(h.input()).toHaveValue("Honey ");
    expect(within(h.input()).queryByRole("img")).not.toBeInTheDocument();
    h.submit();
    expect(send.mock.calls.at(-1)?.[threadRootId ? 3 : 2]).toEqual([]);
    expect(h.input()).toHaveValue("");
  },
);

it("remembers agents in memory at the root and in the thread the send started, saving neither", () => {
  const h = mount();
  h.setProfiles(new Map([[first.pubkey, { name: "Honey", isAgent: true }]]));
  act(() => {
    h.commands().insertMention(first);
    h.commands().insertText("hello");
  });
  h.submit();
  expect(h.messages.send.mock.calls[0]?.[2]).toEqual([first.pubkey]);
  // The root keeps the follow-up in memory; the send saves only the empty stub.
  expect(h.input()).toHaveValue("@Honey ");
  expect(readView("scope", "draft:channel", "")).toEqual(emptied);
  // The thread has no draft until the user acts there.
  expect(viewRevision("scope", "draft:channel:thread:channel-id")).toBeNull();
  h.retarget({
    threadRootId: "channel-id",
    threadSeed: startedSeed([first.pubkey]),
  });
  expect(h.input()).toHaveValue("@Honey ");
  expect(
    within(screen.getByRole("region", { name: "Explicit mentions" })).getByRole(
      "button",
      { name: `Remove mention Honey ${first.pubkey}` },
    ),
  ).toBeVisible();
  expect(viewRevision("scope", "draft:channel:thread:channel-id")).toBeNull();
  // A reply there keeps its follow-up in memory too, and saves only the stub.
  h.submit();
  expect(h.messages.reply.mock.calls[0]?.[3]).toEqual([first.pubkey]);
  expect(h.input()).toHaveValue("@Honey ");
  expect(readView("scope", "draft:channel:thread:channel-id", "")).toEqual(
    emptied,
  );
});

it("seeds a channel composer from the viewer's latest top-level message once its window is ready, without saving", () => {
  const viewer = "e".repeat(64);
  const h = mount({}, undefined, viewer);
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Honey", isAgent: true }],
      [second.pubkey, { name: "Bea", isAgent: true }],
    ]),
  );
  const own = (id: string, mentions: readonly string[], extra = {}) =>
    editableMessage({
      id: id.repeat(64),
      authorId: viewer,
      mentions,
      ...extra,
    });
  expect(h.input()).toHaveValue("");
  h.setRows([
    own("1", [second.pubkey]),
    own("2", [first.pubkey]),
    // Neither another author's message nor the viewer's thread reply counts,
    // nor the Huddle and membership rows the viewer signs.
    editableMessage({ id: "3".repeat(64), mentions: [second.pubkey] }),
    own("4", [second.pubkey], { threadRootId: "1".repeat(64) }),
    own("5", [], { huddle: { room: "room", state: "started" } }),
    own("6", [], {
      membership: { type: "member_joined", actor: viewer, target: viewer },
    }),
  ]);
  expect(h.input()).toHaveValue("@Honey ");
  expect(viewRevision("scope", "draft:channel")).toBeNull();
  // Typing saves an ordinary draft with the seeded recipient.
  h.fill("@Honey please");
  expect(readView("scope", "draft:channel", "")).toMatchObject({
    text: "@Honey please",
  });
});

it("ends the remembered chain at the root when the viewer's latest message tagged no agent, replacing its own prefill", () => {
  const viewer = "e".repeat(64);
  const h = mount({}, undefined, viewer);
  h.setProfiles(new Map([[first.pubkey, { name: "Honey", isAgent: true }]]));
  const own = (id: string, mentions: readonly string[]) =>
    editableMessage({ id: id.repeat(64), authorId: viewer, mentions });
  h.setRows([own("1", [first.pubkey])]);
  expect(h.input()).toHaveValue("@Honey ");
  // An untagged later message of the viewer's lands, e.g. sent elsewhere.
  h.setRows([own("1", [first.pubkey]), own("2", [])]);
  expect(h.input()).toHaveValue("");
  expect(viewRevision("scope", "draft:channel")).toBeNull();
  // A removed chip stays removed until the composer is shown again.
  h.setRows([own("1", [first.pubkey]), own("2", []), own("3", [first.pubkey])]);
  expect(h.input()).toHaveValue("@Honey ");
  act(() => h.input().removeRecipient(first.pubkey));
  h.fill("");
  expect(h.input()).toHaveValue("");
  h.present(false);
  h.present(true);
  expect(h.input()).toHaveValue("@Honey ");
});

it("ends the remembered chain when the viewer's latest message tagged only people, once their profiles are known", () => {
  const viewer = "e".repeat(64);
  const h = mount({}, undefined, viewer);
  h.setProfiles(new Map([[first.pubkey, { name: "Honey", isAgent: true }]]));
  const own = (id: string, mentions: readonly string[]) =>
    editableMessage({ id: id.repeat(64), authorId: viewer, mentions });
  h.setRows([own("1", [first.pubkey])]);
  expect(h.input()).toHaveValue("@Honey ");
  // A later message tagging an unknown key waits for its profile.
  h.setRows([own("1", [first.pubkey]), own("2", [second.pubkey])]);
  expect(h.input()).toHaveValue("@Honey ");
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Honey", isAgent: true }],
      [second.pubkey, { name: "Pat" }],
    ]),
  );
  expect(h.input()).toHaveValue("");
  expect(viewRevision("scope", "draft:channel")).toBeNull();
});

it("completes a seed taken from partial agent evidence as the other agents' names arrive", () => {
  const viewer = "e".repeat(64);
  const h = mount({}, undefined, viewer);
  h.setProfiles(new Map([[first.pubkey, { name: "Honey", isAgent: true }]]));
  h.setRows([
    editableMessage({
      id: "1".repeat(64),
      authorId: viewer,
      mentions: [first.pubkey, second.pubkey],
    }),
  ]);
  expect(h.input()).toHaveValue("@Honey ");
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Honey", isAgent: true }],
      [second.pubkey, { name: "Bea", isAgent: true }],
    ]),
  );
  expect(h.input()).toHaveValue("@Honey @Bea ");
  // Settled evidence seeds once: the user's edit is kept afterwards.
  h.fill("@Honey @Bea hi");
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Honey", isAgent: true }],
      [second.pubkey, { name: "Bea", isAgent: true }],
    ]),
  );
  expect(h.input()).toHaveValue("@Honey @Bea hi");
});

it("keeps a partial-evidence seed the user cleared, and seeds from a newer message", () => {
  const viewer = "e".repeat(64);
  const h = mount({}, undefined, viewer);
  const both = new Map<string, Profile>([
    [first.pubkey, { name: "Honey", isAgent: true }],
    [second.pubkey, { name: "Bea", isAgent: true }],
  ]);
  h.setProfiles(new Map([[first.pubkey, { name: "Honey", isAgent: true }]]));
  const sent = editableMessage({
    id: "1".repeat(64),
    authorId: viewer,
    mentions: [first.pubkey, second.pubkey],
  });
  h.setRows([sent]);
  expect(h.input()).toHaveValue("@Honey ");
  // One edit to empty (Select All → Delete) settles this message's seed.
  h.fill("");
  expect(h.input()).toHaveValue("");
  h.setProfiles(both);
  expect(h.input()).toHaveValue("");
  // A newer message of the viewer's, sent from another device, still seeds.
  h.setRows([
    sent,
    editableMessage({
      id: "2".repeat(64),
      authorId: viewer,
      mentions: [second.pubkey],
    }),
  ]);
  expect(h.input()).toHaveValue("@Bea ");
});

it("seeds over the follow-up a send leaves once a newer message of the viewer's lands", () => {
  const viewer = "e".repeat(64);
  const h = mount({}, undefined, viewer);
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Honey", isAgent: true }],
      [second.pubkey, { name: "Bea", isAgent: true }],
    ]),
  );
  const own = (id: string, mentions: readonly string[]) =>
    editableMessage({ id: id.repeat(64), authorId: viewer, mentions });
  h.setRows([own("1", [first.pubkey])]);
  expect(h.input()).toHaveValue("@Honey ");
  // Typing closes seeding for this showing, including for a message of the
  // viewer's that lands from another device meanwhile.
  act(() => {
    h.input().setSelectionRange(7, 7);
    h.commands().insertText("hello");
  });
  expect(h.input()).toHaveValue("@Honey hello");
  h.setRows([own("1", [first.pubkey]), own("2", [second.pubkey])]);
  expect(h.input()).toHaveValue("@Honey hello");
  // The send replaces the typed draft with the composer's own follow-up,
  // which holds over that message until the sent one lands.
  h.submit();
  expect(h.messages.send.mock.calls[0]?.[2]).toEqual([first.pubkey]);
  expect(h.input()).toHaveValue("@Honey ");
  h.setRows([
    own("1", [first.pubkey]),
    own("2", [second.pubkey]),
    own("3", [first.pubkey]),
  ]);
  expect(h.input()).toHaveValue("@Honey ");
  // A newer message of the viewer's, sent elsewhere, seeds over that follow-up.
  h.setRows([
    own("1", [first.pubkey]),
    own("2", [second.pubkey]),
    own("3", [first.pubkey]),
    own("4", [second.pubkey]),
  ]);
  expect(h.input()).toHaveValue("@Bea ");
  expect(readView("scope", "draft:channel", "")).toEqual(emptied);
});

it("seeds from history over a follow-up an earlier release saved as the draft, until the first save replaces it", () => {
  const viewer = "e".repeat(64);
  const legacy = followupDraft([{ pubkey: first.pubkey, name: "Honey" }]);
  writeView("scope", "draft:channel", legacy);
  const h = mount({}, undefined, viewer);
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Honey", isAgent: true }],
      [second.pubkey, { name: "Bea", isAgent: true }],
    ]),
  );
  const own = (id: string, mentions: readonly string[]) =>
    editableMessage({ id: id.repeat(64), authorId: viewer, mentions });
  // The chain ended on another device: the saved follow-up is not restored.
  h.setRows([own("1", [])]);
  expect(h.input()).toHaveValue("");
  h.setRows([own("1", []), own("2", [second.pubkey])]);
  expect(h.input()).toHaveValue("@Bea ");
  expect(readView("scope", "draft:channel", "")).toEqual(legacy);
  act(() => {
    h.input().setSelectionRange(5, 5);
    h.commands().insertText("hello");
  });
  expect(h.input()).toHaveValue("@Bea hello");
  expect(readView("scope", "draft:channel", "")).toMatchObject({
    text: "@Bea hello",
    recipients: [{ pubkey: second.pubkey, name: "Bea", start: 0, end: 4 }],
  });
  // A tag the user typed, saved with its editor snapshot, is their draft.
  h.unmount();
  writeView("scope", "draft:channel", typedDraft(legacy));
  const typed = mount({}, undefined, viewer);
  typed.setProfiles(
    new Map([
      [first.pubkey, { name: "Honey", isAgent: true }],
      [second.pubkey, { name: "Bea", isAgent: true }],
    ]),
  );
  typed.setRows([own("1", []), own("2", [second.pubkey])]);
  expect(typed.input()).toHaveValue("@Honey ");
});

it("does not seed a channel composer until its window is ready", () => {
  const viewer = "e".repeat(64);
  const h = mount({}, undefined, viewer);
  h.setProfiles(new Map([[first.pubkey, { name: "Honey", isAgent: true }]]));
  const rows = [
    editableMessage({
      id: "1".repeat(64),
      authorId: viewer,
      mentions: [first.pubkey],
    }),
  ];
  const withStatus = (status: "loading" | "ready") =>
    h.retarget({
      session: {
        ...h.session,
        channels: {
          ...h.session.channels,
          window: () => ({ status, rows }),
        },
      } as unknown as RelaySession,
    });
  withStatus("loading");
  expect(h.input()).toHaveValue("");
  withStatus("ready");
  expect(h.input()).toHaveValue("@Honey ");
});

const honeyAgent: ReadonlyMap<string, Profile> = new Map([
  [first.pubkey, { name: "Honey", isAgent: true }],
]);
const removeHoney = () =>
  fireEvent.click(
    screen.getByRole("button", {
      name: `Remove mention Honey ${first.pubkey}`,
    }),
  );

it("seeds an untouched thread composer from the viewer's latest message without saving", () => {
  const stored = localStorage.length;
  const h = mount({
    threadRootId: "root",
    threadSeed: editableMessage({ mentions: [first.pubkey, second.pubkey] }),
  });
  h.setProfiles(
    new Map<string, Profile>([...honeyAgent, [second.pubkey, { name: "Pat" }]]),
  );
  expect(h.input()).toHaveValue("@Honey ");
  const recipients = screen.getByRole("region", { name: "Explicit mentions" });
  expect(within(recipients).getAllByRole("button")).toHaveLength(1);
  expect(
    within(recipients).getByRole("button", {
      name: `Remove mention Honey ${first.pubkey}`,
    }),
  ).toBeVisible();
  expect(viewRevision("scope", "draft:channel:thread:root")).toBeNull();
  expect(localStorage.length).toBe(stored);
  const editor = h.input();
  act(() => {
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
    h.commands().insertText("hi");
  });
  expect(h.input()).toHaveValue("@Honey hi");
  expect(readView("scope", "draft:channel:thread:root", "")).toMatchObject({
    text: "@Honey hi",
    recipients: [{ pubkey: first.pubkey, name: "Honey", start: 0, end: 6 }],
  });
});

it("removing the seeded mention saves an untagged draft so reopening the thread does not reseed", () => {
  const threadSeed = editableMessage({ mentions: [first.pubkey] });
  const h = mount({ threadRootId: "root", threadSeed });
  h.setProfiles(honeyAgent);
  expect(h.input()).toHaveValue("@Honey ");
  // Removing the chip leaves its plain text; the saved draft is what sticks.
  removeHoney();
  expect(h.input()).toHaveValue("@Honey ");
  expect(screen.queryByRole("button", { name: /^Remove mention/ })).toBeNull();
  expect(readView("scope", "draft:channel:thread:root", "")).toMatchObject({
    text: "@Honey ",
    recipients: [],
  });
  h.retarget({ threadRootId: "other", threadSeed: undefined });
  h.retarget({ threadRootId: "root", threadSeed });
  expect(h.input()).toHaveValue("@Honey ");
  expect(screen.queryByRole("button", { name: /^Remove mention/ })).toBeNull();
});

it("keeps a saved thread draft over the viewer's latest mentions", () => {
  writeView("scope", "draft:channel:thread:root", "Already typed");
  const h = mount({
    threadRootId: "root",
    threadSeed: editableMessage({ mentions: [first.pubkey] }),
  });
  h.setProfiles(honeyAgent);
  expect(h.input()).toHaveValue("Already typed");
  expect(screen.queryByRole("button", { name: /^Remove mention/ })).toBeNull();
});

it("does not seed a thread when Remember mentioned agents is off", () => {
  setRememberAgentsPreference(false);
  try {
    const h = mount({
      threadRootId: "root",
      threadSeed: editableMessage({ mentions: [first.pubkey] }),
    });
    h.setProfiles(honeyAgent);
    expect(h.input()).toHaveValue("");
  } finally {
    setRememberAgentsPreference(true);
  }
});

it("seeds from the viewer's latest reply when no draft is saved", () => {
  const h = mount({
    threadRootId: "root",
    threadSeed: editableMessage({
      id: "r2",
      threadRootId: "root",
      mentions: [first.pubkey],
    }),
  });
  h.setProfiles(honeyAgent);
  expect(h.input()).toHaveValue("@Honey ");
  expect(viewRevision("scope", "draft:channel:thread:root")).toBeNull();
});

it("does not seed when the viewer's latest message tagged no agent", () => {
  const h = mount({
    threadRootId: "root",
    threadSeed: editableMessage({ id: "r2", threadRootId: "root" }),
  });
  h.setProfiles(honeyAgent);
  expect(h.input()).toHaveValue("");
  expect(screen.queryByRole("button", { name: /^Remove mention/ })).toBeNull();
});

it("seeds when the thread finishes loading after the composer mounted", () => {
  const h = mount({ threadRootId: "root" });
  h.setProfiles(honeyAgent);
  expect(h.input()).toHaveValue("");
  h.retarget({ threadSeed: editableMessage({ mentions: [first.pubkey] }) });
  expect(h.input()).toHaveValue("@Honey ");
  expect(viewRevision("scope", "draft:channel:thread:root")).toBeNull();
});

it("seeds when the profiles arrive after the thread loaded into a mounted composer", async () => {
  // The profile subscription goes live with `threadSeed`, not at mount.
  const h = mount({ threadRootId: "root" });
  h.retarget({ threadSeed: editableMessage({ mentions: [first.pubkey] }) });
  expect(h.input()).toHaveValue("");
  h.setProfiles(honeyAgent);
  await waitFor(() => expect(h.input()).toHaveValue("@Honey "));
  expect(viewRevision("scope", "draft:channel:thread:root")).toBeNull();
});

it("keeps a partial-evidence thread seed the user cleared as the names arrive", () => {
  const h = mount({
    threadRootId: "root",
    threadSeed: editableMessage({ mentions: [first.pubkey, second.pubkey] }),
  });
  h.setProfiles(honeyAgent);
  expect(h.input()).toHaveValue("@Honey ");
  h.fill("");
  expect(h.input()).toHaveValue("");
  h.setProfiles(
    new Map<string, Profile>([
      ...honeyAgent,
      [second.pubkey, { name: "Bea", isAgent: true }],
    ]),
  );
  expect(h.input()).toHaveValue("");
});

it("does not seed a thread whose message notified only people", () => {
  const h = mount({
    threadRootId: "root",
    threadSeed: editableMessage({ mentions: [second.pubkey] }),
  });
  h.setProfiles(new Map([[second.pubkey, { name: "Pat" }]]));
  expect(h.input()).toHaveValue("");
  expect(screen.queryByRole("button", { name: /^Remove mention/ })).toBeNull();
});

it("seeds once the agent inventory classifies the agent, and never after the composer is touched", async () => {
  const h = mount({
    threadRootId: "root",
    threadSeed: editableMessage({ mentions: [first.pubkey] }),
  });
  h.setLibrary([], "idle");
  h.setProfiles(new Map([[first.pubkey, { name: "Honey" }]]));
  expect(h.input()).toHaveValue("");
  h.setLibrary([{ pubkey: first.pubkey, name: "Honey" }]);
  await waitFor(() => expect(h.input()).toHaveValue("@Honey "));
  expect(viewRevision("scope", "draft:channel:thread:root")).toBeNull();
  removeHoney();
  expect(screen.queryByRole("button", { name: /^Remove mention/ })).toBeNull();
  h.setLibrary([], "idle");
  h.setLibrary([{ pubkey: first.pubkey, name: "Honey" }]);
  expect(h.input()).toHaveValue("@Honey ");
  expect(screen.queryByRole("button", { name: /^Remove mention/ })).toBeNull();
});

it("opt-out changes future prefills, not the current draft, and re-enable revives nothing", () => {
  const h = mount();
  vi.spyOn(h.session.profiles, "snapshot").mockReturnValue(
    new Map([[second.pubkey, { name: "Honey", isAgent: true }]]),
  );
  act(() => {
    h.commands().insertMention(second);
  });
  h.submit();
  expect(h.input()).toHaveValue("@Honey ");
  setRememberAgentsPreference(false);
  expect(h.input()).toHaveValue("@Honey ");
  h.submit();
  expect(h.messages.send.mock.calls.at(-1)?.[2]).toEqual([second.pubkey]);
  expect(h.input()).toHaveValue("");
  setRememberAgentsPreference(true);
  expect(h.input()).toHaveValue("");
});

function mountBerdDraft(defaultMention?: { pubkey: string; name: string }) {
  const submit = vi.fn();
  const h = mount({
    submission: {
      draftKey: "new-chat",
      locked: false,
      disabled: false,
      submit,
    },
    ownSoloConversation: true,
    soloConversation: true,
    requireMention: true,
    ...(defaultMention ? { defaultMention } : {}),
  });
  h.setLibrary([
    { pubkey: first.pubkey, name: "Explicit" },
    { pubkey: second.pubkey, name: "Selected" },
  ]);
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Explicit", isAgent: true }],
      [second.pubkey, { name: "Selected", isAgent: true }],
    ]),
  );
  // A Solo chat: personal sends are admitted while its label holds.
  Object.assign(h.session, {
    channels: {
      ...h.session.channels,
      list: () => soloList,
    },
  });
  return { h, submit };
}

it("seeds a Berd draft's pill with the default agent once, never its text", async () => {
  const { h, submit } = mountBerdDraft({
    pubkey: second.pubkey,
    name: "Selected",
  });
  // The default agent arrives in the pill; the draft text stays empty.
  expect(
    await screen.findByRole("status", {
      name: "Sending to Selected. Change agents",
    }),
  ).toBeInTheDocument();
  expect(h.input()).toHaveValue("");
  expect(h.commands().recipients).toEqual([]);
  // Typing and clearing leaves it alone: it was seeded once and stays held.
  h.fill("hello");
  h.fill("");
  expect(h.input()).toHaveValue("");
  expect(
    screen.getByRole("status", { name: "Sending to Selected. Change agents" }),
  ).toBeInTheDocument();
  h.fill("hello");
  h.submit();
  expect(submit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ text: "hello", recipients: [] }),
    expect.objectContaining({ prepareForSend: expect.any(Function) }),
    [{ pubkey: second.pubkey, name: "Selected" }],
    {},
    {},
    null,
  );
});

it("a Berd draft with nobody addressed needs a tag to send", async () => {
  const { h, submit } = mountBerdDraft();
  const send = screen.getByRole("button", { name: "Send message" });
  // Nothing seeds the pill, and Enter explains even an empty draft.
  expect(h.input()).toHaveValue("");
  fireEvent.keyDown(h.input(), { key: "Enter" });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Choose an agent to send",
  );
  h.fill("no agent here");
  expect(h.input()).toHaveValue("no agent here");
  // Enter and native form submission obey the same rule, not just the button.
  fireEvent.keyDown(h.input(), { key: "Enter" });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Choose an agent to send",
  );
  h.submit();
  expect(submit).not.toHaveBeenCalled();
  expect(h.input()).toHaveValue("no agent here");
  // Still focusable, so its tooltip explains why.
  expect(send).toHaveAttribute("aria-disabled", "true");
  await userEvent.hover(send);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Choose an agent to send",
  );
  await userEvent.unhover(send);
  // An inline mention addresses the agent and enables sending.
  act(() => {
    h.commands().insertMention(first);
  });
  expect(send).not.toHaveAttribute("aria-disabled");
  // Picking an agent in the pill does too, once the mention is gone.
  h.fill("no agent here");
  expect(send).toHaveAttribute("aria-disabled", "true");
  act(() => h.commands().audience?.only([second]));
  expect(send).not.toHaveAttribute("aria-disabled");
});

const pillSendingTo = (names: string) =>
  screen.getByRole("status", { name: `Sending to ${names}. Change agents` });

function mountNewSoloChat(name: string, pubkey: string) {
  const h = mount({
    submission: {
      draftKey: "new-chat",
      locked: false,
      disabled: false,
      submit: vi.fn(),
    },
    ownSoloConversation: true,
    soloConversation: true,
    requireMention: true,
    defaultMention: { pubkey, name },
  });
  h.setLibrary([
    { pubkey: first.pubkey, name: "Cached" },
    { pubkey: second.pubkey, name: "Saved" },
  ]);
  Object.assign(h.session, {
    channels: { ...h.session.channels, list: () => soloList },
  });
  return h;
}

it("puts the default agent in a new chat's pill, never the text or a saved draft", async () => {
  const h = mountNewSoloChat("Cached", first.pubkey);
  await waitFor(() => expect(pillSendingTo("Cached")).toBeInTheDocument());
  expect(h.input()).toHaveValue("");
  expect(readView("scope", "new-chat", null)).toBeNull();
  // A new default doesn't swap the pill on screen.
  h.retarget({ defaultMention: { pubkey: second.pubkey, name: "Saved" } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(pillSendingTo("Cached")).toBeInTheDocument();
  // Shown again untouched, it holds the current default.
  h.retarget({ shown: false });
  h.retarget({ shown: true });
  await waitFor(() => expect(pillSendingTo("Saved")).toBeInTheDocument());
  expect(readView("scope", "new-chat", null)).toBeNull();
});

it("keeps an agent the viewer picked in a new chat's pill across showing again, but a new mount starts from the main agent", async () => {
  const h = mountNewSoloChat("Cached", first.pubkey);
  await waitFor(() => expect(pillSendingTo("Cached")).toBeInTheDocument());
  act(() =>
    h.commands().audience?.only([{ pubkey: second.pubkey, name: "Saved" }]),
  );
  h.retarget({ defaultMention: { pubkey: first.pubkey, name: "Cached" } });
  h.retarget({ shown: false });
  h.retarget({ shown: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(pillSendingTo("Saved")).toBeInTheDocument();
  expect(h.input()).toHaveValue("");
  h.unmount();
  mountNewSoloChat("Cached", first.pubkey);
  await waitFor(() => expect(pillSendingTo("Cached")).toBeInTheDocument());
});

it("an untouched new chat's pill holds the current default after a remount", async () => {
  const before = mountNewSoloChat("Cached", first.pubkey);
  await waitFor(() => expect(pillSendingTo("Cached")).toBeInTheDocument());
  // The viewer leaves before the account's main agent arrives.
  before.unmount();
  mountNewSoloChat("Saved", second.pubkey);
  await waitFor(() => expect(pillSendingTo("Saved")).toBeInTheDocument());
});

it.each([
  {},
  { threadRootId: "thread" },
  { threadRootId: "thread", mediaTimeSeconds: 12 },
])(
  "disables nonmember channel/thread/media composers and follows membership changes: %j",
  (destination) => {
    const h = mount(destination);
    const rows: readonly never[] = [];
    const listeners = new Set<() => void>();
    let list: ReturnType<RelaySession["channels"]["list"]> = {
      status: "ready",
      channels: [],
    };
    h.retarget({
      session: {
        ...h.session,
        channels: {
          window: () => ({
            channelId: "channel",
            status: "idle",
            rows,
            hasMore: true,
            loadingOlder: false,
            error: undefined,
          }),
          subscribeWindow: () => () => {},
          ensureList() {},
          ensure() {},
          loadOlder() {},
          list: () => list,
          get: () => ({ id: "channel", name: "Public", readOnly: true }),
          subscribeList: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        } as RelaySession["channels"],
      },
    });
    expect(h.input()).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(h.input(), { key: "Enter" });
    expect(h.messages.send).not.toHaveBeenCalled();
    expect(h.messages.reply).not.toHaveBeenCalled();
    act(() => {
      list = { status: "ready", channels: [{ id: "channel", name: "Joined" }] };
      for (const listener of listeners) listener();
    });
    expect(h.input()).not.toHaveAttribute("aria-disabled", "true");
    act(() => {
      list = { status: "ready", channels: [] };
      for (const listener of listeners) listener();
    });
    expect(h.input()).toHaveAttribute("aria-disabled", "true");
  },
);

it("keeps inline recipient identity and source stable through directory collision changes", async () => {
  const h = mount();
  const listeners = new Set<() => void>();
  let identities = [first, second];
  const provider = createAgentDirectory();
  const names = bindNames(
    {
      profiles: h.session.profiles,
      agentLibrary: {
        snapshot: () => ({ status: "ready", definitions: [], identities }),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        refresh: async () => {},
        retain: () => () => {},
      },
    },
    { snapshot: () => [provider], subscribe: () => () => {} },
  );
  h.retarget({ session: { ...h.session, names } });
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  await h.user.click(screen.getByRole("button", { name: "Second Honey" }));
  const chips = () => within(h.input()).getAllByRole("img");
  const labels = () => chips().map((chip) => chip.textContent);
  expect(labels()).toEqual(["@Honey · rcaj", "@Honey · 04hu"]);
  const source = h.input().value;
  act(() => {
    identities = [first, { ...second, name: "Renamed Honey" }];
    for (const notify of listeners) notify();
  });
  // Labels follow live facts; authored source and recipients do not change.
  expect(names.resolve(second.pubkey)).toBe("Renamed Honey");
  expect(labels()).toEqual(["@Honey", "@Renamed Honey"]);
  expect(h.input()).toHaveValue(source);
  act(() => {
    identities = [first, second];
    for (const notify of listeners) notify();
  });
  expect(names.lookup(first.pubkey)?.qualifier).toBeTruthy();
  expect(labels()).toEqual(["@Honey · rcaj", "@Honey · 04hu"]);
  h.input().setSelectionRange(7, 13);
  act(() => h.commands().insertText(""));
  // Removing a selected chip does not remove the other channel member from naming scope.
  expect(labels()).toEqual(["@Honey · rcaj"]);
  h.submit();
  expect(h.messages.send.mock.calls[0]?.[2]).toEqual([first.pubkey]);
  h.unmount();
  names.dispose();
});

it.each([false, true])(
  "asks before mentioning a removed person in an untyped channel without enrolling anyone (mixed native=%s)",
  async (mixed) => {
    const viewer = keypair(),
      relay = keypair();
    const scope = `https://relay.example.test:${viewer.pubkey}`;
    const native = localAgentsFixture([
      { ...localAgent, pubkey: second.pubkey, owner: viewer.pubkey },
    ]);
    let members = [viewer.pubkey, first.pubkey];
    let time = 1700000000;
    const sign = vi.fn(async (template: EventTemplate) =>
      signed(viewer, template),
    );
    const publish = vi.fn(async () => {});
    const readLibrary = vi.fn(async () => ({
      definitions: [],
      identities: [],
    }));
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        scope: "https://relay.example.test",
        media: () => undefined,
        query: async (filters) =>
          filters.flatMap((filter) =>
            filter.kinds?.includes(39002)
              ? [roster(relay, "channel", members, time)]
              : filter.kinds?.includes(39000)
                ? [metadata(relay, "channel", "General")]
                : [],
          ),
        readAgentLibrary: readLibrary,
        writer: { kinds: [9, 9000], sign, publish },
      },
      { outboxStorage: { load: () => [], save() {} }, agentChoices: native },
    );
    const refresh = () =>
      owner.session.read(
        [
          { kinds: [39002], "#d": ["channel"], limit: 1 },
          { kinds: [39000], "#d": ["channel"], limit: 1 },
        ],
        { fresh: true },
      );
    await refresh();
    const h = mount({ session: owner.session, scope }, native);
    try {
      fireEvent.click(screen.getByRole("button", { name: "First Honey" }));
      if (mixed)
        fireEvent.click(screen.getByRole("button", { name: "Second Honey" }));
      const draft = h.input().value;
      members = [viewer.pubkey];
      time++;
      await act(refresh);
      // An untyped channel is an ordinary channel: a removed recipient is now
      // outside it, so the sender chooses. Nothing enrolls or sends meanwhile.
      h.submit();
      expect(screen.getByRole("dialog")).toHaveTextContent(
        mixed
          ? "Honey, Honey are not in this channel."
          : "Honey is not in this channel.",
      );
      await userEvent.setup().keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(h.input()).toHaveValue(draft);
      expect(sign).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(readLibrary).not.toHaveBeenCalled();
    } finally {
      h.unmount();
      owner.dispose();
    }
  },
);

it("retargets within a thread without losing its draft and sends the selected parent", () => {
  const h = mount({ threadRootId: "root" });
  h.fill("keep this draft");
  const input = h.input();
  h.retarget({ threadRootId: "root", replyParentId: "parent" });
  expect(h.input()).toBe(input);
  expect(h.input()).toHaveValue("keep this draft");
  fireEvent.keyDown(h.input(), { key: "Enter" });
  expect(h.messages.reply).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "root",
    "keep this draft",
    [],
    [],
    "parent",
  );
});

it("toggles the whole draft spoiler with a collapsed caret and preserves selection/history", () => {
  const h = mount();
  h.fill("secret");
  act(() => h.input().toggleFormat("spoiler"));
  expect(h.input().querySelector("[data-spoiler]")).toHaveTextContent("secret");
  expect(h.input().selectionStart).toBe(6);
  expect(h.input().selectionEnd).toBe(6);
  act(() => h.input().undo(false));
  expect(h.input().querySelector("[data-spoiler]")).toBeNull();
  act(() => h.input().undo(true));
  h.submit();
  expect(h.messages.send).toHaveBeenCalledWith("channel", "||secret||", [], []);
});

const editableMessage = (
  overrides: Partial<ChannelMessage> = {},
): ChannelMessage => ({
  id: "c".repeat(64),
  channelId: "channel",
  authorId: first.pubkey,
  createdAt: 10,
  content: "Original message",
  replyCount: 0,
  participants: [],
  mentions: [],
  attachments: [],
  reactions: [],
  ...overrides,
});

it("edits in the same composer, cancels without persisting edit text, and restores draft undo history", () => {
  const h = mount({}, undefined, first.pubkey);
  h.setRows([editableMessage()]);
  h.fill("Unsent draft");
  h.fill("");
  const input = h.input();
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(h.input()).toBe(input);
  expect(input).toHaveAccessibleName("Edit message");
  expect(input).toHaveValue("Original message");
  h.fill("Temporary edit");
  expect(readView("scope", "draft:channel", null)).toMatchObject({ text: "" });
  fireEvent.keyDown(input, { key: "Escape", keyCode: 27 });
  expect(input).toHaveValue("");
  expect(input).toHaveFocus();
  fireEvent.keyDown(input, { key: "z", ctrlKey: true });
  expect(input).toHaveValue("Unsent draft");
  expect(h.messages.edit).not.toHaveBeenCalled();
});

it("selects the newest message on Up when the scope has a message list, instead of editing", () => {
  const base = mount({}, undefined, first.pubkey);
  base.unmount();
  const row = editableMessage();
  let scope: ReturnType<typeof useMessageEditScope>;
  function Probe() {
    scope = useMessageEditScope();
    return null;
  }
  const list = document.createElement("ol");
  list.innerHTML =
    '<li data-message-id="older"><div data-layout="timeline">Older</div></li>' +
    '<li data-message-id="newest"><div data-layout="timeline">Newest</div></li>';
  document.body.append(list);
  const unregister = registerMessageList(list, {
    row: (id) => ({ id }) as ChannelMessage,
    newest: () => "newest",
    canEdit: () => false,
    edit: () => {},
    canDelete: () => false,
    remove: () => {},
    canMarkUnread: () => false,
    markUnread: () => {},
    composer: () => null,
  });
  try {
    render(
      <MessageEditScope>
        <Probe />
        <MessageComposer
          session={base.session}
          scope="scope"
          channelId="channel"
          channelName="General"
          editMessages={[row]}
        />
      </MessageEditScope>,
      { wrapper: ToastProvider },
    );
    if (scope) scope.list.current = list;
    const input = screen.getByRole("textbox");
    act(() => input.focus());
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(
      list.querySelector('[data-message-id="newest"] > div'),
    ).toHaveFocus();
    expect(input).not.toHaveAccessibleName("Edit message");
    // Without a connected list, Up keeps editing the last own message.
    list.remove();
    act(() => input.focus());
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAccessibleName("Edit message");
  } finally {
    unregister();
    list.remove();
  }
});

it.each(["cancel", "accepted"])(
  "restores rich draft history and mention provenance after an edit is %s",
  (finish) => {
    const h = mount({}, undefined, first.pubkey);
    h.setRows([editableMessage()]);
    act(() => h.commands().insertMention(second));
    act(() => {
      h.input().setSelectionRange(0, 6);
      h.input().toggleFormat("bold");
    });
    const formatted = h.input().innerHTML;
    h.fill("");
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    // The temporary editor must not inherit the unsent draft's undo stack.
    act(() => h.input().undo(false));
    expect(h.input()).toHaveValue("Original message");
    h.fill("Temporary edit");
    if (finish === "cancel") fireEvent.keyDown(h.input(), { key: "Escape" });
    else {
      h.submit();
      h.setDelivery("accepted");
    }
    act(() => h.input().undo(false));
    expect(h.input().innerHTML).toBe(formatted);
    expect(
      screen.getByRole("region", { name: "Explicit mentions" }),
    ).toBeVisible();
    h.submit();
    expect(h.messages.send).toHaveBeenCalledWith(
      "channel",
      "**@Honey** ",
      [second.pubkey],
      [],
    );
  },
);

it.each([
  ["bold", "**Revised**"],
  ["spoiler", "||Revised||"],
  ["code", "`Revised`"],
  ["bullet_list", "- Revised"],
] as const)(
  "serializes %s formatting when saving an edit",
  (format, markdown) => {
    const h = mount({}, undefined, first.pubkey);
    h.setRows([editableMessage()]);
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    h.fill("Revised");
    act(() => {
      h.input().setSelectionRange(0, 7);
      h.input().toggleFormat(format);
    });
    h.submit();
    expect(h.messages.edit).toHaveBeenCalledExactlyOnceWith(
      "c".repeat(64),
      markdown,
      "c".repeat(64),
    );
    expect(h.messages.send).not.toHaveBeenCalled();
    expect(readView("scope", "draft:channel", "")).toBe("");
  },
);

it("continues a list while editing and saves through Save changes", async () => {
  const h = mount({}, undefined, first.pubkey);
  h.setRows([editableMessage()]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  h.fill("Revised");
  act(() => {
    h.input().setSelectionRange(7, 7);
    h.input().toggleFormat("bullet_list");
  });
  await h.user.keyboard("{Enter}Added");
  expect(h.input().querySelectorAll("ul > li")).toHaveLength(2);
  expect(h.messages.edit).not.toHaveBeenCalled();
  await h.user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(h.messages.edit).toHaveBeenCalledExactlyOnceWith(
    "c".repeat(64),
    "- Revised\n- Added",
    "c".repeat(64),
  );
});

it.each(["bullet_list", "ordered_list", "code_block"] as const)(
  "does not save a whitespace-only %s edit through Enter",
  (format) => {
    const h = mount({}, undefined, first.pubkey);
    h.setRows([editableMessage()]);
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    h.fill(" ");
    act(() => h.input().toggleFormat(format));
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.keyDown(h.input(), { key: "Enter", keyCode: 13 });
    expect(h.messages.edit).not.toHaveBeenCalled();
    expect(screen.getByText("Editing message")).toBeVisible();
  },
);

it("saves an edited fenced message on Enter instead of opening a block from its closing fence", () => {
  const h = mount({}, undefined, first.pubkey);
  h.setRows([editableMessage({ content: "```js\ncode\n```" })]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).toHaveValue("```js\ncode\n```");
  act(() => {
    h.input().setSelectionRange(10, 10);
    h.input().insertText("!");
    const end = h.input().value.length;
    h.input().setSelectionRange(end, end);
  });
  fireEvent.keyDown(h.input(), { key: "Enter", keyCode: 13 });
  expect(h.input().querySelector("pre")).toBeNull();
  expect(h.messages.edit).toHaveBeenCalledExactlyOnceWith(
    "c".repeat(64),
    "```js\ncode!\n```",
    "c".repeat(64),
  );
  expect(h.messages.send).not.toHaveBeenCalled();
});

it("saves only once, locks until delivery, and restores the new-message composer on acceptance", () => {
  const h = mount({}, undefined, first.pubkey);
  const row = editableMessage();
  h.setRows([row]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  h.fill("Revised message");
  act(() => {
    h.submit();
    h.submit();
  });
  expect(h.messages.edit).toHaveBeenCalledExactlyOnceWith(
    row.id,
    "Revised message",
    row.id,
  );
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(h.input()).toHaveAttribute("contenteditable", "false");
  expect(screen.getByRole("button", { name: "Close edit" })).toBeDisabled();
  h.setDelivery("accepted");
  expect(screen.queryByText("Editing message")).not.toBeInTheDocument();
  expect(h.input()).toHaveValue("");
  expect(h.input()).toHaveFocus();
  expect(h.onSend).not.toHaveBeenCalled();
});

it.each(["failed", "unknown"] as const)(
  "keeps a %s edit and retries the same operation, not a new message",
  (delivery) => {
    const h = mount({}, undefined, first.pubkey);
    h.setRows([editableMessage()]);
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    h.fill("Revised");
    h.submit();
    h.setDelivery(delivery);
    expect(h.input()).toHaveValue("Revised");
    expect(h.input()).toHaveAttribute("contenteditable", "false");
    fireEvent.click(screen.getByRole("button", { name: "Retry edit" }));
    expect(h.session.outbox?.retry).toHaveBeenCalledExactlyOnceWith("edit-id");
    expect(h.messages.edit).toHaveBeenCalledTimes(1);
    h.setDelivery("seen");
    expect(h.input()).toHaveValue("");
  },
);

it.each(["changed", "deleted"])(
  "preserves text and refuses to overwrite a %s target",
  (state) => {
    const h = mount({}, undefined, first.pubkey);
    const row = editableMessage();
    h.setRows([row]);
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    h.fill("My changes");
    h.setRows(
      state === "deleted"
        ? []
        : [{ ...row, content: "Another client edited this" }],
    );
    h.submit();
    expect(screen.getByRole("alert")).toHaveTextContent(
      state === "deleted"
        ? "no longer available"
        : "changed while you were editing",
    );
    expect(h.input()).toHaveValue("My changes");
    expect(h.messages.edit).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "does not publish blank or unchanged content and preserves attachment source (mention: %s)",
  (mention) => {
    const h = mount({}, undefined, first.pubkey);
    h.setProfiles(
      new Map([[second.pubkey, { id: second.pubkey, name: "Honey" }]]),
    );
    const caption = mention ? "@Honey Caption" : "Caption";
    const sourceContent = `${caption}\n\n[report.pdf](https://files.test/report.pdf)`;
    h.setRows([
      editableMessage({
        content: caption,
        sourceContent,
        mentions: mention ? [second.pubkey] : [],
      }),
    ]);
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    const seed = h.input().value;
    expect(seed).toBe(
      mention
        ? sourceContent.replace(
            "@Honey",
            `[@Honey](${profileTarget(second.pubkey)})`,
          )
        : sourceContent,
    );
    h.fill(" ");
    h.submit();
    expect(screen.getByText("Editing message")).toBeVisible();
    h.fill(seed);
    fireEvent.keyDown(h.input(), { key: "Enter", keyCode: 13 });
    expect(screen.queryByText("Editing message")).not.toBeInTheDocument();
    expect(h.input()).toHaveValue("");
    expect(h.messages.edit).not.toHaveBeenCalled();
    expect(h.messages.send).not.toHaveBeenCalled();
  },
);

it.each(["changed", "deleted"])(
  "keeps an unchanged mention edit open when the target is %s",
  (state) => {
    const h = mount({}, undefined, first.pubkey);
    h.setProfiles(
      new Map([[second.pubkey, { id: second.pubkey, name: "Honey" }]]),
    );
    const row = editableMessage({
      content: "@Honey hello",
      mentions: [second.pubkey],
    });
    h.setRows([row]);
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    const seed = h.input().value;
    h.setRows(
      state === "deleted"
        ? []
        : [{ ...row, content: "Another client edited this" }],
    );
    h.submit();
    expect(screen.getByRole("alert")).toHaveTextContent(
      state === "deleted"
        ? "no longer available"
        : "changed while you were editing",
    );
    expect(screen.getByText("Editing message")).toBeVisible();
    expect(h.input()).toHaveValue(seed);
    expect(h.messages.edit).not.toHaveBeenCalled();
  },
);

it.each([
  { shiftKey: true },
  { altKey: true },
  { ctrlKey: true },
  { metaKey: true, shiftKey: true },
  { metaKey: true, altKey: true },
  { metaKey: true, ctrlKey: true },
  { repeat: true },
  { isComposing: true },
  { keyCode: 229 },
])("does not take over modified/repeated/composing ArrowUp: %j", (keys) => {
  const h = mount({}, undefined, first.pubkey);
  h.setRows([editableMessage()]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp", ...keys });
  expect(h.input()).toHaveValue("");
  expect(screen.queryByText("Editing message")).not.toBeInTheDocument();
});

it("does not replace a nonempty draft and confines channel/thread targets to their owner", () => {
  const h = mount({}, undefined, first.pubkey);
  const channelRow = editableMessage();
  const reply = editableMessage({
    id: "d".repeat(64),
    content: "Thread reply",
    threadRootId: channelRow.id,
  });
  h.setRows([channelRow, reply]);
  h.fill("Draft");
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).toHaveValue("Draft");
  h.fill("");
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).toHaveValue(channelRow.content);
  h.retarget({
    threadRootId: channelRow.id,
    editMessages: [channelRow, reply],
  });
  expect(h.input()).toHaveValue("");
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).toHaveValue(reply.content);
  h.fill("Unsubmitted edit");
  h.retarget({ channelId: "other", threadRootId: "another", editMessages: [] });
  expect(h.input()).toHaveValue("");
  expect(h.messages.edit).not.toHaveBeenCalled();
});

it.each([false, true])(
  "renders preserved mention links as chips when editing (already edited: %s)",
  (edited) => {
    const h = mount({}, undefined, first.pubkey);
    h.setProfiles(
      new Map([[second.pubkey, { id: second.pubkey, name: "Honey" }]]),
    );
    const link = `[@Honey](${profileTarget(second.pubkey)})`;
    const content = `${edited ? link : "@Honey"} whats your name`;
    h.setRows([
      editableMessage({
        content,
        mentions: [second.pubkey],
        ...(edited ? { edited: true as const } : {}),
      }),
    ]);
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    expect(h.input()).toHaveTextContent("Honey whats your name");
    expect(h.input().textContent).not.toContain("nostr:");
    expect(h.input().value).toBe(`${link} whats your name`);
    expect(
      screen.queryByRole("region", { name: "Explicit mentions" }),
    ).not.toBeInTheDocument();
    act(() => h.commands().insertText("?"));
    h.submit();
    expect(h.messages.edit).toHaveBeenCalledWith(
      "c".repeat(64),
      `${link} whats your name?`,
      "c".repeat(64),
    );
    expect(h.messages.send).not.toHaveBeenCalled();
  },
);

it.each([
  (link: string) => `\`${link}\``,
  (link: string) => `\`\`\`\n${link}\n\`\`\``,
  () => "[@Honey](nostr:npub1invalid)",
  () => "@Honey without signed identity",
])("keeps literal or unbound edit text unchanged", (source) => {
  const h = mount({}, undefined, first.pubkey);
  const content = source(`[@Honey](${profileTarget(second.pubkey)})`);
  h.setRows([editableMessage({ content })]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input().textContent).toBe(content);
  expect(h.input().querySelector(".inline-chip")).toBeNull();
});

it("inserts readable literal mention links without new notification recipients during edits", () => {
  const h = mount({}, undefined, first.pubkey);
  h.setRows([editableMessage()]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  const target = profileTarget(second.pubkey);
  const names = [
    "Bee [x]",
    "A *B*",
    "A `B`",
    "A &amp; B",
    "Sam\n[Details](https://example.test/)",
  ];
  act(() => {
    h.commands().insertMention(second);
  });
  act(() => {
    h.commands().insertMentions(
      names.map((name, index) => ({ pubkey: `${index}`.repeat(64), name })),
    );
  });
  const labels = ["@Honey", ...names.map((name) => `@${name}`)].map((label) =>
    label.replace(/[\r\n]+/g, " "),
  );
  // Each selection stays one literal label on its own exact identity link.
  const readable = (body: string) => {
    expect(h.input().textContent).toBe(`Original message${labels.join(" ")} `);
    expect(h.input().querySelectorAll(".inline-chip")).toHaveLength(6);
    type Node = {
      type: string;
      url?: string;
      value?: string;
      children?: Node[];
    };
    const text = (node: Node): string =>
      node.value ?? node.children?.map(text).join("") ?? "";
    const links: { url: string | undefined; label: string }[] = [];
    const visit = (node: Node) => {
      if (node.type === "link")
        links.push({ url: node.url, label: text(node) });
      node.children?.forEach(visit);
    };
    visit(fromMarkdown(body));
    expect(links).toEqual([
      { url: target, label: "@Honey" },
      ...labels.slice(1).map((label, index) => ({
        url: profileTarget(`${index}`.repeat(64)),
        label,
      })),
    ]);
  };
  readable(h.input().value);
  expect(
    screen.queryByRole("region", { name: "Explicit mentions" }),
  ).not.toBeInTheDocument();
  h.submit();
  expect(h.messages.edit).toHaveBeenCalledOnce();
  const saved = h.messages.edit.mock.calls[0]?.[1] as string;
  expect(saved).toBe(h.input().value);
  expect(saved).not.toContain("\n");
  readable(saved);
  expect(h.messages.send).not.toHaveBeenCalled();
  // Reopening the saved edit keeps the same readable identity links.
  h.setRows([editableMessage({ content: saved, edited: true })]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input().value).toBe(saved);
  readable(saved);
});

const pasteText = (input: ComposerInputElement, text: string) =>
  act(() => {
    input.focus();
    fireEvent.paste(input, {
      clipboardData: {
        items: [],
        getData: (type: string) => (type === "text/plain" ? text : ""),
      },
    });
  });

it("notifies a pasted identity link for a member under their current name, not an unknown key", () => {
  const h = mount();
  h.setProfiles(new Map([[first.pubkey, { name: "Honey Bee" }]]));
  const eve = `[@Eve](${profileTarget("e".repeat(64))})`;
  pasteText(
    h.input(),
    `Ask [@Honey](${profileTarget(first.pubkey)}) and ${eve} `,
  );
  expect(h.input()).toHaveValue(`Ask @Honey Bee and ${eve} `);
  expect(
    within(
      screen.getByRole("region", { name: "Explicit mentions" }),
    ).getAllByRole("button"),
  ).toHaveLength(1);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    `Ask @Honey Bee and ${eve} `,
    [first.pubkey],
    [],
  );
});

for (const channelType of ["stream", "forum"] as const)
  it(`offers a pasted nonmember with a known profile like the picker in ${channelType}`, async () => {
    const h = mount();
    const list = {
      status: "ready",
      channels: [{ id: "channel", channelType, members: ["d".repeat(64)] }],
    };
    Object.assign(h.session, {
      viewer: "d".repeat(64),
      channels: { list: () => list, subscribeList: () => () => {} },
      memberAdditions: { add: vi.fn() },
    });
    h.setProfiles(new Map([[first.pubkey, { name: "Honey Bee" }]]));
    // The pasted label never names the recipient; an uncached key stays display-only.
    const eve = `[@Eve](${profileTarget("e".repeat(64))})`;
    pasteText(
      h.input(),
      `Ask [@Jane](${profileTarget(first.pubkey)}) and ${eve} `,
    );
    expect(h.input()).toHaveValue(`Ask @Honey Bee and ${eve} `);
    expect(
      within(
        screen.getByRole("region", { name: "Explicit mentions" }),
      ).getAllByRole("button"),
    ).toHaveLength(1);
    fireEvent.submit(screen.getByRole("form"));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Honey Bee is not in this channel. Invite them to the channel, or send without inviting them.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Do nothing" }));
    await act(async () => {});
    expect(h.messages.send).toHaveBeenCalledOnce();
    expect(h.messages.send.mock.calls[0]?.slice(0, 3)).toEqual([
      "channel",
      `Ask @Honey Bee and ${eve} `,
      [],
    ]);
    expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([first.pubkey]);
  });

it("keeps pasted identity links display-only during edits", () => {
  const h = mount({}, undefined, first.pubkey);
  h.setRows([editableMessage()]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  const link = `[@Honey](${profileTarget(second.pubkey)})`;
  pasteText(h.input(), ` ${link} `);
  expect(h.input()).toHaveValue(`Original message ${link} `);
  expect(
    screen.queryByRole("region", { name: "Explicit mentions" }),
  ).not.toBeInTheDocument();
  h.submit();
  expect(h.messages.edit).toHaveBeenCalledExactlyOnceWith(
    "c".repeat(64),
    `Original message ${link} `,
    "c".repeat(64),
  );
});

it.each([
  { authorId: second.pubkey },
  { agentEnvelope: true as const },
  { diff: { filePath: "a.ts", truncated: false } },
  {
    membership: {
      type: "member_joined" as const,
      actor: first.pubkey,
      target: second.pubkey,
    },
  },
  { delivery: "sending" as const },
  { delivery: "failed" as const },
  { delivery: "unknown" as const },
])("skips a newer ineligible row: %j", (overrides) => {
  const h = mount({}, undefined, first.pubkey);
  h.setRows([
    editableMessage(),
    editableMessage({
      ...overrides,
      id: "d".repeat(64),
      content: "Ineligible",
    }),
  ]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).toHaveValue("Original message");
});

it("does not start editing without a viewer or edit capability", () => {
  const h = mount();
  h.setRows([editableMessage()]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).toHaveValue("");
  const outbox = h.session.outbox;
  if (!outbox) throw new Error("Missing fixture outbox");
  h.retarget({
    session: {
      ...h.session,
      viewer: first.pubkey,
      outbox: { ...outbox, supports: (kind) => kind === 9 },
    },
  });
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).toHaveValue("");
});

it("does not reopen a target with an unresolved edit after closing it", () => {
  const h = mount({}, undefined, first.pubkey);
  h.setRows([editableMessage()]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  h.fill("Waiting for delivery");
  h.submit();
  h.setDelivery("unknown");
  fireEvent.click(screen.getByRole("button", { name: "Close edit" }));
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).toHaveValue("");
  expect(screen.queryByText("Editing message")).not.toBeInTheDocument();
});

it("keeps the draft but blocks new messages while archived, then re-enables it on restore", async () => {
  const h = mount();
  let channel: ChannelSummary = { id: "channel", name: "General" };
  let list = { status: "ready" as const, channels: [channel] };
  const listeners = new Set<() => void>();
  h.retarget({
    session: {
      ...h.session,
      channels: {
        ...h.session.channels,
        get: () => channel,
        list: () => list,
        subscribeList: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    },
  });
  h.fill("Draft survives archive");
  const archive = (archived: true | undefined) =>
    act(() => {
      channel = {
        id: "channel",
        name: "General",
        ...(archived ? { archived } : {}),
      };
      list = { ...list, channels: [channel] };
      for (const listener of listeners) listener();
    });
  archive(true);
  expect(h.input()).toHaveAttribute("aria-disabled", "true");
  expect(h.input()).toHaveValue("Draft survives archive");
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  h.submit();
  expect(h.messages.send).not.toHaveBeenCalled();
  archive(undefined);
  expect(h.input()).not.toHaveAttribute("aria-disabled", "true");
  expect(h.input()).toHaveValue("Draft survives archive");
  h.submit();
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
});

it.each(["archived", "readOnly"] as const)(
  "blocks edit entry and save when channel becomes %s",
  (flag) => {
    const h = mount({}, undefined, first.pubkey);
    h.setRows([editableMessage()]);
    let channel = {
      id: "channel",
      name: "General",
      members: [first.pubkey],
      [flag]: true,
    };
    let list = { status: "ready" as const, channels: [channel] };
    const listeners = new Set<() => void>();
    h.retarget({
      session: {
        ...h.session,
        channels: {
          ...h.session.channels,
          get: () => channel,
          list: () => list,
          subscribeList: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        },
      },
    });
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    expect(h.input()).toHaveValue("");
    act(() => {
      channel = { ...channel, [flag]: false };
      list = { ...list, channels: [channel] };
      for (const listener of listeners) listener();
    });
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    h.fill("Changes");
    act(() => {
      channel = { ...channel, [flag]: true };
      list = { ...list, channels: [channel] };
      for (const listener of listeners) listener();
    });
    h.submit();
    expect(h.messages.edit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.keyDown(h.input(), { key: "Escape" });
    expect(h.input()).toHaveValue("");
  },
);

it.each([undefined, "thread-root"])(
  "does not edit a diff-only conversation (thread: %s)",
  (threadRootId) => {
    const h = mount({}, undefined, first.pubkey);
    const row = editableMessage({
      diff: { filePath: "a.ts", truncated: false },
      content: "raw patch",
      ...(threadRootId ? { threadRootId } : {}),
    });
    if (threadRootId) h.retarget({ threadRootId, editMessages: [row] });
    else h.setRows([row]);
    fireEvent.keyDown(h.input(), { key: "ArrowUp" });
    expect(h.input()).toHaveValue("");
    expect(screen.queryByText("Editing message")).not.toBeInTheDocument();
    expect(h.messages.edit).not.toHaveBeenCalled();
  },
);

it("uses the full channel choice set for one selected chip and follows membership and policy changes", () => {
  const h = mount();
  const profiles = new Map([
    [first.pubkey, { name: "Honey" }],
    [second.pubkey, { name: "Honey", isAgent: true as const }],
  ]);
  let list = {
    status: "ready" as const,
    channels: [
      {
        id: "channel",
        name: "General",
        members: [first.pubkey, second.pubkey],
      },
    ],
  };
  const listeners = new Set<() => void>();
  let policyChanged = () => {};
  let providers = [createAgentDirectory()];
  const session = {
    ...h.session,
    profiles: { ...h.session.profiles, snapshot: () => profiles },
    channels: {
      ...h.session.channels,
      list: () => list,
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  const names = bindNames(session, {
    snapshot: () => providers,
    subscribe: (listener) => {
      policyChanged = listener;
      return () => {};
    },
  });
  h.retarget({ session: { ...session, names } });
  act(() => h.commands().insertMention(second));
  const label = () => within(h.input()).getByRole("img").textContent;
  expect(label()).toBe("@Honey (agent)");
  const source = h.input().value;
  act(() => {
    list = {
      ...list,
      channels: [{ id: "channel", name: "General", members: [second.pubkey] }],
    };
    for (const notify of listeners) notify();
  });
  expect(label()).toBe("@Honey");
  act(() => {
    providers = [
      {
        ...createAgentDirectory(),
        scope: () => () => ({ name: "Alternative" }),
      },
    ];
    policyChanged();
  });
  expect(label()).toBe("@Alternative");
  act(() => {
    providers = [];
    policyChanged();
  });
  expect(label()).toBe("@Honey");
  expect(h.input()).toHaveValue(source);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledWith(
    "channel",
    source,
    [second.pubkey],
    [],
  );
  h.unmount();
  names.dispose();
});

it("sends someone outside a DM as a reference without asking", async () => {
  const h = mount();
  const add = vi.fn();
  const list = {
    status: "ready",
    channels: [
      {
        id: "channel",
        channelType: "dm",
        members: ["d".repeat(64), second.pubkey],
        participants: [second.pubkey],
      },
    ],
  };
  Object.assign(h.session, {
    channels: { list: () => list, subscribeList: () => () => {} },
    memberAdditions: { add },
    // A writer that could add members still cannot add anyone to a DM.
    outbox: { ...h.session.outbox, supports: () => true },
  });
  act(() => {
    h.commands().insertMention(first);
    h.commands().insertMention(second);
  });
  fireEvent.submit(screen.getByRole("form"));
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(h.messages.send).toHaveBeenCalledOnce();
  expect(h.messages.send.mock.calls[0]?.[2]).toEqual([second.pubkey]);
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([first.pubkey]);
  expect(add).not.toHaveBeenCalled();
});

it("does not ask about outside recipients in a Solo chat media-comment composer", async () => {
  // Media comments mount the composer with a thread root but without Solo
  // mode, so the Solo rule must come from the channel type.
  const h = mount({ threadRootId: "f".repeat(64) });
  const add = vi.fn();
  const channel = {
    id: "channel",
    channelType: "solo",
    members: [first.pubkey, second.pubkey],
  };
  const list = { status: "ready", channels: [channel] };
  Object.assign(h.session, {
    channels: { list: () => list, subscribeList: () => () => {} },
    memberAdditions: { add },
    outbox: { ...h.session.outbox, supports: () => true },
  });
  act(() => {
    h.commands().insertMention(first);
    h.commands().insertMention(second);
  });
  // The first person leaves the chat after being named.
  channel.members = [second.pubkey];
  fireEvent.submit(screen.getByRole("form"));
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(h.messages.reply).toHaveBeenCalledOnce();
  expect(h.messages.reply.mock.calls[0]?.[3]).toEqual([
    first.pubkey,
    second.pubkey,
  ]);
  expect(add).not.toHaveBeenCalled();
});

it("keeps the draft and requires explicit Retry when an eager upload fails during nonmember admission", async () => {
  const h = mount();
  const result = deferred<ReturnType<typeof uploadDescriptor>>();
  const upload = vi.fn(() => result.promise);
  const list = {
    status: "ready",
    channels: [
      { id: "channel", channelType: "stream", members: [second.pubkey] },
    ],
  };
  Object.assign(h.session, {
    attachments: { upload },
    channels: {
      ...h.session.channels,
      list: () => list,
    },
    memberAdditions: { add: vi.fn() },
  });
  h.retarget({});
  h.fill("Keep my draft");
  act(() => h.commands().insertMention(first));
  attachByPaste(h.input(), attachmentFile());
  await waitFor(() => expect(upload).toHaveBeenCalledOnce());
  fireEvent.submit(screen.getByRole("form"));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await act(async () => result.reject(new Error("relay down")));
  fireEvent.click(screen.getByRole("button", { name: "Send anyway" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(upload).toHaveBeenCalledOnce();
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(h.input().value).toContain("Keep my draft");
  expect(
    screen.getByRole("button", { name: "Retry notes.txt" }),
  ).toBeInTheDocument();
});

for (const channelType of ["stream", "forum"] as const)
  it.each([undefined, "f".repeat(64)])(
    `keeps mixed nonmember mentions as references after Send anyway in ${channelType}, root=%s`,
    async (threadRootId) => {
      const h = mount(threadRootId ? { threadRootId } : {});
      const add = vi.fn();
      const list = {
        status: "ready",
        channels: [
          {
            id: "channel",
            channelType,
            members: ["d".repeat(64), second.pubkey],
          },
        ],
      };
      Object.assign(h.session, {
        channels: { list: () => list, subscribeList: () => () => {} },
        memberAdditions: { add },
        outbox: { ...h.session.outbox, supports: (kind: number) => kind === 9 },
      });
      act(() => {
        h.commands().insertMention(first);
        h.commands().insertMention(second);
      });
      fireEvent.submit(screen.getByRole("form"));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      // block/buzz parity: without permission, Invite is absent, not disabled.
      expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Close" })).toHaveFocus(),
      );
      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Honey is not in this channel. You cannot add people to this channel. You can still send without inviting them.",
      );
      expect(add).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Send anyway" }));
      await act(async () => {});
      const send = threadRootId ? h.messages.reply : h.messages.send;
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[threadRootId ? 3 : 2]).toEqual([
        second.pubkey,
      ]);
      expect(send.mock.calls[0]?.at(-1)).toEqual([first.pubkey]);
      expect(add).not.toHaveBeenCalled();
    },
  );

it.each(["Do nothing", "Invite"])(
  "after %s, the next draft carries an outside agent only if it was notified",
  async (action) => {
    const h = mount();
    h.setProfiles(new Map([[first.pubkey, { name: "Honey", isAgent: true }]]));
    const list = {
      status: "ready",
      channels: [
        { id: "channel", channelType: "stream", members: ["d".repeat(64)] },
      ],
    };
    const add = vi.fn(async (_channel: string, pubkey: string) => {
      list.channels[0]?.members.push(pubkey);
    });
    // A managed agent outside the channel, offered because the viewer can add it.
    const real = h.session.agentChoices;
    const offered = {
      ...real.snapshot(),
      identities: [{ ...first, managed: true }],
    };
    Object.assign(h.session, {
      viewer: "d".repeat(64),
      channels: { list: () => list, subscribeList: () => () => {} },
      memberAdditions: { add },
      agentChoices: { ...real, snapshot: () => offered },
    });
    act(() => {
      h.commands().insertMention(first);
    });
    fireEvent.submit(screen.getByRole("form"));
    fireEvent.click(screen.getByRole("button", { name: action }));
    await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
    // The sent message started a thread; its follow-up continues there. After
    // "Do nothing" the agent is a reference, not a notified mention.
    h.retarget({
      threadRootId: "channel-id",
      threadSeed: startedSeed(action === "Invite" ? [first.pubkey] : []),
    });
    const editor = h.input();
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
    await h.user.type(editor, "again", { skipClick: true });
    await h.user.click(screen.getByRole("button", { name: "Send message" }));
    // A reference is not addressed again, so the send needs no second prompt.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.messages.reply).toHaveBeenCalledOnce();
    expect(h.messages.reply.mock.calls[0]?.[3]).toEqual(
      action === "Invite" ? [first.pubkey] : [],
    );
  },
);

it("Enter on a deliberately focused Invite adds a nonmember before sending", async () => {
  const h = mount();
  const add = vi.fn(async () => {});
  const list = {
    status: "ready",
    channels: [
      { id: "channel", channelType: "stream", members: ["d".repeat(64)] },
    ],
  };
  Object.assign(h.session, {
    viewer: "d".repeat(64),
    channels: { list: () => list, subscribeList: () => () => {} },
    memberAdditions: { add },
  });
  act(() => h.commands().insertMention(first));
  fireEvent.submit(screen.getByRole("form"));
  const invite = screen.getByRole("button", { name: "Invite" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus(),
  );
  invite.focus();
  await userEvent.setup().keyboard("{Enter}");
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(add).toHaveBeenCalledWith("channel", first.pubkey);
  expect(h.messages.send.mock.calls[0]?.[2]).toEqual([first.pubkey]);
});

it.each([
  ["", false],
  [", taking it out of its archive here after a Remove", true],
])(
  "asks before bringing another community's agent in, then adds it and sends%s",
  async (_, archived) => {
    const calls: string[] = [];
    const join = vi.fn(async () => {
      calls.push("join");
      return { agent: {} as never, notes: [] };
    });
    const snapshot = { agents: [] };
    const types: never[] = [];
    const agents = {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      find: () => undefined,
      types: () => types,
      joinable: () => [
        {
          key: first.pubkey,
          pubkey: first.pubkey,
          name: "Honey",
          relay: "wss://oss.example.com",
        },
      ],
      join,
    } as unknown as Agents;
    const h = mount({}, undefined, undefined, agents);
    const add = vi.fn(async () => {
      calls.push("add");
    });
    const list = {
      status: "ready",
      channels: [
        { id: "channel", channelType: "stream", members: ["d".repeat(64)] },
      ],
    };
    Object.assign(h.session, {
      viewer: "d".repeat(64),
      scope: `https://relay.example.test:${"d".repeat(64)}`,
      channels: { list: () => list, subscribeList: () => () => {} },
      memberAdditions: { add },
      ...(archived && {
        archives: {
          state: (key: string) =>
            key === first.pubkey ? "archived" : "not-archived",
          snapshot: () => firstArchived,
        },
      }),
    });
    h.messages.send.mockImplementation(() => {
      calls.push("send");
      return "channel-id";
    });
    act(() => h.commands().insertMention(first));
    fireEvent.submit(screen.getByRole("form"));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Bring Honey into relay.example.test?",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Honey is in oss.example.com. Bringing it here adds the same agent",
    );
    // Enter on the initial focus declines: nothing joins, sends, or is lost.
    const safe = screen.getByRole("button", { name: "Don't bring" });
    await waitFor(() => expect(safe).toHaveFocus());
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(join).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(h.messages.send).not.toHaveBeenCalled();
    expect(h.input()).toHaveValue("@Honey ");
    // Confirming joins first, then adds to the channel, then sends.
    fireEvent.submit(screen.getByRole("form"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Bring it here" }),
    );
    await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
    expect(join).toHaveBeenCalledWith(first.pubkey);
    expect(calls).toEqual(["join", "add", "send"]);
    expect(h.messages.send.mock.calls[0]?.[2]).toEqual([first.pubkey]);
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);

it.each(["close", "escape", "enter"])(
  "%s preserves the captured draft and returns focus without adding or sending",
  async (action) => {
    const h = mount();
    const add = vi.fn();
    const list = {
      status: "ready",
      channels: [
        { id: "channel", channelType: "stream", members: ["d".repeat(64)] },
      ],
    };
    Object.assign(h.session, {
      viewer: "d".repeat(64),
      channels: { list: () => list, subscribeList: () => () => {} },
      memberAdditions: { add },
    });
    act(() => {
      h.commands().insertMention(first);
    });
    const input = h.input();
    fireEvent.submit(screen.getByRole("form"));
    // block/buzz parity: one send action, one invite action, and no Cancel.
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Honey is not in this channel. Invite them to the channel, or send without inviting them.",
    );
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus(),
    );
    if (action === "close")
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    else
      await userEvent
        .setup()
        .keyboard(action === "enter" ? "{Enter}" : "{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(input).toHaveValue("@Honey ");
    await waitFor(() => expect(input).toHaveFocus());
    expect(add).not.toHaveBeenCalled();
    expect(h.messages.send).not.toHaveBeenCalled();
  },
);

it.each(["retry", "unmount", "retarget", "disabled", "suspended"])(
  "waits for confirmed addition and handles %s without duplicate sends",
  async (outcome) => {
    const h = mount();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = {
      status: "ready",
      channels: [
        { id: "channel", channelType: "stream", members: ["d".repeat(64)] },
      ],
    };
    const add = vi.fn(async () => {
      await gate;
    });
    if (outcome === "retry")
      add.mockRejectedValueOnce(new Error("Membership not confirmed"));
    Object.assign(h.session, {
      viewer: "d".repeat(64),
      channels: { list: () => list, subscribeList: () => () => {} },
      memberAdditions: { add },
    });
    act(() => {
      h.commands().insertMention(first);
    });
    fireEvent.submit(screen.getByRole("form"));
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    try {
      if (outcome === "retry") {
        await screen.findByRole("alert");
        expect(h.messages.send).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Invite" }));
      }
      expect(screen.getByRole("button", { name: "Do nothing" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Inviting…" })).toBeDisabled();
      if (outcome === "unmount") h.unmount();
      else if (outcome === "retarget") h.retarget({ channelId: "other" });
      else if (outcome === "disabled") h.retarget({ disabled: true });
      else if (outcome === "suspended") {
        h.present(false);
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      }
    } finally {
      await act(async () => release());
    }
    if (outcome === "suspended") {
      h.present(true);
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      expect(h.input()).toHaveValue("@Honey ");
    }
    expect(add).toHaveBeenCalledTimes(outcome === "retry" ? 2 : 1);
    expect(h.messages.send).toHaveBeenCalledTimes(outcome === "retry" ? 1 : 0);
  },
);

it("disabled completion keeps the highlighted key and consumes Enter without sending", async () => {
  const h = mount();
  h.input().focus();
  h.fill("!Honey");
  const publish = h.completionRequests.at(-1);
  if (!publish) throw new Error("No completion request");
  act(() => {
    publish({
      items: [
        { id: first.pubkey, label: "First Honey", edit: { mention: first } },
        { id: second.pubkey, label: "Second Honey", edit: { mention: second } },
      ],
    });
  });
  fireEvent.keyDown(h.input(), { key: "ArrowDown" });
  act(() => {
    publish({
      items: [
        { id: first.pubkey, label: "First Honey", edit: { mention: first } },
        {
          id: second.pubkey,
          label: "Second Honey",
          edit: { mention: second },
          disabled: "Archived",
        },
      ],
    });
  });
  expect(screen.getByRole("option", { name: "Second Honey" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("option", { name: "Second Honey" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  fireEvent.keyDown(h.input(), { key: "Enter" });
  expect(h.input()).toHaveValue("!Honey");
  expect(h.messages.send).not.toHaveBeenCalled();
});

it("rejects a known archived recipient at send entry without clearing the draft", () => {
  const h = mount();
  let archived = false;
  h.retarget({
    session: {
      ...h.session,
      archives: {
        snapshot: () => (archived ? firstArchived : noArchives),
        subscribe: () => () => {},
        state: () => (archived ? "archived" : "not-archived"),
        ensure: async () => {},
        refresh: async () => {},
        writable: false,
        supported: true,
        consent: vi.fn(),
        request: vi.fn(),
      },
    },
  });
  act(() => {
    expect(h.commands().insertMention(first)).toBe(true);
  });
  archived = true;
  h.submit();
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(h.input()).toHaveValue(`@${first.name} `);
  expect(
    screen.getByText(
      "A selected recipient is archived. Remove it before sending.",
    ),
  ).toBeVisible();
});

it("sends a resource between mentions and keeps both after a failed send", () => {
  const h = mount();
  act(() => {
    const { insertMention, insertResource } = h.commands();
    expect(insertMention(first)).toBe(true);
    expect(insertResource(resource)).toBe(true);
    expect(insertMention(second)).toBe(true);
  });
  h.messages.send.mockImplementationOnce(() => {
    throw new Error("outbox full");
  });
  h.submit();
  expect(h.input()).toHaveTextContent("Resource: Fix login");
  h.submit();
  expect(h.messages.send.mock.calls.at(-1)?.slice(1, 3)).toEqual([
    `@Honey [Fix login](${resource.uri}) @Honey `,
    [first.pubkey, second.pubkey],
  ]);
});

describe("repository resource picker", () => {
  const empty: readonly never[] = [];
  const repository = {
    type: "repo",
    owner: resourceOwner,
    dtag: "game",
    address: `30617:${resourceOwner}:game`,
    name: "Game repo",
    description: "",
    event: {} as never,
  } satisfies Entity;
  const item = {
    id: resourceRoute.id,
    kind: 1621,
    pubkey: resourceOwner,
    created_at: 5,
    content: "Fix login",
    tags: [
      ["a", repository.address],
      ["subject", "Fix login"],
    ],
  };
  const row = /^Fix login, Issue in Game repo$/;
  function picker(
    home: (channelId: string, signal: AbortSignal) => Promise<unknown> = () =>
      Promise.resolve({ status: "home", repositories: [repository] }),
    issues: readonly (typeof item)[] = [item],
    cached?: RepositoryHome,
  ) {
    const h = mount({ extensions: undefined });
    let release: (() => void) | undefined;
    let fail: (() => void) | undefined;
    const validations: AbortSignal[] = [];
    const load = vi.fn(
      (route: { type: string; tab?: string }, signal: AbortSignal) => {
        if (route.type === "repo")
          return Promise.resolve({
            items: route.tab === "prs" ? [] : issues,
            truncated: route.tab === "prs",
          });
        validations.push(signal);
        return new Promise((resolve, reject) => {
          release = () => resolve({});
          fail = () => reject(new Error("offline"));
        });
      },
    );
    const homes = vi.fn(home);
    const recovery = createRecovery([]);
    Object.assign(h.session as object, {
      recovery,
      repositories: {
        home: homes,
        load,
        peekHome: (channelId: string) =>
          channelId === "channel" ? cached : undefined,
      },
    });
    const tools: readonly Contribution<ComposerTool>[] = [
      {
        id: "resources",
        key: "repos/resources",
        pluginId: "repos",
        revision: "1",
        title: "Issues and pull requests",
        component: ResourcePicker,
      },
    ];
    h.retarget({
      extensions: {
        tools: { snapshot: () => tools, subscribe: () => () => {} },
        inline: { snapshot: () => empty, subscribe: () => () => {} },
        completions: { snapshot: () => empty, subscribe: () => () => {} },
      },
    });
    return {
      h,
      homes,
      load,
      recovery,
      validations,
      release: async () => {
        await act(async () => {
          release?.();
        });
      },
      fail: async () => {
        await act(async () => {
          fail?.();
        });
      },
      async open() {
        const trigger = await screen.findByRole("button", {
          name: "Add issue or pull request",
        });
        await waitFor(() => expect(trigger).not.toBeDisabled());
        await h.user.click(trigger);
        return trigger;
      },
    };
  }

  it("searches every channel repository and deduplicates shared items", async () => {
    const second = {
      ...repository,
      dtag: "other",
      address: `30617:${resourceOwner}:other`,
    };
    const p = picker(
      () =>
        Promise.resolve({ status: "home", repositories: [repository, second] }),
      [{ ...item, tags: [...item.tags, ["a", second.address]] }],
    );
    await p.open();
    await screen.findByRole("button", { name: row });
    expect(screen.getAllByRole("button", { name: row })).toHaveLength(1);
    expect(
      p.load.mock.calls.filter(([route]) => route.type === "repo"),
    ).toHaveLength(4);
    expect(p.homes).toHaveBeenCalledWith("channel", expect.any(AbortSignal));
  });

  it("validates the chosen row, inserts it, closes and leaves focus in the draft", async () => {
    const p = picker();
    await p.open();
    expect(
      await screen.findByText(/Some issues or pull requests may be missing/),
    ).toBeVisible();
    const choice = await screen.findByRole("button", { name: row });
    expect(choice).toHaveTextContent("Issue · Game repo");
    // Synthetic coverage checks the guard, not native IME behavior.
    const search = screen.getByRole("searchbox");
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      fireEvent.keyDown(search, { key: "ArrowDown", ...composition });
      expect(search).toHaveFocus();
      // fireEvent returns false when a handler cancelled the default.
      expect(fireEvent.keyDown(search, { key: "Enter", ...composition })).toBe(
        true,
      );
      expect(p.validations).toHaveLength(0);
    }
    // Keyboard: focus stays in search with the row highlighted; Enter
    // chooses it.
    expect(search).toHaveAttribute("aria-activedescendant", choice.id);
    await p.h.user.keyboard("{ArrowDown}");
    expect(search).toHaveFocus();
    expect(choice).toHaveAttribute("data-selected");
    await p.h.user.keyboard("{Enter}");
    expect(p.validations).toHaveLength(1);
    expect(choice).toHaveTextContent("Checking…");
    await p.release();
    expect(screen.queryByRole("button", { name: row })).toBeNull();
    expect(p.h.input()).toHaveTextContent("Resource: Fix login");
    expect(p.h.input()).toHaveFocus();
    p.h.submit();
    expect(p.h.messages.send.mock.calls[0]?.[1]).toBe(
      `[Fix login](${resource.uri}) `,
    );
  });

  it("orders titles by match: prefix, then word start, then the rest", async () => {
    const issue = (id: string, title: string, created_at: number) => ({
      ...item,
      id: id.repeat(64),
      created_at,
      content: title,
      tags: [
        ["a", repository.address],
        ["subject", title],
      ],
    });
    const p = picker(undefined, [
      issue("a", "Relogin bug", 9),
      item,
      issue("b", "Login page", 1),
    ]);
    await p.open();
    const titles = async () =>
      (
        await screen.findAllByRole("button", { name: /, Issue in Game repo$/ })
      ).map((choice) => choice.getAttribute("aria-label")?.split(",")[0]);
    expect(await titles()).toEqual(["Relogin bug", "Fix login", "Login page"]);
    const search = screen.getByRole("searchbox");
    await p.h.user.type(search, "login");
    expect(await titles()).toEqual(["Login page", "Fix login", "Relogin bug"]);
    const choice = screen.getByRole("button", { name: /^Login page,/ });
    expect(search).toHaveAttribute("aria-activedescendant", choice.id);
    expect(choice.querySelector("mark")).toHaveTextContent(/^login$/i);
    // Up wraps to the last row; Shift+Enter is not a choice.
    await p.h.user.keyboard("{ArrowUp}");
    expect(search).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("button", { name: /^Relogin bug,/ }).id,
    );
    fireEvent.keyDown(search, { key: "Enter", shiftKey: true });
    expect(p.validations).toHaveLength(0);
    await p.h.user.keyboard("{ArrowDown}{Enter}");
    expect(p.validations).toHaveLength(1);
    expect(choice).toHaveTextContent("Checking…");
  });

  it("highlights and announces the row that Tab focuses", async () => {
    const p = picker(undefined, [
      item,
      {
        ...item,
        id: "b".repeat(64),
        created_at: 1,
        content: "Login page",
        tags: [
          ["a", repository.address],
          ["subject", "Login page"],
        ],
      },
    ]);
    await p.open();
    const second = await screen.findByRole("button", { name: /^Login page,/ });
    const search = screen.getByRole("searchbox");
    const list = document.getElementById(
      search.getAttribute("aria-controls") ?? "",
    );
    expect(list).toContainElement(second);
    for (let i = 0; i < 10 && document.activeElement !== second; i += 1)
      await p.h.user.tab();
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("data-selected");
    expect(screen.getByRole("button", { name: row })).not.toHaveAttribute(
      "data-selected",
    );
    expect(search).toHaveAttribute("aria-activedescendant", second.id);
    expect(
      screen.getByText("Login page. Press Enter to add.", { exact: true }),
    ).toBeInTheDocument();
  });

  it("puts an exact title before a newer title that starts with it", async () => {
    const p = picker(undefined, [
      {
        ...item,
        id: "b".repeat(64),
        created_at: item.created_at + 1,
        content: "Fix login page",
        tags: [
          ["a", repository.address],
          ["subject", "Fix login page"],
        ],
      },
      item,
    ]);
    await p.open();
    const search = screen.getByRole("searchbox");
    await p.h.user.type(search, "fix login");
    const choice = screen.getByRole("button", { name: row });
    expect(
      (
        await screen.findAllByRole("button", { name: /, Issue in Game repo$/ })
      ).map((option) => option.getAttribute("aria-label")?.split(",")[0]),
    ).toEqual(["Fix login", "Fix login page"]);
    expect(search).toHaveAttribute("aria-activedescendant", choice.id);
    await p.h.user.keyboard("{Enter}");
    expect(p.validations).toHaveLength(1);
    expect(choice).toHaveTextContent("Checking…");
  });

  it("keeps focus on the highlighted row after Tab, for arrows and pointer", async () => {
    const p = picker(undefined, [
      item,
      {
        ...item,
        id: "b".repeat(64),
        created_at: 1,
        content: "Login page",
        tags: [
          ["a", repository.address],
          ["subject", "Login page"],
        ],
      },
    ]);
    await p.open();
    const first = await screen.findByRole("button", { name: row });
    const second = screen.getByRole("button", { name: /^Login page,/ });
    for (let i = 0; i < 10 && document.activeElement !== first; i += 1)
      await p.h.user.tab();
    expect(first).toHaveFocus();
    // Down on a focused row moves the highlight and focus together.
    await p.h.user.keyboard("{ArrowDown}");
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("data-selected");
    expect(first).not.toHaveAttribute("data-selected");
    // A pointer highlight moves focus too, so Enter adds the highlighted row.
    fireEvent.pointerMove(first, { clientX: 1, clientY: 1 });
    fireEvent.pointerMove(first, { clientX: 2, clientY: 2 });
    expect(first).toHaveAttribute("data-selected");
    expect(first).toHaveFocus();
    await p.h.user.keyboard("{Enter}");
    expect(p.validations).toHaveLength(1);
    expect(first).toHaveTextContent("Checking…");
  });

  it("keeps focus in the popover while a clicked row is checked", async () => {
    const p = picker();
    await p.open();
    await p.h.user.click(await screen.findByRole("button", { name: row }));
    expect(screen.getByRole("button", { name: row })).toBeDisabled();
    expect(screen.getByRole("searchbox")).toHaveFocus();
    expect(screen.getByText("Checking the chosen item…")).toHaveAttribute(
      "role",
      "status",
    );
    await p.fail();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not check this item",
    );
    expect(screen.getByRole("searchbox")).toHaveFocus();
    expect(screen.queryByText("Checking the chosen item…")).toBeNull();
  });

  it("keeps a rejected insertion in the popover with the host reason", async () => {
    const p = picker();
    p.h.fill("`ab`");
    p.h.input().setSelectionRange(2, 2);
    await p.open();
    await p.h.user.click(await screen.findByRole("button", { name: row }));
    await p.release();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Links can't be added inside code or other Markdown here",
    );
    expect(screen.getByRole("button", { name: row })).toBeVisible();
    expect(p.h.input()).toHaveValue("`ab`");
  });

  it("drops a pending choice when the composer is disabled and re-enabled", async () => {
    const p = picker();
    await p.open();
    await p.h.user.click(await screen.findByRole("button", { name: row }));
    p.h.retarget({ disabled: true });
    p.h.retarget({ disabled: false });
    expect(p.validations[0]?.aborted).toBe(true);
    expect(screen.queryByRole("button", { name: row })).toBeNull();
    await p.release();
    expect(p.h.input()).toHaveValue("");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drops a pending choice on send instead of landing it in the next draft", async () => {
    const p = picker();
    p.h.fill("first message");
    await p.open();
    await p.h.user.click(await screen.findByRole("button", { name: row }));
    await p.h.user.click(screen.getByRole("button", { name: /^Send/ }));
    expect(p.h.messages.send.mock.calls[0]?.[1]).toBe("first message");
    expect(p.validations[0]?.aborted).toBe(true);
    await p.release();
    expect(p.h.input()).toHaveValue("");
    expect(screen.queryByRole("button", { name: row })).toBeNull();
  });

  it("does not show a PR action while checking a new channel's repository", async () => {
    const pending: {
      channelId: string;
      resolve(value: unknown): void;
    }[] = [];
    const p = picker(
      (channelId) =>
        new Promise((resolve) => pending.push({ channelId, resolve })),
    );
    const trigger = () =>
      screen.queryByRole("button", { name: "Add issue or pull request" });
    const finish = async (channelId: string, result: unknown) => {
      await act(async () => {
        for (const read of pending) {
          if (read.channelId === channelId) read.resolve(result);
        }
      });
    };
    try {
      await waitFor(() => expect(p.homes).toHaveBeenCalled());
      expect(screen.getByText("Loading repositories…")).toBeInTheDocument();
      expect(trigger()).toBeNull();
      await finish("channel", { status: "home", repositories: [repository] });
      expect(trigger()).toBeEnabled();
      p.h.retarget({ channelId: "no-repository", channelName: "Other" });
      await waitFor(() =>
        expect(pending.some((read) => read.channelId === "no-repository")).toBe(
          true,
        ),
      );
      expect(trigger()).toBeNull();
      await finish("no-repository", { status: "none" });
      expect(trigger()).toBeNull();
      p.h.retarget({ channelId: "repository", channelName: "Repository" });
      await waitFor(() =>
        expect(pending.some((read) => read.channelId === "repository")).toBe(
          true,
        ),
      );
      expect(trigger()).toBeNull();
      await finish("repository", {
        status: "home",
        repositories: [repository],
      });
      expect(trigger()).toBeEnabled();
    } finally {
      await act(async () => {
        for (const read of pending) read.resolve({ status: "none" });
      });
    }
  });

  it("keeps a chat without a repository free of the PR button after closing formatting", async () => {
    const pending: ((value: unknown) => void)[] = [];
    const p = picker(() => new Promise((resolve) => pending.push(resolve)));
    await waitFor(() => expect(p.homes).toHaveBeenCalled());
    await act(async () => {
      for (const resolve of pending) resolve({ status: "none" });
    });
    const resourceButton = () =>
      screen.queryByRole("button", { name: "Add issue or pull request" });
    expect(resourceButton()).toBeNull();
    try {
      fireEvent.click(
        screen.getByRole("button", { name: "Toggle formatting" }),
      );
      const close = await screen.findByRole("button", {
        name: "Close formatting",
      });
      await waitFor(() =>
        expect(
          screen.queryByRole("button", {
            name: "Toggle formatting",
            hidden: true,
          }),
        ).toBeNull(),
      );
      expect(resourceButton()).toBeNull();
      fireEvent.click(close);
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Toggle formatting" }),
        ).toBeVisible(),
      );
      expect(resourceButton()).toBeNull();
    } finally {
      await act(async () => {
        for (const resolve of pending) resolve({ status: "none" });
      });
    }
  });

  it("hides only for no repository, and explains failure with a retry", async () => {
    const none = picker(() => Promise.resolve({ status: "none" }));
    await waitFor(() => expect(none.homes).toHaveBeenCalled());
    await act(async () => {});
    expect(
      screen.queryByRole("button", { name: "Add issue or pull request" }),
    ).toBeNull();
    cleanup();
    let resolveHome: ((value: unknown) => void) | undefined;
    const ambiguous = picker(() =>
      resolveHome
        ? new Promise((resolve) => {
            resolveHome = resolve;
          })
        : Promise.reject(new Error("offline")),
    );
    await ambiguous.open();
    expect(
      await screen.findByText(/Could not load this channel’s repositories/),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: row })).toBeNull();
    // Failure is recoverable: once the connection is restored, retry rereads.
    resolveHome = () => {};
    await ambiguous.h.user.click(
      screen.getByRole("button", { name: "Retry repositories" }),
    );
    expect(
      await screen.findByText("Loading repositories…"),
    ).toBeInTheDocument();
    await act(async () => {
      resolveHome?.({ status: "home", repositories: [repository] });
    });
    expect(await screen.findByRole("button", { name: row })).toBeVisible();
    expect(
      screen.queryByText(/Could not load this channel’s repositories/),
    ).toBeNull();
    cleanup();
    const failed = picker(() => Promise.reject(new Error("offline")));
    await failed.open();
    const retry = await screen.findByRole("button", {
      name: "Retry repositories",
    });
    const reads = failed.homes.mock.calls.length;
    await failed.h.user.click(retry);
    await waitFor(() =>
      expect(failed.homes.mock.calls.length).toBeGreaterThan(reads),
    );
  });

  it("reads repositories and their lists refused while signed out again once sign-in lands", async () => {
    const refused = () =>
      Promise.reject(new Error("Federated sign-in is required"));
    let signedIn = false;
    const p = picker(() =>
      signedIn
        ? Promise.resolve({ status: "home", repositories: [repository] })
        : refused(),
    );
    const { recovery } = p;
    await screen.findByRole("button", { name: "Add issue or pull request" });
    await act(async () => {});
    const homes = p.homes.mock.calls.length;
    signedIn = true;
    act(() => recovery.retryAll());
    await waitFor(() =>
      expect(p.homes.mock.calls.length).toBeGreaterThan(homes),
    );
    const reread = p.homes.mock.calls.length;
    p.load.mockImplementationOnce(refused);
    signedIn = false;
    await p.open();
    expect(
      await screen.findByText("Could not load issues and pull requests."),
    ).toBeVisible();
    const lists = p.load.mock.calls.length;
    act(() => recovery.retryAll());
    expect(await screen.findByRole("button", { name: row })).toBeVisible();
    expect(p.load.mock.calls.length).toBeGreaterThan(lists);
    // A list refusal rereads the list, not the repositories.
    expect(p.homes.mock.calls.length).toBe(reread);
  });

  it.each(["formatting", "channel"])(
    "keeps a known repository visible but unusable after %s remount, then preserves failure and retry",
    async (action) => {
      const reads: ReturnType<typeof deferred<RepositoryHome>>[] = [];
      const p = picker(
        () => {
          const read = deferred<RepositoryHome>();
          reads.push(read);
          return read.promise;
        },
        undefined,
        { status: "home", repositories: [repository] },
      );
      const trigger = () =>
        screen.getByRole("button", { name: "Add issue or pull request" });
      try {
        await waitFor(() => expect(reads.length).toBeGreaterThan(0));
        expect(trigger()).toBeVisible();
        expect(trigger()).toBeDisabled();
        await act(async () => {
          for (const read of reads)
            read.resolve({ status: "home", repositories: [repository] });
        });
        expect(trigger()).toBeEnabled();
        if (action === "formatting") {
          await p.h.user.click(
            screen.getByRole("button", { name: "Toggle formatting" }),
          );
          const close = await screen.findByRole("button", {
            name: "Close formatting",
          });
          await waitFor(() =>
            expect(
              screen.queryByRole("button", {
                name: "Toggle formatting",
                hidden: true,
              }),
            ).toBeNull(),
          );
          await p.h.user.click(close);
        } else {
          p.h.retarget({ channelId: "other" });
          await waitFor(() =>
            expect(p.homes).toHaveBeenCalledWith(
              "other",
              expect.any(AbortSignal),
            ),
          );
          await act(async () => reads.at(-1)?.resolve({ status: "none" }));
          p.h.retarget({ channelId: "channel" });
        }
        await waitFor(() =>
          expect(
            p.homes.mock.calls.filter(([id]) => id === "channel").length,
          ).toBeGreaterThan(1),
        );
        expect(trigger()).toBeDisabled();
        // Closing formatting fades the toolbar back in; wait for that entrance.
        await waitFor(() => expect(trigger()).toBeVisible());
        expect(trigger()).toBeDisabled();
        fireEvent.click(trigger());
        expect(
          screen.queryByRole("dialog", { name: "Add issue or pull request" }),
        ).toBeNull();
        await act(async () => reads.at(-1)?.reject(new Error("offline")));
        await p.open();
        expect(
          await screen.findByText(/Could not load this channel’s repositories/),
        ).toBeVisible();
        expect(screen.queryByRole("button", { name: row })).toBeNull();
        await p.h.user.click(
          screen.getByRole("button", { name: "Retry repositories" }),
        );
        expect(
          screen.queryByRole("button", { name: "Add issue or pull request" }),
        ).toBeNull();
        await act(async () =>
          reads.at(-1)?.resolve({ status: "home", repositories: [repository] }),
        );
        expect(await screen.findByRole("button", { name: row })).toBeVisible();
        p.h.retarget({ channelId: "other" });
        await waitFor(() => expect(p.homes.mock.lastCall?.[0]).toBe("other"));
        await act(async () => reads.at(-1)?.resolve({ status: "none" }));
        p.h.retarget({ channelId: "channel" });
        await waitFor(() => expect(p.homes.mock.lastCall?.[0]).toBe("channel"));
        expect(trigger()).toBeVisible();
        expect(trigger()).toBeDisabled();
      } finally {
        await act(async () => {
          for (const read of reads) read.resolve({ status: "none" });
        });
      }
    },
  );

  it.each(["none", "error"] as const)(
    "a warm repository is replaced by the completed %s state",
    async (outcome) => {
      const read = deferred<RepositoryHome>();
      const p = picker(() => read.promise, undefined, {
        status: "home",
        repositories: [repository],
      });
      try {
        await waitFor(() => expect(p.homes).toHaveBeenCalled());
        expect(
          screen.getByRole("button", { name: "Add issue or pull request" }),
        ).toBeDisabled();
        await act(async () => {
          if (outcome === "error") read.reject(new Error("offline"));
          else read.resolve({ status: outcome });
        });
        if (outcome === "none") {
          expect(
            screen.queryByRole("button", { name: "Add issue or pull request" }),
          ).toBeNull();
        } else {
          await p.open();
          expect(
            screen.getByText(/Could not load this channel’s repositories/),
          ).toBeVisible();
          expect(
            screen.getByRole("button", { name: "Retry repositories" }),
          ).toBeEnabled();
          expect(screen.queryByRole("button", { name: row })).toBeNull();
        }
      } finally {
        await act(async () => read.resolve({ status: "none" }));
      }
    },
  );
});

it("keeps a composed message unchanged through caret keys at its end and refuses a Right Arrow committed as text in either form", async () => {
  const h = mount();
  await h.user.type(h.input(), "Hello!");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}world");
  expect(h.input()).toHaveValue("Hello!\nworld");
  const html = h.input().innerHTML;
  for (let i = 0; i < 3; i++) await h.user.keyboard("{ArrowRight}");
  for (const key of [
    "ArrowLeft",
    "ArrowUp",
    "ArrowDown",
    "Shift",
    "Meta",
    "Escape",
  ])
    await h.user.keyboard(`{${key}}`);
  // jsdom does not model Home and End on a contenteditable element.
  for (const key of ["Home", "End"]) {
    fireEvent.keyDown(h.input(), { key, code: key });
    fireEvent.keyUp(h.input(), { key, code: key });
  }
  expect(h.input()).toHaveValue("Hello!\nworld");
  expect(h.input().innerHTML).toBe(html);
  expect(h.messages.send).not.toHaveBeenCalled();
  // The desktop build committed Right Arrow's raw keyboard-layout translation
  // U+001D; AppKit's function-key character for the key is U+F703. Neither
  // has a glyph, so each assertion names its form rather than the character.
  for (const [label, character] of [
    ["Right Arrow's layout translation U+001D", "\u001D"],
    ["Right Arrow's function-key character U+F703", "\uF703"],
  ] as const) {
    let prevented = false;
    act(() => {
      h.input().focus();
      prevented = !h.input().dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: character,
        }),
      );
    });
    expect(prevented, label).toBe(true);
    expect(h.input(), label).toHaveValue("Hello!\nworld");
    expect(h.input().innerHTML, label).toBe(html);
  }
  // The keydown such a press arrives as: `key` is the control character while
  // `code` and the legacy key code still name Right Arrow. It is claimed before
  // the native path can type it, and neither sends nor edits the message.
  let prevented = false;
  act(() => {
    prevented = !fireEvent.keyDown(h.input(), {
      key: "\u001D",
      code: "ArrowRight",
      keyCode: 39,
    });
  });
  expect(prevented).toBe(true);
  expect(h.input()).toHaveValue("Hello!\nworld");
  expect(h.input().innerHTML).toBe(html);
  expect(h.messages.send).not.toHaveBeenCalled();
});

it("retires composer transients and revoked insert commands without replacing the editor or draft", async () => {
  const h = mount();
  h.fill("retained draft");
  const editor = h.input();
  const commands = h.commands();
  fireEvent.click(screen.getByRole("button", { name: "Toggle formatting" }));
  fireEvent.click(screen.getByRole("button", { name: /^Link/ }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("dialog")).toContainElement(
      document.activeElement as HTMLElement,
    ),
  );
  const focus = vi.spyOn(editor, "focus");
  h.present(false);
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(
    screen.queryByRole("button", { name: "First Honey", hidden: true }),
  ).toBeNull();
  act(() => {
    expect(commands.insertText("late picker selection")).toBe(false);
  });
  h.present(true);
  act(() => {
    expect(commands.insertText("retired command after recovery")).toBe(false);
  });
  expect(h.input()).toBe(editor);
  expect(editor).toHaveValue("retained draft");
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  await act(() => Promise.resolve());
  expect(focus).not.toHaveBeenCalled();
  expect(h.messages.send).not.toHaveBeenCalled();
});

it("adds an HTTP link in the dialog and reports unsafe destinations accurately", () => {
  const h = mount();
  h.fill("docs");
  const editor = h.input();
  act(() => editor.setSelectionRange(0, 4));
  fireEvent.click(screen.getByRole("button", { name: "Toggle formatting" }));
  fireEvent.click(screen.getByRole("button", { name: /^Link/ }));
  expect(screen.getByRole("dialog", { name: "Add link" })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "URL" }), {
    target: { value: "http://user:pw@example.com" },
  });
  // A stray outside click keeps the dialog and the typed URL.
  const backdrop = document.querySelector(".buzz-dialog-backdrop") as Element;
  fireEvent.pointerDown(backdrop);
  fireEvent.mouseDown(backdrop);
  fireEvent.click(backdrop);
  expect(screen.getByRole("textbox", { name: "URL" })).toHaveValue(
    "http://user:pw@example.com",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Use an HTTP(S) URL or a valid buzz:// link.",
  );
  fireEvent.change(screen.getByRole("textbox", { name: "URL" }), {
    target: { value: "http://example.com/docs" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(editor).toHaveValue("docs");
  expect(h.input().innerHTML).toContain("http://example.com/docs");
});

it("restores the retained editor when the Link dialog closes normally", async () => {
  const h = mount();
  const editor = h.input();
  fireEvent.click(screen.getByRole("button", { name: "Toggle formatting" }));
  fireEvent.click(screen.getByRole("button", { name: /^Link/ }));
  await waitFor(() =>
    expect(screen.getByRole("dialog")).toContainElement(
      document.activeElement as HTMLElement,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(editor).toHaveFocus());
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
});

it("keeps a local attachment and its editor alive while presentation is suspended", async () => {
  const h = mount();
  let finish!: (value: {
    name: string;
    url: string;
    type: string;
    size: number;
    sha256: string;
  }) => void;
  const gate = new Promise<{
    name: string;
    url: string;
    type: string;
    size: number;
    sha256: string;
  }>((resolve) => {
    finish = resolve;
  });
  let signal!: AbortSignal;
  const upload = vi.fn(
    (_file: File, _channel: string, current: AbortSignal) => {
      signal = current;
      return gate;
    },
  );
  h.retarget({ session: { ...h.session, attachments: { upload } } });
  const editor = h.input();
  h.fill("kept with upload");
  fireEvent.change(screen.getByLabelText("Choose attachments"), {
    target: { files: [new NodeFile(["notes"], "notes.txt")] },
  });
  h.present(false);
  expect(upload).not.toHaveBeenCalled();
  expect(editor.isConnected).toBe(true);
  expect(editor).toHaveValue("kept with upload");

  h.present(true);
  expect(h.input()).toBe(editor);
  fireEvent.submit(
    screen.getByRole("form", { name: "Send a message to General" }),
  );
  await waitFor(() => expect(upload).toHaveBeenCalledOnce());
  try {
    expect(signal.aborted).toBe(false);
  } finally {
    await act(async () =>
      finish({
        name: "notes.txt",
        url: "https://relay.test/media/notes.txt",
        type: "text/plain",
        size: 5,
        sha256: "a".repeat(64),
      }),
    );
  }
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "kept with upload",
    [],
    [
      {
        name: "notes.txt",
        url: "https://relay.test/media/notes.txt",
        type: "text/plain",
        size: 5,
        sha256: "a".repeat(64),
      },
    ],
  );
  expect(signal.aborted).toBe(false);
  expect(upload).toHaveBeenCalledOnce();
});

it("dismisses completion observations without reopening them on recovery", async () => {
  const h = mount();
  act(() => h.input().focus());
  h.fill("!query");
  h.publish(h.completionRequests.length - 1, "Completed choice");
  expect(screen.getByText("Completed choice")).toBeInTheDocument();
  const editor = h.input();
  h.present(false);
  expect(document.body.textContent).not.toContain("Completed choice");
  h.present(true);
  expect(h.input()).toBe(editor);
  expect(editor).toHaveValue("!query");
  expect(document.body.textContent).not.toContain("Completed choice");
});

it.each([undefined, "root"])(
  "notifies draft retirement only after accepted %s cleanup persists, retrying without Send",
  async (threadRootId) => {
    const retired = vi.fn();
    const h = mount({
      ...(threadRootId ? { threadRootId } : {}),
      onDraftSaved: retired,
    });
    h.fill("Accepted once");
    const key = threadRootId
      ? `draft:channel:thread:${threadRootId}`
      : "draft:channel";
    const stored = `buzz-view.v1:${JSON.stringify(["scope", key])}`;
    const setItem = Storage.prototype.setItem;
    const fail = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === stored) throw Error("no space");
        setItem.call(this, key, value);
      });
    try {
      await h.user.click(screen.getByRole("button", { name: "Send message" }));
      expect(h.onSend).toHaveBeenCalledOnce();
      expect(retired).not.toHaveBeenCalled();
      expect(h.input()).toHaveValue("");
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
      fireEvent.submit(screen.getByRole("form"));
      expect(
        threadRootId ? h.messages.reply : h.messages.send,
      ).toHaveBeenCalledOnce();
    } finally {
      fail.mockRestore();
    }
    await h.user.click(
      screen.getByRole("button", { name: "Retry draft cleanup" }),
    );
    expect(retired).toHaveBeenCalledExactlyOnceWith();
    expect(h.onSend).toHaveBeenCalledOnce();
    expect(readView("scope", key, "")).toMatchObject({ text: "" });
  },
);

it.each([false, true])(
  "allows successive sends with no saved revision while writes fail (remembered agent: %s)",
  async (remembered) => {
    const retired = vi.fn();
    const h = mount({ onDraftSaved: retired });
    h.setProfiles(new Map([[first.pubkey, { name: "Honey", isAgent: true }]]));
    const key = 'buzz-view.v1:["scope","draft:channel"]';
    const original = Storage.prototype.setItem;
    const fail = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, name, value) {
        if (name === key) throw Error("full");
        original.call(this, name, value);
      });
    try {
      h.fill("First message");
      if (remembered)
        await h.user.click(screen.getByRole("button", { name: "First Honey" }));
      await h.user.click(screen.getByRole("button", { name: "Send message" }));
      expect(h.messages.send).toHaveBeenCalledOnce();
      expect(h.input()).toHaveValue(remembered ? "@Honey " : "");
      expect(h.input()).not.toHaveAttribute("contenteditable", "false");
      expect(
        screen.queryByRole("button", { name: "Retry draft cleanup" }),
      ).not.toBeInTheDocument();
      expect(localStorage.getItem(key)).toBeNull();
      // Remembered agents are in memory, not a draft, so the failed
      // absence-only cleanup is tolerated either way.
      expect(retired).toHaveBeenCalledTimes(1);
      // Keep the actual inline recipient while appending new work.
      if (remembered) await h.user.keyboard("Second message");
      else h.fill("Second message");
      await h.user.click(screen.getByRole("button", { name: "Send message" }));
      expect(h.messages.send).toHaveBeenCalledTimes(2);
      expect(h.messages.send.mock.calls[1]?.[1]).toContain("Second message");
      expect(h.messages.send.mock.calls[1]?.[2]).toEqual(
        remembered ? [first.pubkey] : [],
      );
      expect(localStorage.getItem(key)).toBeNull();
      expect(retired).toHaveBeenCalledTimes(2);
      // Failed absence-only cleanup must not leave a Solo draft recovery lock.
      h.retarget({ channelId: "other" });
      h.retarget({ channelId: "channel" });
      h.fill("After remount");
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled();
      expect(
        screen.queryByRole("button", { name: "Retry draft cleanup" }),
      ).not.toBeInTheDocument();
    } finally {
      fail.mockRestore();
    }
  },
);

it.each([false, true])(
  "still saves the replacement of an absent draft when writes recover (remembered: %s)",
  async (remembered) => {
    const retired = vi.fn();
    const h = mount({ onDraftSaved: retired });
    h.setProfiles(new Map([[first.pubkey, { name: "Honey", isAgent: true }]]));
    const fail = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw Error("full");
      });
    try {
      h.fill("Previously unsaved text");
      if (remembered)
        await h.user.click(screen.getByRole("button", { name: "First Honey" }));
      expect(
        localStorage.getItem('buzz-view.v1:["scope","draft:channel"]'),
      ).toBeNull();
      h.messages.send.mockImplementationOnce(() => {
        fail.mockRestore();
        return "accepted";
      });
      await h.user.click(screen.getByRole("button", { name: "Send message" }));
      expect(readView("scope", "draft:channel", "missing")).toMatchObject({
        text: "",
      });
      expect(h.input()).toHaveValue(remembered ? "@Honey " : "");
      expect(retired).toHaveBeenCalledExactlyOnceWith();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      fail.mockRestore();
    }
  },
);

it.each(["captured", "cleanup"])(
  "retains accepted recovery when the %s saved revision is unreadable",
  async (unreadable) => {
    const key = 'buzz-view.v1:["scope","draft:channel"]';
    let blocked = unreadable === "captured";
    const getItem = Storage.prototype.getItem;
    const read = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(function (this: Storage, name) {
        if (name === key && blocked) throw Error("unreadable");
        return getItem.call(this, name);
      });
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw Error("full");
      });
    try {
      const retired = vi.fn();
      const h = mount({ onDraftSaved: retired });
      h.fill("Accepted but storage cannot be verified");
      h.messages.send.mockImplementationOnce(() => {
        blocked = true;
        return "accepted";
      });
      await h.user.click(screen.getByRole("button", { name: "Send message" }));
      expect(h.messages.send).toHaveBeenCalledOnce();
      expect(retired).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
      await h.user.click(
        screen.getByRole("button", { name: "Retry draft cleanup" }),
      );
      expect(
        screen.getByRole("button", { name: "Retry draft cleanup" }),
      ).toBeVisible();
      expect(h.messages.send).toHaveBeenCalledOnce();
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  },
);

it.each([false, true])(
  "preserves a newer saved revision when accepted cleanup races a replacement (event: %s)",
  async (notify) => {
    const retired = vi.fn();
    const h = mount({ onDraftSaved: retired });
    h.fill("Send this body");
    h.messages.send.mockImplementationOnce(() => {
      const key = 'buzz-view.v1:["scope","draft:channel"]';
      localStorage.setItem(key, JSON.stringify("Newer saved work"));
      if (notify)
        window.dispatchEvent(
          new StorageEvent("storage", { storageArea: localStorage, key }),
        );
      return "accepted";
    });
    await h.user.click(screen.getByRole("button", { name: "Send message" }));
    expect(h.messages.send).toHaveBeenCalledOnce();
    expect(h.onSend).toHaveBeenCalledExactlyOnceWith("accepted");
    expect(retired).not.toHaveBeenCalled();
    expect(readView("scope", "draft:channel", "")).toBe("Newer saved work");
    expect(h.input()).toHaveValue("Newer saved work");
  },
);

it("compares before local edits and Send even if the storage event has not arrived", async () => {
  const h = mount();
  h.fill("Local body");
  localStorage.setItem(
    'buzz-view.v1:["scope","draft:channel"]',
    JSON.stringify("Saved elsewhere"),
  );
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(/changed elsewhere/);
  h.fill("Continue local edits");
  expect(readView("scope", "draft:channel", "")).toBe("Saved elsewhere");
  await h.user.click(screen.getByRole("button", { name: "Load saved draft" }));
  expect(h.input()).toHaveValue("Saved elsewhere");
});

it("keeps the original draft after synchronous outbox rejection without a persistence callback", async () => {
  const retired = vi.fn();
  const h = mount({ onDraftSaved: retired });
  h.fill("Rejected body");
  h.messages.send.mockImplementationOnce(() => {
    throw Error("outbox full");
  });
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.onSend).not.toHaveBeenCalled();
  expect(retired).not.toHaveBeenCalled();
  expect(h.input()).toHaveValue("Rejected body");
  expect(readView("scope", "draft:channel", "")).toMatchObject({
    text: "Rejected body",
  });
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
});

it("does not restore accepted cleanup over a replacement made while the composer was closed", async () => {
  const h = mount();
  h.fill("Already accepted");
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("full");
  });
  try {
    await h.user.click(screen.getByRole("button", { name: "Send message" }));
    expect(
      screen.getByRole("button", { name: "Retry draft cleanup" }),
    ).toBeVisible();
  } finally {
    fail.mockRestore();
  }
  const session = h.session;
  h.unmount();
  writeView("scope", "draft:channel", "A replacement draft");
  const reopened = mount({ session });
  expect(reopened.input()).toHaveValue("A replacement draft");
  expect(
    screen.queryByRole("button", { name: "Retry draft cleanup" }),
  ).not.toBeInTheDocument();
});

it("leaves active message-edit content alone and reconciles the draft on return", () => {
  const h = mount({}, undefined, first.pubkey);
  h.setRows([editableMessage()]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  h.fill("An edit, not a draft");
  act(() => writeView("scope", "draft:channel", "Draft saved elsewhere"));
  expect(h.input()).toHaveValue("An edit, not a draft");
  expect(readView("scope", "draft:channel", "")).toBe("Draft saved elsewhere");
  fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
  expect(h.input()).toHaveValue("Draft saved elsewhere");
  expect(h.messages.send).not.toHaveBeenCalled();
});

it.each([
  ["without", undefined],
  ["with", vi.fn()],
])("saves a submission draft %s an unsaved listener", (_, unsaved) => {
  const h = mount({
    submission: {
      draftKey: "new-draft",
      locked: false,
      disabled: false,
      unsaved,
      submit: vi.fn(),
    },
  });
  h.fill("Not sent yet");
  expect(readView("scope", "new-draft", null)).toMatchObject({
    text: "Not sent yet",
  });
  if (unsaved) expect(unsaved).toHaveBeenLastCalledWith(false);
});

it("does not apply ordinary draft reconciliation to submission-owned recovery", () => {
  const submit = vi.fn();
  const h = mount({
    submission: {
      draftKey: "solo-retry",
      recoveredDraft: { text: "Durable operation", recipients: [] },
      locked: true,
      disabled: false,
      submit,
    },
  });
  act(() => writeView("scope", "solo-retry", "Disposable view state"));
  expect(h.input()).toHaveValue("Durable operation");
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(submit).toHaveBeenCalledExactlyOnceWith(
    {
      text: "Durable operation",
      recipients: [],
    },
    expect.objectContaining({ prepareForSend: expect.any(Function) }),
    // Outside Solo-with-agents no recipients are held apart from the text.
    undefined,
    undefined,
    undefined,
    undefined,
  );
  expect(
    screen.queryByRole("button", { name: "Load saved draft" }),
  ).not.toBeInTheDocument();
});

it("rechecks the saved revision after held Solo chat admission before submitting", async () => {
  const h = mount();
  const channel = {
    id: "channel",
    channelType: "solo",
    members: [first.pubkey],
  };
  const list = { status: "ready", channels: [channel] };
  const library = { status: "ready", identities: [first] };
  let release = () => {};
  const refreshMembership = vi.fn(
    () =>
      new Promise<typeof channel>((resolve) => {
        release = () => resolve(channel);
      }),
  );
  h.retarget({
    soloConversation: true,
    session: {
      ...h.session,
      channels: { list: () => list, subscribeList: () => () => {} },
      agentLibrary: {
        snapshot: () => library,
        subscribe: () => () => {},
      },
      channelWrites: { refreshMembership, addAgents: vi.fn() },
    } as unknown as RelaySession,
  });
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  h.submit();
  await waitFor(() => expect(refreshMembership).toHaveBeenCalledOnce());
  try {
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    // Event delivery can lag a synchronous read in another page.
    localStorage.setItem(
      'buzz-view.v1:["scope","draft:channel"]',
      JSON.stringify("New work during admission"),
    );
  } finally {
    await act(async () => release());
  }
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("changed elsewhere");
  expect(readView("scope", "draft:channel", "")).toBe(
    "New work during admission",
  );
});

it("locks the composer until the sent draft's cleanup succeeds, keeping the remembered agents in memory", async () => {
  const retired = vi.fn();
  const h = mount({ onDraftSaved: retired });
  vi.spyOn(h.session.profiles, "snapshot").mockReturnValue(
    new Map([[first.pubkey, { name: "Honey", isAgent: true }]]),
  );
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("full");
  });
  try {
    await h.user.click(screen.getByRole("button", { name: "Send message" }));
    expect(h.input()).toHaveValue("@Honey ");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form"));
    expect(h.messages.send).toHaveBeenCalledOnce();
    expect(retired).not.toHaveBeenCalled();
  } finally {
    fail.mockRestore();
  }
  await h.user.click(
    screen.getByRole("button", { name: "Retry draft cleanup" }),
  );
  expect(readView("scope", "draft:channel", "")).toEqual(emptied);
  expect(h.input()).toHaveValue("@Honey ");
  expect(retired).toHaveBeenCalledOnce();
  expect(h.messages.send).toHaveBeenCalledOnce();
});

it("batch insertion deduplicates exact keys and sends individual recipients", async () => {
  const h = mount();
  act(() =>
    expect(h.commands().insertMentions([first, second, first])).toBe(true),
  );
  expect(h.input()).toHaveValue("@Honey @Honey ");
  h.submit();
  await waitFor(() => expect(h.messages.send).toHaveBeenCalled());
  expect(h.messages.send.mock.calls[0]?.[2]).toEqual([
    first.pubkey,
    second.pubkey,
  ]);
});
it("batch insertion rejects an unavailable member atomically and does not send on rejected completion", async () => {
  const h = mount({ inviteAgents: true });
  const unavailable = { pubkey: "c".repeat(64), name: "Missing" };
  h.fill("!Court");
  act(() => {
    h.completionRequests.at(-1)?.({
      items: [
        {
          id: "team",
          label: "Court",
          edit: { mentions: [first, unavailable] },
        },
      ],
    });
  });
  await h.user.keyboard("{Enter}");
  expect(h.input()).toHaveValue("!Court");
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("no longer available");
});
it.each(["disabled", "retarget", "unmount"])(
  "revokes batch commands after %s",
  (transition) => {
    const h = mount();
    const insert = h.commands().insertMentions;
    if (transition === "disabled") h.retarget({ disabled: true });
    else if (transition === "retarget") h.retarget({ channelId: "other" });
    else h.unmount();
    act(() => expect(insert([first, second])).toBe(false));
    expect(h.messages.send).not.toHaveBeenCalled();
  },
);

it("keeps snapshot paste from taking the attachment slot reserved for a recording", async () => {
  const empty: readonly never[] = [];
  const tools: readonly Contribution<ComposerTool>[] = [
    {
      id: "capture",
      key: "test/capture",
      pluginId: "test",
      revision: "1",
      title: "Capture",
      component: ({ capture }) => (
        <button
          type="button"
          onClick={() =>
            capture?.(({ accept }) => (
              <button
                type="button"
                onClick={() =>
                  accept({
                    file: new File([new Uint8Array(100)], "voice-note.wav", {
                      type: "audio/wav",
                    }),
                    duration: 1,
                    waveform: [0.5],
                  })
                }
              >
                Finish recording
              </button>
            ))
          }
        >
          Start recording
        </button>
      ),
    },
  ];
  const h = await mountUploadComposer({
    media: (url) => `buzz-media://localhost/${encodeURIComponent(url)}`,
    extensions: {
      tools: { snapshot: () => tools, subscribe: () => () => {} },
      inline: { snapshot: () => empty, subscribe: () => () => {} },
      completions: { snapshot: () => empty, subscribe: () => () => {} },
    },
  });
  const picker =
    h.container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!picker) throw new Error("Missing file picker");
  fireEvent.change(picker, {
    target: {
      files: Array.from(
        { length: 9 },
        (_, i) => new File(["draft"], `draft-${i}.txt`, { type: "text/plain" }),
      ),
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
  const finish = screen.getByRole("button", { name: "Finish recording" });
  const descriptor = {
    name: "helper.agent.png",
    url: `https://relay.example.test/media/${"a".repeat(64)}.png`,
    type: "image/png",
    size: 2048,
    sha256: "a".repeat(64),
  };
  fireEvent.paste(finish, {
    clipboardData: {
      items: [],
      getData: (type: string) =>
        type === "text/html"
          ? `<a href="${descriptor.url}">Helper</a>`
          : descriptor.url,
    },
  });
  expect(
    screen.queryByRole("button", { name: "Remove helper.agent.png" }),
  ).toBeNull();
  fireEvent.click(finish);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Remove voice-note.wav" }),
    ).toBeVisible(),
  );
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  expect(h.uploadCalls[0]?.file.name).toBe("draft-0.txt");
  expect(h.publish).not.toHaveBeenCalled();
});

it.each([false, true])(
  "retains a companion draft until owner admission settles (reject=%s)",
  async (reject) => {
    const h = mount();
    const gate = deferred<string>();
    Reflect.deleteProperty(h.session, "unread");
    const send = vi.fn(() => gate.promise);
    Object.assign(h.session.messages, { send });
    h.fill("Keep until acknowledged");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.input()).toHaveValue("Keep until acknowledged");
    expect(h.onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await act(async () => {
      if (reject) gate.reject(new Error("Owner rejected this send"));
      else gate.resolve("admitted");
    });
    if (reject) {
      expect(h.input()).toHaveValue("Keep until acknowledged");
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Owner rejected this send",
      );
      expect(h.onSend).not.toHaveBeenCalled();
    } else {
      expect(h.input()).toHaveValue("");
      expect(h.onSend).toHaveBeenCalledWith("admitted");
    }
  },
);

it("drops the attachments mark while a row-requested edit holds pending items", async () => {
  // Arrow-up refuses to edit over pending items; the row's Edit action does not.
  const h = await mountUploadComposer({ editable: true });
  const viewer = h.owner.session.viewer;
  if (!viewer) throw new Error("Expected upload viewer");
  h.unmount();
  let scope: ReturnType<typeof useMessageEditScope>;
  function Probe() {
    scope = useMessageEditScope();
    return null;
  }
  const row = editableMessage({ authorId: viewer });
  const view = render(
    <MessageEditScope>
      <Probe />
      <MessageComposer
        session={h.owner.session}
        scope={h.scope}
        channelId="channel"
        channelName="General"
        editMessages={[row]}
      />
    </MessageEditScope>,
    { wrapper: ToastProvider },
  );
  const form = within(view.container).getByRole("form");
  attachByPaste(
    within(view.container).getByRole("textbox"),
    attachmentFile("pending.txt"),
  );
  await waitFor(() => expect(form).toHaveAttribute("data-attachments"));
  act(() => scope?.current?.(row));
  expect(form).toHaveAttribute("data-editing");
  expect(form).not.toHaveAttribute("data-attachments");
  fireEvent.click(
    within(view.container).getByRole("button", { name: "Cancel edit" }),
  );
  expect(form).not.toHaveAttribute("data-editing");
  expect(form).toHaveAttribute("data-attachments");
  await waitFor(() =>
    expect(within(view.container).getByText("pending.txt")).toBeVisible(),
  );
});

it("stages chat cards above an ordinary caption editor, persists them, and sends both", async () => {
  const link = "[Session: PR 45 fixes](buzz://channel/session-id)";
  writeView("scope", "draft:channel", link);
  const h = mount();
  const region = screen.getByRole("region", { name: "Chat attachments" });
  expect(region).toHaveTextContent("Chat:");
  expect(h.input()).toHaveValue("");
  expect(
    region.compareDocumentPosition(h.input()) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  await h.user.type(h.input(), "please review");
  expect(h.input()).not.toHaveTextContent("Session:");
  expect(
    readView<{ chatCards: string[] } | null>("scope", "draft:channel", null)
      ?.chatCards,
  ).toEqual([link]);
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.send).toHaveBeenCalledWith(
    "channel",
    `${link}\n\n@Honey please review`,
    [first.pubkey],
    [],
  );
  expect(screen.queryByRole("region", { name: "Chat attachments" })).toBeNull();
});

it("stages pasted chat links, restores them on remount, and removes them without changing the caption", async () => {
  const link = "[Session: PR 45 fixes](buzz://channel/session-id)";
  const h = mount();
  act(() => h.input().insertText(`${link} Caption`));
  expect(
    screen.getByRole("region", { name: "Chat attachments" }),
  ).toHaveTextContent("PR 45 fixes");
  expect(h.input()).toHaveValue(" Caption");
  h.unmount();
  const restored = mount();
  expect(
    screen.getByRole("region", { name: "Chat attachments" }),
  ).toHaveTextContent("PR 45 fixes");
  await restored.user.click(
    screen.getByRole("button", { name: "Remove chat attachment 1" }),
  );
  expect(restored.input()).toHaveValue(" Caption");
  expect(document.activeElement).toBe(restored.input());
  expect(screen.queryByRole("region", { name: "Chat attachments" })).toBeNull();
  await restored.user.click(
    screen.getByRole("button", { name: "Send message" }),
  );
  expect(restored.messages.send).toHaveBeenCalledWith(
    "channel",
    " Caption",
    [],
    [],
  );
});

it("sends a staged chat without a caption", async () => {
  const link = "[Session: 12345678](buzz://channel/session-id)";
  writeView("scope", "draft:channel", link);
  const h = mount();
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.send).toHaveBeenCalledWith("channel", link, [], []);
});

it("retains a new card-only followup when a background upload fails", async () => {
  const h = await mountUploadComposer();
  attachByPaste(h.input(), attachmentFile("original.txt"));
  await userEvent.type(h.input(), "original caption");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  const link = "[Session: New work](buzz://channel/session-id)";
  act(() => (h.input() as ComposerInputElement).insertText(link));
  await act(async () => h.uploadCalls[0]?.result.reject(new Error("offline")));
  expect(
    screen.getByRole("region", { name: "Chat attachments" }),
  ).toHaveTextContent("New work");
  expect(readView(h.scope, "draft:channel", null)).toMatchObject({
    chatCards: [link],
  });
  expect(
    await screen.findByText(/Failed send was kept because this draft changed/),
  ).toBeVisible();
  expect(h.publish).not.toHaveBeenCalled();
});

it("restores and sends an older chat-link draft with its selected mention intact", async () => {
  const link = "[Session: Fix](buzz://channel/session-id)";
  writeView("scope", "draft:channel", {
    text: `@Honey ${link}`,
    recipients: [{ ...first, start: 0, end: 6 }],
  });
  const h = mount();
  expect(h.input()).toHaveValue("@Honey ");
  expect(
    screen.getByRole("region", { name: "Chat attachments" }),
  ).toHaveTextContent("Fix");
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.send).toHaveBeenCalledWith(
    "channel",
    `${link}\n\n@Honey `,
    [first.pubkey],
    [],
  );
});

it("does not publish an unchanged inline session edit, including reverting a caption change", () => {
  const h = mount({}, undefined, first.pubkey);
  const content =
    "please review [Session: Fix](buzz://channel/session-id) before merge";
  h.setRows([editableMessage({ content })]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  h.submit();
  expect(h.messages.edit).not.toHaveBeenCalled();
  expect(h.input()).not.toHaveAccessibleName("Edit message");
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  const caption = h.input().textContent ?? "";
  h.fill("Changed caption");
  h.fill(caption);
  h.submit();
  expect(h.messages.edit).not.toHaveBeenCalled();
});

it("sends staged chat cards in thread replies without share tags", async () => {
  const link = "[Session: Work](buzz://channel/session-id)";
  const h = mount();
  h.retarget({ threadRootId: "root" });
  act(() => h.input().insertText(link));
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.reply).toHaveBeenCalledWith(
    "channel",
    "root",
    link,
    [],
    [],
  );
});

it.each(["A ||hidden|| caption", "Use `a || b` here"])(
  "sends staged cards with an unrecognized caption without a marker: %s",
  async (caption) => {
    const link = "[Session: Work](buzz://channel/session-id)";
    writeView("scope", "draft:channel", link);
    const h = mount();
    await h.user.type(h.input(), caption);
    await h.user.click(screen.getByRole("button", { name: "Send message" }));
    expect(h.messages.send).toHaveBeenCalledWith(
      "channel",
      `${link}\n\n${caption}`,
      [],
      [],
    );
  },
);

it("does not take focus when a default recipient arrives after mount", () => {
  const h = mount();
  const outside = document.createElement("input");
  document.body.append(outside);
  outside.focus();
  try {
    h.retarget({ defaultMention: second });
    expect(h.input()).toHaveValue(`@${second.name} `);
    expect(outside).toHaveFocus();
  } finally {
    outside.remove();
  }
});

it("edits the last message from an untouched automatic tag and restores that tag on cancel", () => {
  const h = mount({ defaultMention: second }, undefined, first.pubkey);
  h.setRows([editableMessage()]);
  expect(h.input()).toHaveValue(`@${second.name} `);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).toHaveAccessibleName("Edit message");
  fireEvent.keyDown(h.input(), { key: "Escape" });
  expect(h.input()).toHaveValue(`@${second.name} `);
  h.fill("my own draft");
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).not.toHaveAccessibleName("Edit message");
});

it("seeds the pill with the agent last tagged in a Solo chat, never the text", () => {
  const viewer = "e".repeat(64);
  const mountSolo = () => {
    const h = mount({}, undefined, viewer);
    h.setHistory("loading");
    h.setLibrary([first, second]);
    h.setProfiles(
      new Map([
        [first.pubkey, { name: "Ada", isAgent: true }],
        [second.pubkey, { name: "Bea", isAgent: true }],
      ]),
    );
    h.retarget({
      ownSoloConversation: true,
      requireMention: true,
      session: {
        ...h.session,
        channels: { ...h.session.channels, list: () => soloList },
      } as unknown as RelaySession,
    });
    return h;
  };
  const sendingTo = (names: string) =>
    screen.getByRole("status", { name: `Sending to ${names}. Change agents` });
  const h = mountSolo();
  expect(h.input()).toHaveValue("");
  expect(sendingTo("")).toBeInTheDocument();
  h.setRows([
    editableMessage({
      id: "1".repeat(64),
      authorId: viewer,
      mentions: [first.pubkey],
    }),
    editableMessage({
      id: "2".repeat(64),
      authorId: viewer,
      mentions: [second.pubkey],
    }),
    // Neither an agent's message nor a thread reply chooses the agent.
    editableMessage({
      id: "3".repeat(64),
      authorId: second.pubkey,
      mentions: [first.pubkey],
    }),
    editableMessage({
      id: "4".repeat(64),
      authorId: viewer,
      mentions: [first.pubkey],
      threadRootId: "1".repeat(64),
    }),
  ]);
  // The history decides before any stand-in: the pill waits while it loads.
  expect(sendingTo("")).toBeInTheDocument();
  h.setHistory("ready");
  expect(sendingTo("Bea")).toBeInTheDocument();
  // The agent is held by the pill, not tagged in the text.
  expect(h.input()).toHaveValue("");
  expect(h.commands().recipients).toEqual([]);
  expect(h.commands().audience?.recipients).toEqual([
    { pubkey: second.pubkey, name: "Bea" },
  ]);
  // The pill is never emptied: picking another agent replaces the last-tagged
  // one, and that choice stays while the chat is shown, however the draft changes.
  act(() =>
    h.commands().audience?.only([{ pubkey: first.pubkey, name: "Ada" }]),
  );
  h.fill("for Ada");
  h.fill("");
  expect(sendingTo("Ada")).toBeInTheDocument();
  h.present(false);
  h.present(true);
  expect(sendingTo("Ada")).toBeInTheDocument();
  h.retarget({ shown: false });
  h.retarget({ shown: true });
  expect(sendingTo("Ada")).toBeInTheDocument();
  expect(h.input()).toHaveValue("");
  // Text is left as written.
  h.fill("for people");
  h.present(false);
  h.present(true);
  expect(h.input()).toHaveValue("for people");
  expect(sendingTo("Ada")).toBeInTheDocument();
  // The pick outlives a remount, over the history and whatever the
  // remember-agents preference says.
  h.unmount();
  setRememberAgentsPreference(false);
  const fresh = mountSolo();
  fresh.setRows([
    editableMessage({
      id: "2".repeat(64),
      authorId: viewer,
      mentions: [second.pubkey],
    }),
  ]);
  fresh.setHistory("ready");
  expect(sendingTo("Ada")).toBeInTheDocument();
  setRememberAgentsPreference(true);
});

it("waits for complete agent choices before seeding the pill with the agent last tagged in a Solo chat", () => {
  const viewer = "e".repeat(64);
  // The local agent is usable before the library holding the latest agent loads.
  const control = localAgentsFixture([
    { ...localAgent, pubkey: first.pubkey, name: "Ada" },
  ]);
  const h = mount(
    { scope: `https://relay.example.test:${"d".repeat(64)}` },
    control,
    viewer,
  );
  h.setLibrary([], "loading");
  h.retarget({
    ownSoloConversation: true,
    requireMention: true,
    session: {
      ...h.session,
      channels: { ...h.session.channels, list: () => soloList },
    } as unknown as RelaySession,
  });
  h.setRows([
    editableMessage({
      id: "1".repeat(64),
      authorId: viewer,
      mentions: [first.pubkey],
    }),
    editableMessage({
      id: "2".repeat(64),
      authorId: viewer,
      mentions: [second.pubkey],
    }),
  ]);
  expect(h.input()).toHaveValue("");
  // Until the choices are complete the members aren't known as agents, so
  // there is no pill and nothing is seeded.
  expect(screen.queryByRole("status", { name: /Change agents/ })).toBeNull();
  h.setLibrary([{ pubkey: second.pubkey, name: "Bea" }]);
  expect(h.input()).toHaveValue("");
  expect(
    screen.getByRole("status", { name: "Sending to Bea. Change agents" }),
  ).toBeInTheDocument();
  expect(h.commands().recipients).toEqual([]);
  expect(h.commands().audience?.recipients).toEqual([
    { pubkey: second.pubkey, name: "Bea" },
  ]);
});

it("keeps remembered agents while typing during upload without taking focus when publication finishes", async () => {
  const key = keypair();
  const agent = { pubkey: key.pubkey, name: "Honey" };
  const h = await mountUploadComposer({
    members: [agent.pubkey],
    profiles: [
      signed(key, {
        kind: 0,
        content: JSON.stringify({ name: "Honey", is_agent: true }),
        tags: [],
      }),
    ],
    defaultMention: agent,
    requireMention: true,
  });
  await waitFor(() => expect(h.input()).toHaveValue("@Honey "));
  await act(() => h.owner.session.profiles.ensure([agent.pubkey]));
  attachByPaste(h.input(), attachmentFile());
  await userEvent.type(h.input(), "caption");
  fireEvent.click(h.send());
  await waitFor(() => expect(h.uploadCalls).toHaveLength(1));
  await waitFor(() => expect(h.input()).toHaveValue("@Honey "));
  const editor = screen.getByRole<ComposerInputElement>("textbox");
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
  await userEvent.type(editor, "next", { skipClick: true });
  const outside = document.createElement("input");
  document.body.append(outside);
  outside.focus();
  try {
    await act(async () => {
      h.uploadCalls[0]?.result.resolve(uploadDescriptor());
    });
    await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
    expect(outside).toHaveFocus();
    expect(h.input()).toHaveValue("@Honey next");
    fireEvent.click(h.send());
    await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(2));
    expect(h.publish.mock.calls[1]?.[0].tags).toContainEqual([
      "p",
      agent.pubkey,
    ]);
  } finally {
    outside.remove();
  }
});

it("thread follow-ups retain every selected agent, honor removal and share the opt-out", async () => {
  const h = mount({}, undefined, first.pubkey);
  h.setLibrary([first, second]);
  h.setProfiles(
    new Map([
      [first.pubkey, { name: first.name, isAgent: true }],
      [second.pubkey, { name: second.name, isAgent: true }],
    ]),
  );
  h.retarget({
    threadRootId: "root",
    session: {
      ...h.session,
      channels: {
        ...h.session.channels,
        list: () => soloList,
      },
      channelWrites: {
        refreshMembership: async () => ({
          id: "channel",
          members: [first.pubkey, second.pubkey],
        }),
        addAgents: vi.fn(),
      },
    } as unknown as RelaySession,
  });
  act(() => {
    h.commands().insertMention(first);
    h.commands().insertMention(second);
    h.commands().insertText("hello");
  });
  h.submit();
  const send = h.messages.reply;
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  await waitFor(() => expect(h.input()).toHaveValue("@Honey @Honey "));
  // Keep only the second agent for the next send.
  act(() => {
    h.input().removeRecipient(first.pubkey);
    h.commands().insertText("next");
  });
  h.submit();
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(h.input()).toHaveValue("@Honey "));
  expect(send.mock.calls.at(-1)?.[3]).toEqual([second.pubkey]);
  setRememberAgentsPreference(false);
  h.submit();
  await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(h.input()).toHaveValue(""));
  setRememberAgentsPreference(true);
  expect(h.input()).toHaveValue("");
});

it("solo follow-ups keep every selected agent in the pill, never the text", async () => {
  const h = mount({}, undefined, first.pubkey);
  h.setLibrary([first, second]);
  h.setProfiles(
    new Map([
      [first.pubkey, { name: first.name, isAgent: true }],
      [second.pubkey, { name: second.name, isAgent: true }],
    ]),
  );
  h.retarget({
    ownSoloConversation: true,
    requireMention: true,
    session: {
      ...h.session,
      channels: {
        ...h.session.channels,
        list: () => soloList,
      },
      channelWrites: {
        refreshMembership: async () => ({
          id: "channel",
          members: [first.pubkey, second.pubkey],
        }),
        addAgents: vi.fn(),
      },
    } as unknown as RelaySession,
  });
  const sendingTo = (names: string) =>
    screen.getByRole("status", { name: `Sending to ${names}. Change agents` });
  act(() => {
    h.commands().insertMention(first);
    h.commands().insertMention(second);
    h.commands().insertText("hello");
  });
  expect(sendingTo("Honey, Honey")).toBeInTheDocument();
  h.submit();
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send.mock.calls.at(-1)?.[2]).toEqual([
    first.pubkey,
    second.pubkey,
  ]);
  // Both agents stay selected in the pill for the next message; the text is empty.
  await waitFor(() => expect(h.input()).toHaveValue(""));
  expect(sendingTo("Honey, Honey")).toBeInTheDocument();
  h.setRows([editableMessage()]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  expect(h.input()).toHaveAccessibleName("Edit message");
  fireEvent.keyDown(h.input(), { key: "Escape" });
  expect(h.input()).toHaveValue("");
  expect(sendingTo("Honey, Honey")).toBeInTheDocument();
  // A pick keeps only that agent for the next send.
  act(() => {
    h.commands().audience?.only([second]);
    h.commands().insertText("next");
  });
  expect(sendingTo("Honey")).toBeInTheDocument();
  h.submit();
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledTimes(2));
  expect(h.messages.send.mock.calls.at(-1)?.[2]).toEqual([second.pubkey]);
  await waitFor(() => expect(h.input()).toHaveValue(""));
  expect(sendingTo("Honey")).toBeInTheDocument();
  // The pill is never emptied: an empty pick is ignored.
  act(() => h.commands().audience?.only([]));
  expect(sendingTo("Honey")).toBeInTheDocument();
  h.fill("again");
  h.submit();
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledTimes(3));
  expect(h.messages.send.mock.calls.at(-1)?.[2]).toEqual([second.pubkey]);
});

function mountSoloAgents(
  options: {
    main?: string;
    members?: readonly string[];
    archived?: () => boolean;
    agents?: Agents;
    refreshed?: readonly string[];
  } = {},
) {
  if (options.main) setDefaultAgent("scope", options.main);
  const members = options.members ?? [first.pubkey, second.pubkey];
  const list = {
    ...soloList,
    channels: [{ ...soloList.channels[0], members }],
  };
  const h = mount({}, undefined, "viewer", options.agents);
  h.setLibrary([first, second]);
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Ada", isAgent: true }],
      [second.pubkey, { name: "Bea", isAgent: true }],
    ]),
  );
  h.retarget({
    soloConversation: true,
    session: {
      ...h.session,
      viewer: "viewer",
      channels: { ...h.session.channels, list: () => list },
      ...(options.archived && {
        archives: {
          snapshot: () => (options.archived?.() ? firstArchived : noArchives),
          subscribe: () => () => {},
          ensure: async () => {},
          refresh: async () => {},
          writable: false,
          supported: true,
          consent: vi.fn(),
          request: vi.fn(),
        },
      }),
      channelWrites: {
        refreshMembership: async () => ({
          id: "channel",
          members: options.refreshed ?? members,
        }),
        addAgents: vi.fn(),
      },
    } as unknown as RelaySession,
  });
  const ada = { pubkey: first.pubkey, name: "Ada" };
  const bea = { pubkey: second.pubkey, name: "Bea" };
  act(() => h.commands().audience?.only([ada]));
  const sendingTo = (names: string) =>
    screen.getByRole("status", { name: `Sending to ${names}. Change agents` });
  return { h, ada, bea, sendingTo };
}

it("typing a mention then deleting it falls back to the main agent, not the remembered pair", async () => {
  const { h, ada, bea, sendingTo } = mountSoloAgents({ main: first.pubkey });
  act(() => h.commands().audience?.only([ada, bea]));
  expect(sendingTo("Ada, Bea")).toBeInTheDocument();
  act(() => {
    h.commands().insertMention(bea);
    h.commands().insertText("hello");
  });
  // The mentioned agent is the recipient; the remembered pair steps aside.
  expect(sendingTo("Bea")).toBeInTheDocument();
  expect(h.commands().recipients).toEqual([bea]);
  expect(h.commands().audience?.named).toBe(true);
  // Deleting the mention gives the main agent, not the pair.
  h.fill("hello");
  expect(h.commands().recipients).toEqual([]);
  expect(sendingTo("Ada")).toBeInTheDocument();
  // A send with no mention goes to the main agent; the text carries no tag.
  h.submit();
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send.mock.calls.at(-1)?.[2]).toEqual([ada.pubkey]);
});

it("a pill-only agent that is compacting holds the send", () => {
  const agents = sessionAgents("channel");
  const { h } = mountSoloAgents({ agents });
  act(() => agents.setSessionState("compacting"));
  h.fill("hello");
  expect(screen.getByText("Compacting session…")).toBeVisible();
  expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  h.submit();
  expect(h.messages.send).not.toHaveBeenCalled();
});

it("a person who joined since the pill was shown stops its untagged send", async () => {
  const person = "f".repeat(64);
  const { h } = mountSoloAgents({
    refreshed: [first.pubkey, second.pubkey, person],
  });
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Ada", isAgent: true }],
      [second.pubkey, { name: "Bea", isAgent: true }],
      [person, { name: "Pat" }],
    ]),
  );
  h.fill("hello");
  h.submit();
  expect(
    await screen.findByText("Someone joined this chat. Tag an agent to send."),
  ).toBeVisible();
  expect(h.messages.send).not.toHaveBeenCalled();
});

it("a member who joined with no loaded profile also stops the untagged send", async () => {
  const { h } = mountSoloAgents({
    refreshed: [first.pubkey, second.pubkey, "f".repeat(64)],
  });
  h.fill("hello");
  h.submit();
  expect(
    await screen.findByText("Someone joined this chat. Tag an agent to send."),
  ).toBeVisible();
  expect(h.messages.send).not.toHaveBeenCalled();
});

it("removing an avatar resumes typing in the draft", async () => {
  const { h, ada, bea } = mountSoloAgents();
  act(() => h.commands().audience?.only([ada, bea]));
  h.fill("hello");
  const remove = screen.getByRole("button", {
    name: `Remove agent Ada ${ada.pubkey}`,
  });
  remove.focus();
  await h.user.keyboard("{Enter}");
  expect(h.input()).toHaveFocus();
  expect(h.commands().audience?.recipients).toEqual([bea]);
});

it("a menu toggle removes a typed tag while another tagged agent is archived", () => {
  let archived = false;
  const { h, ada, bea } = mountSoloAgents({ archived: () => archived });
  act(() => {
    h.commands().insertMention(ada);
    h.commands().insertMention(bea);
    h.commands().insertText("hello");
  });
  archived = true;
  act(() => h.commands().audience?.toggle(bea));
  expect(h.commands().recipients.map(({ pubkey }) => pubkey)).toEqual([
    ada.pubkey,
  ]);
  expect(h.input()).toHaveValue("@Ada hello");
});

it("a mention typed before the chat's agents were known still falls back to the main agent", () => {
  setDefaultAgent("scope", first.pubkey);
  const viewer = "e".repeat(64);
  const third = "f".repeat(64);
  const h = mount({}, undefined, viewer);
  h.setLibrary([first, second]);
  const list = {
    status: "ready" as const,
    channels: [
      {
        id: "channel",
        channelType: "solo" as const,
        members: [first.pubkey, second.pubkey, third],
      },
    ],
  };
  h.retarget({
    ownSoloConversation: true,
    requireMention: true,
    session: {
      ...h.session,
      channels: { ...h.session.channels, list: () => list },
    } as unknown as RelaySession,
  });
  // The viewer last sent to Bea.
  h.setRows([editableMessage({ authorId: viewer, mentions: [second.pubkey] })]);
  // A member's profile hasn't loaded: the text decides.
  expect(screen.queryByRole("status", { name: /Change agents/ })).toBeNull();
  act(() => {
    h.commands().insertMention({ pubkey: first.pubkey, name: "Ada" });
    h.commands().insertText("hello");
  });
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Ada", isAgent: true }],
      [second.pubkey, { name: "Bea", isAgent: true }],
      [third, { name: "Cal", isAgent: true }],
    ]),
  );
  // Deleting the typed tag falls back to the main agent, not the history.
  act(() => h.input().removeRecipient(first.pubkey));
  h.fill("hello");
  expect(
    screen.getByRole("status", { name: "Sending to Ada. Change agents" }),
  ).toBeInTheDocument();
});

it("an archived agent in the pill blocks the send and asks for another agent", () => {
  let archived = false;
  const { h } = mountSoloAgents({ archived: () => archived });
  h.fill("hello");
  archived = true;
  h.submit();
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(h.input()).toHaveValue("hello");
  expect(
    screen.getByText(
      "An agent you're sending to is archived. Choose another agent to send.",
    ),
  ).toBeVisible();
});

it("choosing another agent replaces an archived one the menu cannot uncheck", async () => {
  let archived = false;
  const { h, bea, sendingTo } = mountSoloAgents({ archived: () => archived });
  archived = true;
  act(() => h.commands().audience?.toggle(bea));
  expect(sendingTo("Bea")).toBeInTheDocument();
  h.fill("hello");
  h.submit();
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send.mock.calls.at(-1)?.[2]).toEqual([second.pubkey]);
});

it("a deleted typed mention falls back to the chat's own agent when the main agent isn't in it", async () => {
  const { h, ada, sendingTo } = mountSoloAgents({
    main: second.pubkey,
    members: [first.pubkey],
  });
  act(() => {
    h.commands().insertMention(ada);
    h.commands().insertText("hello");
  });
  h.fill("hello");
  expect(h.commands().recipients).toEqual([]);
  await waitFor(() => expect(sendingTo("Ada")).toBeInTheDocument());
  h.submit();
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send.mock.calls.at(-1)?.[2]).toEqual([first.pubkey]);
});

it("after sending to two agents, a different typed mention deleted again gives the main agent, and a menu pick restores menu-driven state", async () => {
  const { h, ada, bea, sendingTo } = mountSoloAgents({ main: first.pubkey });
  act(() => h.commands().audience?.only([ada, bea]));
  h.fill("both");
  h.submit();
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send.mock.calls.at(-1)?.[2]).toEqual([
    ada.pubkey,
    bea.pubkey,
  ]);
  // The pill keeps both recipients for the next draft.
  await waitFor(() => expect(h.input()).toHaveValue(""));
  expect(sendingTo("Ada, Bea")).toBeInTheDocument();
  act(() => {
    h.commands().insertMention(bea);
    h.commands().insertText("hello");
  });
  expect(sendingTo("Bea")).toBeInTheDocument();
  h.fill("hello");
  await waitFor(() => expect(sendingTo("Ada")).toBeInTheDocument());
  // A menu pick sets the pill directly and clears the replaced state.
  act(() => h.commands().audience?.only([bea]));
  expect(sendingTo("Bea")).toBeInTheDocument();
  expect(h.commands().audience?.named).toBe(false);
});

it("a Solo pill pick replaces the fallback, a team pick sets several, and it is never emptied", () => {
  const { h, ada, bea, sendingTo } = mountSoloAgents();
  act(() => h.commands().audience?.only([bea]));
  expect(sendingTo("Bea")).toBeInTheDocument();
  act(() => h.commands().audience?.only([bea, ada]));
  expect(sendingTo("Bea, Ada")).toBeInTheDocument();
  // An empty pick is ignored.
  act(() => h.commands().audience?.only([]));
  expect(sendingTo("Bea, Ada")).toBeInTheDocument();
  // Picking one agent drops the rest.
  act(() => h.commands().audience?.only([ada]));
  expect(sendingTo("Ada")).toBeInTheDocument();
  // None of it touches the text, and typing resumes at the caret.
  expect(h.input()).toHaveValue("");
  expect(h.commands().recipients).toEqual([]);
  expect(h.input()).toHaveFocus();
});

it("a Solo menu toggle adds and removes agents but never the last one", () => {
  const { h, ada, bea, sendingTo } = mountSoloAgents();
  act(() => h.commands().audience?.toggle(bea));
  expect(sendingTo("Ada, Bea")).toBeInTheDocument();
  act(() => h.commands().audience?.toggle(ada));
  expect(sendingTo("Bea")).toBeInTheDocument();
  // The last agent stays: a message always goes to someone.
  act(() => h.commands().audience?.toggle(bea));
  expect(sendingTo("Bea")).toBeInTheDocument();
  expect(h.input()).toHaveValue("");
  expect(h.commands().recipients).toEqual([]);
});

it("while a typed tag decides, a Solo menu toggle edits the tags, not a hidden list", () => {
  const { h, ada, bea, sendingTo } = mountSoloAgents({ main: first.pubkey });
  act(() => {
    h.commands().insertMention(ada);
    h.commands().insertText("hello");
  });
  act(() => h.commands().audience?.toggle(bea));
  expect(h.commands().recipients.map(({ pubkey }) => pubkey)).toEqual([
    ada.pubkey,
    bea.pubkey,
  ]);
  expect(sendingTo("Ada, Bea")).toBeInTheDocument();
  expect(h.input()).toHaveValue("@Ada @Bea hello");
  act(() => h.commands().audience?.toggle(ada));
  expect(h.commands().recipients.map(({ pubkey }) => pubkey)).toEqual([
    bea.pubkey,
  ]);
  expect(h.input()).toHaveValue("@Bea hello");
  // Deleting the last tag falls back to the main agent, untouched by picks.
  h.fill("hello");
  expect(sendingTo("Ada")).toBeInTheDocument();
});

it("while a typed tag decides, a Solo team pick replaces the tags", () => {
  const { h, ada, bea, sendingTo } = mountSoloAgents({ main: first.pubkey });
  act(() => {
    h.commands().insertMention(ada);
    h.commands().insertText("hello");
  });
  act(() => h.commands().audience?.only([bea]));
  expect(h.commands().recipients.map(({ pubkey }) => pubkey)).toEqual([
    bea.pubkey,
  ]);
  expect(sendingTo("Bea")).toBeInTheDocument();
  expect(h.input()).toHaveValue("@Bea hello");
  // Deleting the tag falls back to the main agent, not a hidden pick.
  h.fill("hello");
  expect(sendingTo("Ada")).toBeInTheDocument();
});

it("with several Solo agents, each shows as an avatar that removes it, down to one", async () => {
  const { h, ada, bea, sendingTo } = mountSoloAgents();
  expect(
    screen.queryByRole("button", { name: `Remove agent Ada ${ada.pubkey}` }),
  ).toBeNull();
  act(() => h.commands().audience?.toggle(bea));
  await h.user.click(
    screen.getByRole("button", { name: `Remove agent Ada ${ada.pubkey}` }),
  );
  expect(sendingTo("Bea")).toBeInTheDocument();
  // One agent left: no removable avatars.
  expect(
    screen.queryByRole("button", { name: `Remove agent Bea ${bea.pubkey}` }),
  ).toBeNull();
});

it("a Solo pill pick returns focus to the draft without moving its caret", () => {
  const { h, bea } = mountSoloAgents();
  h.fill("hello there");
  act(() => {
    h.input().setSelectionRange(5, 5);
    h.input().blur();
  });
  act(() => h.commands().audience?.only([bea]));
  expect(h.input()).toHaveFocus();
  expect(h.input().selectionStart).toBe(5);
  expect(h.input()).toHaveValue("hello there");
});

it("after a Solo send the pill keeps whoever received it, and a mention-addressed send replaces the fallback", async () => {
  const { h, bea, sendingTo } = mountSoloAgents();
  act(() => {
    h.commands().insertMention(bea);
    h.commands().insertText("hello");
  });
  h.submit();
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send.mock.calls.at(-1)?.[2]).toEqual([second.pubkey]);
  // The next draft is empty and the fallback is now Bea, not Ada.
  await waitFor(() => expect(h.input()).toHaveValue(""));
  expect(h.commands().recipients).toEqual([]);
  expect(sendingTo("Bea")).toBeInTheDocument();
  h.fill("again");
  h.submit();
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledTimes(2));
  expect(h.messages.send.mock.calls.at(-1)?.[2]).toEqual([second.pubkey]);
});

function mountSoloHistory(options: { remember?: boolean } = {}) {
  const viewer = "e".repeat(64);
  if (options.remember === false) setRememberAgentsPreference(false);
  const h = mount({}, undefined, viewer);
  h.setHistory("loading");
  h.setLibrary([first, second]);
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Ada", isAgent: true }],
      [second.pubkey, { name: "Bea", isAgent: true }],
    ]),
  );
  h.retarget({
    ownSoloConversation: true,
    requireMention: true,
    session: {
      ...h.session,
      channels: { ...h.session.channels, list: () => soloList },
      channelWrites: {
        refreshMembership: async () => ({
          id: "channel",
          members: [first.pubkey, second.pubkey],
        }),
        addAgents: vi.fn(),
      },
    } as unknown as RelaySession,
  });
  h.setRows([
    editableMessage({
      id: "1".repeat(64),
      authorId: viewer,
      mentions: [first.pubkey],
    }),
    editableMessage({
      id: "2".repeat(64),
      authorId: viewer,
      mentions: [first.pubkey, second.pubkey],
    }),
    // A reply in a thread never chooses the audience.
    editableMessage({
      id: "3".repeat(64),
      authorId: viewer,
      mentions: [second.pubkey],
      threadRootId: "1".repeat(64),
    }),
  ]);
  h.setHistory("ready");
  return h;
}

it("a multi-agent pill survives a remount: it is seeded from every agent of the latest message", () => {
  const h = mountSoloHistory();
  const sendingTo = (names: string) =>
    screen.getByRole("status", { name: `Sending to ${names}. Change agents` });
  expect(sendingTo("Ada, Bea")).toBeInTheDocument();
  h.unmount();
  mountSoloHistory();
  expect(sendingTo("Ada, Bea")).toBeInTheDocument();
});

it("seeding the pill from the latest message ignores the remember-agents preference", () => {
  try {
    mountSoloHistory({ remember: false });
    expect(
      screen.getByRole("status", {
        name: "Sending to Ada, Bea. Change agents",
      }),
    ).toBeInTheDocument();
  } finally {
    setRememberAgentsPreference(true);
  }
});

it("an inline mention in the middle of the text replaces the pill's fallback", async () => {
  const h = mountSoloHistory();
  act(() => {
    h.commands().insertText("Please ask ");
    h.commands().insertMention({ pubkey: second.pubkey, name: "Bea" });
    h.commands().insertText("about it");
  });
  expect(
    screen.getByRole("status", { name: "Sending to Bea. Change agents" }),
  ).toBeInTheDocument();
  expect(h.commands().recipients).toEqual([
    { pubkey: second.pubkey, name: "Bea" },
  ]);
  h.submit();
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send.mock.calls.at(-1)?.[2]).toEqual([second.pubkey]);
});

function mountSoloChat(
  members: readonly string[],
  options: { history?: "idle" | "loading" | "ready"; viewer?: string } = {},
) {
  const viewer = options.viewer ?? "e".repeat(64);
  const h = mount({}, undefined, viewer);
  h.setHistory(options.history ?? "ready");
  h.setLibrary([first, second]);
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Ada", isAgent: true }],
      [second.pubkey, { name: "Bea", isAgent: true }],
    ]),
  );
  const list = {
    status: "ready" as const,
    channels: [{ id: "channel", channelType: "solo" as const, members }],
  };
  h.retarget({
    ownSoloConversation: true,
    requireMention: true,
    session: {
      ...h.session,
      channels: { ...h.session.channels, list: () => list },
    } as unknown as RelaySession,
  });
  return { h, viewer };
}
const pillNamed = (names: string) =>
  screen.getByRole("status", { name: `Sending to ${names}. Change agents` });

it("with none of your messages loaded and no main or local agent among them, the pill takes all the chat's usable agents", () => {
  mountSoloChat([first.pubkey, second.pubkey]);
  expect(pillNamed("Ada, Bea")).toBeInTheDocument();
});

it("with none of your messages loaded, the main agent is chosen over the chat's other agents when it is a member", () => {
  setDefaultAgent("scope", second.pubkey);
  mountSoloChat([first.pubkey, second.pubkey]);
  expect(pillNamed("Bea")).toBeInTheDocument();
});

it("with none of your messages loaded, the first member agent that runs on this computer is chosen", () => {
  const control = localAgentsFixture([
    { ...localAgent, pubkey: second.pubkey, name: "Bea" },
  ]);
  const h = mount(
    { scope: `https://relay.example.test:${"d".repeat(64)}` },
    control,
    "e".repeat(64),
  );
  h.setLibrary([first, second]);
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Ada", isAgent: true }],
      [second.pubkey, { name: "Bea", isAgent: true }],
    ]),
  );
  const list = {
    status: "ready" as const,
    channels: [
      {
        id: "channel",
        channelType: "solo" as const,
        members: [first.pubkey, second.pubkey],
      },
    ],
  };
  h.retarget({
    ownSoloConversation: true,
    requireMention: true,
    session: {
      ...h.session,
      channels: { ...h.session.channels, list: () => list },
    } as unknown as RelaySession,
  });
  expect(pillNamed("Bea")).toBeInTheDocument();
});

it("with no usable agent in the chat, the pill falls back to your main agent", () => {
  localStorage.clear();
  setDefaultAgent("scope", second.pubkey);
  mountSoloChat(["f".repeat(64)]);
  // The chat's only other member is unknown, so routing is off until it loads.
  expect(screen.queryByRole("status", { name: /Change agents/ })).toBeNull();
  cleanup();
  const { h } = mountSoloChat(["e".repeat(64)]);
  expect(pillNamed("Bea")).toBeInTheDocument();
  expect(h.input()).toHaveValue("");
});

it("a Solo chat with a person tags the agent the viewer last tagged in the text, honoring the preference", () => {
  const person = "f".repeat(64);
  const viewer = "e".repeat(64);
  const open = () => {
    const opened = mountSoloChat([first.pubkey, person], { viewer });
    opened.h.setProfiles(
      new Map([
        [first.pubkey, { name: "Ada", isAgent: true }],
        [second.pubkey, { name: "Bea", isAgent: true }],
        [person, { name: "Pat" }],
      ]),
    );
    opened.h.setRows([
      editableMessage({ authorId: viewer, mentions: [first.pubkey] }),
    ]);
    return opened.h;
  };
  const h = open();
  expect(screen.queryByRole("status", { name: /Change agents/ })).toBeNull();
  expect(h.input()).toHaveValue("@Ada ");
  h.unmount();
  setRememberAgentsPreference(false);
  const off = open();
  expect(off.input()).toHaveValue("");
  setRememberAgentsPreference(true);
});

it("a Solo chat with a person that opens on ready history tags the agent at mount", () => {
  const person = "f".repeat(64);
  const viewer = "e".repeat(64);
  const h = mount({}, undefined, viewer);
  h.setHistory("ready");
  h.setLibrary([first, second]);
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Ada", isAgent: true }],
      [person, { name: "Pat" }],
    ]),
  );
  h.setRows([editableMessage({ authorId: viewer, mentions: [first.pubkey] })]);
  const list = {
    status: "ready" as const,
    channels: [
      {
        id: "channel",
        channelType: "solo" as const,
        members: [first.pubkey, person],
      },
    ],
  };
  // Switching to an own Solo chat mounts its composer afresh.
  h.retarget({
    ownSoloConversation: true,
    requireMention: true,
    session: {
      ...h.session,
      channels: { ...h.session.channels, list: () => list },
    } as unknown as RelaySession,
  });
  expect(h.input()).toHaveValue("@Ada ");
});

it("a hidden tab keeps the pill of a draft with prose when the history changes", () => {
  const viewer = "e".repeat(64);
  const { h } = mountSoloChat([first.pubkey, second.pubkey], {
    viewer,
    history: "loading",
  });
  h.setRows([editableMessage({ authorId: viewer, mentions: [first.pubkey] })]);
  h.setHistory("ready");
  const pill = (name: string) =>
    screen.getByRole("status", { name: `Sending to ${name}. Change agents` });
  expect(pill("Ada")).toBeInTheDocument();
  h.fill("for Ada");
  // Another device sends to Bea while this tab is hidden.
  h.retarget({ shown: false });
  h.setRows([
    editableMessage({ authorId: viewer, mentions: [first.pubkey] }),
    editableMessage({
      id: "2".repeat(64),
      authorId: viewer,
      mentions: [second.pubkey],
    }),
  ]);
  h.retarget({ shown: true });
  expect(h.input()).toHaveValue("for Ada");
  expect(pill("Ada")).toBeInTheDocument();
});

it("a saved chat's pick is restored whole while agent discovery is incomplete", () => {
  const viewer = "e".repeat(64);
  const ada = { pubkey: first.pubkey, name: "Ada" };
  const bea = { pubkey: second.pubkey, name: "Bea" };
  const pill = (name: string) =>
    screen.getByRole("status", { name: `Sending to ${name}. Change agents` });
  const before = mountSoloChat([first.pubkey, second.pubkey], { viewer });
  act(() => before.h.commands().audience?.only([ada, bea]));
  expect(pill("Ada, Bea")).toBeInTheDocument();
  before.h.unmount();
  // Bea's profile says agent, but her library hasn't loaded yet.
  const h = mount({}, undefined, viewer);
  h.setHistory("ready");
  h.setLibrary([first], "loading");
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Ada", isAgent: true }],
      [second.pubkey, { name: "Bea", isAgent: true }],
    ]),
  );
  const list = {
    status: "ready" as const,
    channels: [
      {
        id: "channel",
        channelType: "solo" as const,
        members: [first.pubkey, second.pubkey],
      },
    ],
  };
  h.retarget({
    ownSoloConversation: true,
    requireMention: true,
    session: {
      ...h.session,
      channels: { ...h.session.channels, list: () => list },
    } as unknown as RelaySession,
  });
  expect(pill("Ada, Bea")).toBeInTheDocument();
  h.setLibrary([first, second]);
  expect(pill("Ada, Bea")).toBeInTheDocument();
});

it("a pill that takes over from mount-time text seeding keeps the history's agent", () => {
  setDefaultAgent("scope", second.pubkey);
  const viewer = "e".repeat(64);
  const third = "f".repeat(64);
  const h = mount({}, undefined, viewer);
  h.setHistory("ready");
  h.setLibrary([first, second]);
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Ada", isAgent: true }],
      [second.pubkey, { name: "Bea", isAgent: true }],
    ]),
  );
  h.setRows([editableMessage({ authorId: viewer, mentions: [first.pubkey] })]);
  const list = {
    status: "ready" as const,
    channels: [
      {
        id: "channel",
        channelType: "solo" as const,
        members: [first.pubkey, second.pubkey, third],
      },
    ],
  };
  h.retarget({
    ownSoloConversation: true,
    requireMention: true,
    session: {
      ...h.session,
      channels: { ...h.session.channels, list: () => list },
    } as unknown as RelaySession,
  });
  // A member's profile is loading: the text is seeded.
  expect(h.input()).toHaveValue("@Ada ");
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Ada", isAgent: true }],
      [second.pubkey, { name: "Bea", isAgent: true }],
      [third, { name: "Cal", isAgent: true }],
    ]),
  );
  // Alone with agents, the history's agent moves to the pill.
  expect(h.input()).toHaveValue("");
  expect(
    screen.getByRole("status", { name: "Sending to Ada. Change agents" }),
  ).toBeInTheDocument();
});

it("the pill waits for the chat's history before any stand-in seeds it", () => {
  const { h, viewer } = mountSoloChat([first.pubkey, second.pubkey], {
    history: "loading",
  });
  expect(pillNamed("")).toBeInTheDocument();
  h.setRows([
    editableMessage({
      id: "2".repeat(64),
      authorId: viewer,
      mentions: [second.pubkey],
    }),
  ]);
  expect(pillNamed("")).toBeInTheDocument();
  h.setHistory("ready");
  // The latest message wins over the chat's members.
  expect(pillNamed("Bea")).toBeInTheDocument();
});

it("a member whose profile has not loaded turns pill routing off", async () => {
  const unknown = "f".repeat(64);
  const { h } = mountSoloChat([first.pubkey, unknown]);
  expect(screen.queryByRole("status", { name: /Change agents/ })).toBeNull();
  expect(h.commands().audience).toBeUndefined();
  // The old mention rules apply: tag someone to send.
  h.fill("hello");
  h.submit();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Tag a person or agent to send",
  );
  expect(h.messages.send).not.toHaveBeenCalled();
  act(() => h.commands().insertMention(first));
  expect(h.commands().recipients).toEqual([first]);
  // Once the member is known as an agent, the pill takes over.
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Ada", isAgent: true }],
      [unknown, { name: "Cy", isAgent: true }],
    ]),
  );
  expect(h.commands().audience).toBeDefined();
});

it("queues a tagged agent follow-up while agent choices no longer list it", async () => {
  localStorage.setItem("buzz-follow-up-behavior.v1", "queue");
  const h = mount();
  h.setLibrary([{ pubkey: first.pubkey, name: "Honey" }]);
  const activity = {
    status: "unavailable",
    records: [],
    turns: [],
    typing: [],
    local: [
      {
        agent: first.pubkey,
        channelId: "channel",
        messageId: "previous",
        state: "working",
        scope: "scope",
        threadRootId: "",
        startedAt: 1,
      },
    ],
  };
  // A store snapshot keeps its identity until the store changes.
  const channelList = {
    status: "ready",
    channels: [{ id: "channel", channelType: "solo", creator: "viewer" }],
  };
  h.retarget({
    ownSoloConversation: true,
    requireMention: true,
    session: {
      ...h.session,
      viewer: "viewer",
      channels: { ...h.session.channels, list: () => channelList },
      channelWrites: {
        refreshMembership: async () => ({
          id: "channel",
          members: [first.pubkey],
        }),
        addAgents: vi.fn(),
      },
      agentActivity: {
        activate: () => () => {},
        snapshot: () => activity,
        subscribe: () => () => {},
      },
    } as unknown as RelaySession,
  });
  act(() => {
    h.commands().insertMention(first);
    h.commands().insertText("Follow up");
  });
  // The library reloads and, for now, no longer lists the tagged agent.
  h.setLibrary([]);
  h.submit();
  await screen.findByRole("region", { name: "Queued follow-ups" });
  expect(h.messages.send).not.toHaveBeenCalled();
});

it.each([
  "available",
  "archived",
  "readOnly",
  "removed",
  "converted",
  "compacting",
] as const)(
  "revalidates a queued Solo follow-up when the chat is %s at completion",
  async (mode) => {
    localStorage.setItem("buzz-follow-up-behavior.v1", "queue");
    const agents = mode === "compacting" ? sessionAgents("channel") : undefined;
    const h = mount({}, undefined, undefined, agents);
    h.setLibrary([{ pubkey: first.pubkey, name: "Honey" }]);
    const listeners = new Set<() => void>();
    let state = "working";
    let members = [first.pubkey];
    let activity = snapshot();
    const channel = {
      id: "channel",
      channelType: "solo",
      creator: "viewer",
      archived: false,
      readOnly: false,
    };
    // A store snapshot keeps its identity until the store changes.
    const channelList = { status: "ready", channels: [channel] };
    h.retarget({
      ownSoloConversation: true,
      requireMention: true,
      session: {
        ...h.session,
        viewer: "viewer",
        channels: {
          ...h.session.channels,
          list: () => channelList,
        },
        channelWrites: {
          refreshMembership: async () => ({
            id: "channel",
            members,
          }),
          addAgents: vi.fn(),
        },
        agentActivity: {
          activate: () => () => {},
          snapshot: () => activity,
          subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      } as unknown as RelaySession,
    });
    function snapshot() {
      return {
        status: "unavailable",
        records: [],
        turns: [],
        typing: [],
        local: [
          {
            agent: first.pubkey,
            channelId: "channel",
            messageId: "previous",
            state,
            scope: "scope",
            threadRootId: "",
            startedAt: 1,
          },
        ],
      };
    }
    act(() => {
      h.commands().insertMention(first);
      h.commands().insertText("Follow up");
    });
    h.submit();
    await screen.findByRole("region", { name: "Queued follow-ups" });
    expect(h.messages.send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toBeVisible();
    h.fill("Keep typing");
    if (mode === "compacting") {
      act(() => agents?.setSessionState("compacting"));
      expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    }
    if (mode === "removed") members = [];
    else if (mode === "converted") {
      channel.channelType = "group";
      h.retarget({ ownSoloConversation: false });
    } else if (mode !== "available" && mode !== "compacting")
      channel[mode] = true;
    act(() => {
      state = "done";
      activity = snapshot();
      for (const listener of listeners) listener();
    });
    if (mode !== "available") {
      await screen.findByText(
        mode === "compacting"
          ? "Wait for compaction to finish, or interrupt it."
          : mode === "removed"
            ? "A queued recipient is no longer a member of this chat."
            : mode === "converted"
              ? "This Solo chat or its recipients are no longer available."
              : "This chat is no longer available for sending.",
      );
      expect(h.messages.send).not.toHaveBeenCalled();
      expect(
        screen.getByRole("region", { name: "Queued follow-ups" }),
      ).toContainElement(
        screen.getByRole("button", { name: "@Honey Follow up" }),
      );
      if (mode === "compacting") {
        act(() => agents?.setSessionState("idle"));
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
        expect(h.input()).toHaveValue("Keep typing");
        return;
      }
      fireEvent.click(
        screen.getByRole("button", { name: "Remove queued message" }),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("region", { name: "Queued follow-ups" }),
        ).toBeNull(),
      );
      expect(h.messages.send).not.toHaveBeenCalled();
      return;
    }
    await waitFor(() =>
      expect(h.messages.send).toHaveBeenCalledWith(
        "channel",
        "@Honey Follow up",
        [first.pubkey],
        [],
        expect.objectContaining({ key: expect.stringMatching(/^follow-up:/) }),
        [],
        {},
      ),
    );
    expect(h.input()).toHaveValue("Keep typing");
    expect(
      screen.queryByRole("region", { name: "Queued follow-ups" }),
    ).toBeNull();
  },
);

it("withholds recording tools while a message edit cannot take attachments", async () => {
  const empty: readonly never[] = [];
  const tools: readonly Contribution<ComposerTool>[] = [
    {
      id: "capture",
      key: "test/capture",
      pluginId: "test",
      revision: "1",
      title: "Capture",
      component: ({ capture }) =>
        capture ? <button type="button">Start recording</button> : null,
    },
  ];
  const extensions = {
    tools: { snapshot: () => tools, subscribe: () => () => {} },
    inline: { snapshot: () => empty, subscribe: () => () => {} },
    completions: { snapshot: () => empty, subscribe: () => () => {} },
  };
  const h = await mountUploadComposer({ editable: true, extensions });
  h.unmount();
  const viewer = h.owner.session.viewer;
  if (!viewer) throw new Error("Expected upload viewer");
  const view = render(
    <MessageComposer
      session={h.owner.session}
      scope={h.scope}
      channelId="channel"
      channelName="General"
      extensions={extensions}
      editMessages={[editableMessage({ authorId: viewer })]}
    />,
    { wrapper: ToastProvider },
  );
  const input = within(view.container).getByRole("textbox");
  expect(screen.getByRole("button", { name: "Start recording" })).toBeVisible();
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input).toHaveAccessibleName("Edit message");
  expect(screen.queryByRole("button", { name: "Start recording" })).toBeNull();
  fireEvent.click(
    within(view.container).getByRole("button", { name: "Cancel edit" }),
  );
  expect(screen.getByRole("button", { name: "Start recording" })).toBeVisible();
});

it.each([true, false])(
  "Solo human addressing is explicit for owner=%s and never enrolls outsiders",
  async (owner) => {
    const h = mount();
    const human = { pubkey: "e".repeat(64), name: "Teammate" };
    const channel = {
      id: "channel",
      name: "Work",
      channelType: "solo" as const,
      members: [first.pubkey, human.pubkey],
    };
    const list = { status: "ready" as const, channels: [channel] };
    const refreshMembership = vi.fn(async () => channel);
    const addAgents = vi.fn();
    const session = {
      ...h.session,
      channels: { list: () => list, subscribeList: () => () => {} },
      channelWrites: { refreshMembership, addAgents },
    } as unknown as RelaySession;
    h.setLibrary([first]);
    h.retarget({ session, soloConversation: true, ownSoloConversation: owner });
    act(() => h.commands().insertMention(human));
    h.submit();
    await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
    expect(h.messages.send.mock.calls[0]?.[2]).toEqual([human.pubkey]);
    expect(addAgents).not.toHaveBeenCalled();
    // Previously selected human loses membership before the fresh send check.
    act(() => h.commands().insertMention(human));
    channel.members = [first.pubkey];
    h.submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already in this chat",
    );
    expect(h.messages.send).toHaveBeenCalledOnce();
    expect(addAgents).not.toHaveBeenCalled();
  },
);

it("recovers an uploaded follow-up instead of queuing it after its chat disappeared", async () => {
  localStorage.setItem("buzz-follow-up-behavior.v1", "queue");
  const h = mount();
  h.setLibrary([{ pubkey: first.pubkey, name: "Honey" }]);
  const gate = deferred<ReturnType<typeof uploadDescriptor>>();
  const upload = vi.fn(() => gate.promise);
  let present = true;
  const activity = { status: "unavailable", local: [], turns: [], typing: [] };
  // Store snapshots keep their identity until the store changes.
  const presentList = {
    status: "ready",
    channels: [{ id: "channel", channelType: "solo", creator: "viewer" }],
  };
  const absentList = { status: "ready", channels: [] };
  h.retarget({
    ownSoloConversation: true,
    requireMention: true,
    session: {
      ...h.session,
      viewer: "viewer",
      attachments: { upload },
      channels: {
        ...h.session.channels,
        list: () => (present ? presentList : absentList),
      },
      channelWrites: {
        refreshMembership: async () => ({
          id: "channel",
          members: [first.pubkey],
        }),
        addAgents: vi.fn(),
      },
      agentActivity: {
        activate: () => () => {},
        subscribe: () => () => {},
        snapshot: () => activity,
      },
    } as unknown as RelaySession,
  });
  act(() => {
    h.commands().insertMention(first);
    h.commands().insertText("Follow up with attachment");
  });
  fireEvent.change(screen.getByLabelText("Choose attachments"), {
    target: {
      files: [new NodeFile(["notes"], "notes.txt", { type: "text/plain" })],
    },
  });
  h.submit();
  await waitFor(() => expect(upload).toHaveBeenCalledOnce());
  // Removal has already happened when background publication reaches the queue.
  present = false;
  await act(async () => gate.resolve(uploadDescriptor()));
  await waitFor(() =>
    expect(h.input()).toHaveValue("@Honey Follow up with attachment"),
  );
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("region", { name: "Queued follow-ups" }),
  ).toBeNull();
  expect(h.input()).toHaveValue("@Honey Follow up with attachment");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Remove notes.txt" }),
    ).toBeVisible(),
  );
});

it("replaces recipients atomically while preserving prose, selection and undo", async () => {
  const h = mount();
  const replacement = { ...second, name: "Mary Jane" };
  h.fill("Before prose after");
  act(() => {
    h.input().setSelectionRange(7, 7);
    h.commands().insertMention(first);
  });
  expect(h.input()).toHaveValue("Before @Honey prose after");
  act(() => {
    h.input().setSelectionRange(16, 21);
    expect(h.commands().replaceRecipients([replacement, replacement])).toBe(
      true,
    );
  });
  expect(h.input()).toHaveValue("@Mary Jane Before prose after");
  expect(h.commands().recipients.map((person) => person.pubkey)).toEqual([
    second.pubkey,
  ]);
  const selected = h
    .input()
    .value.slice(h.input().selectionStart, h.input().selectionEnd);
  expect(selected).toBe("ose a");
  act(() => h.input().undo(false));
  expect(h.input()).toHaveValue("Before @Honey prose after");
  expect(h.commands().recipients.map((person) => person.pubkey)).toEqual([
    first.pubkey,
  ]);
  act(() => expect(h.commands().replaceRecipients([])).toBe(true));
  expect(h.input()).toHaveValue("Before prose after");
  h.submit();
  await waitFor(() => expect(h.messages.send).toHaveBeenCalled());
  expect(h.messages.send.mock.calls[0]?.[2]).toEqual([]);
});

it("rejects recipient replacement atomically for invalid and unavailable identities", () => {
  const h = mount({ inviteAgents: true });
  h.fill("Keep prose");
  act(() => h.commands().insertMention(first));
  const before = h.input().value;
  for (const recipients of [
    [second, { pubkey: "c".repeat(64), name: "Missing" }],
    [{ pubkey: "bad", name: "Invalid" }],
    [{ ...second, name: "" }],
  ]) {
    act(() => expect(h.commands().replaceRecipients(recipients)).toBe(false));
    expect(h.input()).toHaveValue(before);
  }
});

it.each(["disabled", "retarget", "unmount"])(
  "revokes replacement commands after %s",
  (transition) => {
    const h = mount();
    const replace = h.commands().replaceRecipients;
    const guarded = h.commands().replaceRecipientsIfEmpty;
    if (transition === "disabled") h.retarget({ disabled: true });
    else if (transition === "retarget") h.retarget({ channelId: "other" });
    else h.unmount();
    act(() => expect(replace([second])).toBe(false));
    act(() => expect(guarded?.([second])).toBe(false));
  },
);

it("rejects replacement while editing a sent message and when the draft would exceed its length limit", () => {
  const h = mount({}, undefined, first.pubkey);
  h.setRows([editableMessage()]);
  fireEvent.keyDown(h.input(), { key: "ArrowUp" });
  const edit = h.input().value;
  act(() => expect(h.commands().replaceRecipients([second])).toBe(false));
  expect(h.input()).toHaveValue(edit);
  fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
  h.fill("x".repeat(16000));
  act(() => expect(h.commands().replaceRecipients([first])).toBe(false));
  expect(h.input()).toHaveValue("x".repeat(16000));
});

it("keeps automatic recipient replacements out of recent mention ranking", () => {
  const h = mount();
  act(() => h.commands().insertMention(first));
  const before = [...(mentionHistory(h.session, "channel") ?? [])];
  expect(before).toEqual([[first.pubkey, 1]]);
  act(() => expect(h.commands().replaceRecipients([second])).toBe(true));
  expect([...(mentionHistory(h.session, "channel") ?? [])]).toEqual(before);
});

it("previews a picked GIF while preserving its source through undo and send", async () => {
  const { h, enable } = await mountGifComposer();
  const source = "![Party](https://emoji.test/party.gif)";
  h.fill(source);
  expect(within(h.input()).getByRole("img", { name: "Party" })).toHaveAttribute(
    "src",
    "https://emoji.test/party.gif",
  );
  expect(h.input()).toHaveValue(source);
  expect(h.input()).not.toHaveTextContent(source);
  await h.user.keyboard("{Control>}z{/Control}");
  expect(h.input()).toHaveValue("");
  await h.user.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
  expect(within(h.input()).getByRole("img", { name: "Party" })).toBeVisible();
  await enable(false);
  expect(h.input().querySelector("[data-gif-preview]")).toBeNull();
  expect(h.input()).toHaveTextContent(source);
  expect(h.input().querySelector('[contenteditable="false"]')).toBeNull();
  expect(h.input()).toHaveValue(source);
  await enable(true);
  expect(within(h.input()).getByRole("img", { name: "Party" })).toBeVisible();
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    source,
    [],
    [],
  );
});

it("preserves source when a GIF preview adopts a custom emoji token", async () => {
  const { h } = await mountGifComposer();
  h.setEmoji([{ shortcode: "party", url: "https://emoji.test/party.png" }]);
  const source = "![:party:](https://emoji.test/party.gif)";
  h.fill(source.slice(0, -1));
  expect(within(h.input()).getByRole("img", { name: ":party:" })).toBeVisible();
  await h.user.keyboard(")");
  expect(h.input()).toHaveValue(source);
  expect(h.input().querySelector("[data-gif-preview]")).not.toBeNull();
});

it.each([
  "`![Party](https://emoji.test/party.gif)`",
  "```\n![Party](https://emoji.test/party.gif)\n```",
  "![Party](javascript:party.gif)",
])("keeps literal or unsafe GIF source as text: %s", async (source) => {
  const { h } = await mountGifComposer();
  h.fill(source);
  expect(h.input().querySelector("[data-gif-preview]")).toBeNull();
});

async function mountGifComposer() {
  const root = new Context();
  const runtime = new PluginRuntime(root, async () => emojiPlugin);
  const service = new ConversationService(root);
  onTestFinished(async () => {
    await runtime.dispose();
    await root.fiber.dispose();
  });
  const plugin = {
    manifest: { id: "buzz.emoji", name: "Emoji", apiVersion: 1 as const },
    enabled: true,
    source: "external" as const,
    revision: "one",
    previous: null,
    reloadable: true,
    error: null,
  };
  const enable = async (enabled: boolean) => {
    await act(async () => {
      runtime.reconcile(enabled ? [plugin] : []);
      await vi.waitFor(() =>
        expect(service.tools.snapshot()).toHaveLength(enabled ? 1 : 0),
      );
    });
  };
  await enable(true);
  const h = mount({ extensions: service });
  return { h, enable };
}

it("guards automatic recipient changes using the current draft prose", () => {
  const h = mount();
  const replace = h.commands().replaceRecipientsIfEmpty;
  act(() => h.commands().insertMention(first));
  act(() => expect(replace?.([second])).toBe(true));
  expect(h.commands().recipients.map((person) => person.pubkey)).toEqual([
    second.pubkey,
  ]);
  h.fill("Written draft");
  act(() => h.commands().insertMention(first));
  const before = h.input().value;
  act(() => expect(replace?.([second])).toBe(false));
  expect(h.input()).toHaveValue(before);
  expect(h.commands().recipients.map((person) => person.pubkey)).toEqual([
    first.pubkey,
  ]);
  act(() => expect(h.commands().replaceRecipients([second])).toBe(true));
  expect(h.input().value).toContain("Written draft");
  h.fill(" \n ");
  act(() => expect(replace?.([second])).toBe(true));
});

/** A mention provider the test publishes for, over the real `@` syntax. */
function mountPendingMention(
  options: Partial<MessageComposerProps> = {},
  agents?: Agents,
) {
  const publishes: ComposerCompletionProps["publish"][] = [];
  function Completion({ publish }: ComposerCompletionProps) {
    useLayoutEffect(() => {
      publishes.push(publish);
    }, [publish]);
    return null;
  }
  const completions: readonly Contribution<ComposerCompletion>[] = [
    {
      id: "mentions",
      key: "buzz.mentions/mentions",
      pluginId: "buzz.mentions",
      revision: "1",
      title: "Mention",
      match: ({ text, start }) => mentionQuery(text, start),
      component: Completion,
    },
  ];
  const empty: [] = [];
  const none = { snapshot: () => empty, subscribe: () => () => {} };
  const h = mount(
    {
      ...options,
      extensions: {
        tools: none,
        inline: none,
        completions: { snapshot: () => completions, subscribe: () => () => {} },
      },
    },
    undefined,
    undefined,
    agents,
  );
  const resolve = vi.fn<CompletionPending["resolve"]>();
  const publish = () => {
    const publish = publishes.at(-1);
    if (!publish) throw new Error("No mention query observed");
    return publish;
  };
  return {
    ...h,
    resolve,
    /** How many `@` queries the provider has been mounted for. */
    queries: () => publishes.length,
    publish,
    /** Type `@name`, publish an undecided result for it, then type Space.
     * Returns the keydown's default-prevented state inverted: false when held. */
    hold(name: string, outcome: Promise<CompletionResolution>) {
      resolve.mockImplementation(() => outcome);
      h.fill(`@${name}`);
      act(() => {
        publish()({ items: [], spacePending: { name, resolve } });
      });
      return fireEvent.keyDown(h.input(), { key: " " });
    },
    chip: (name: string) =>
      within(h.input()).queryByRole("img", {
        name: `Resolving mention ${name}`,
      }),
  };
}

it("holds an undecided name on Space, then settles it into the recipient without reopening the chooser", async () => {
  const h = mountPendingMention();
  h.setProfiles(new Map([[first.pubkey, { name: "Honey" }]]));
  const outcome = deferred<MentionRecipient | null>();
  try {
    expect(h.hold("honey", outcome.promise)).toBe(false);
    expect(h.input()).toHaveValue("@honey ");
    expect(h.chip("honey")).toHaveAttribute("aria-busy", "true");
    expect(
      screen.queryByRole("region", { name: "Explicit mentions" }),
    ).toBeNull();
    expect(h.resolve).toHaveBeenCalledOnce();
    // The chip's `@` is not an open query: no provider mounts for "honey ".
    const queries = h.queries();
    await act(async () => outcome.resolve(first));
    expect(h.input()).toHaveValue("@Honey ");
    expect(h.chip("honey")).toBeNull();
    expect(
      within(
        screen.getByRole("region", { name: "Explicit mentions" }),
      ).getAllByRole("button"),
    ).toHaveLength(1);
    expect(h.queries()).toBe(queries);
    h.submit();
    expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
      "channel",
      "@Honey ",
      [first.pubkey],
      [],
    );
  } finally {
    outcome.resolve(null);
  }
});

it("leaves Space literal beside a loaded longer member name and selects that name on the next Space", async () => {
  // The real chooser over the real `@` syntax, with the directory read held:
  // `Mira Example` continues `mira` whatever the read finds, so the first
  // Space is prose, not a pending chip, and the query stays open for the word
  // that completes the name.
  const completions: readonly Contribution<ComposerCompletion>[] = [
    {
      id: "mentions",
      key: "buzz.mentions/mentions",
      pluginId: "buzz.mentions",
      revision: "1",
      title: "Mention",
      match: ({ text, start }) => mentionQuery(text, start),
      component: MentionCompletion,
    },
  ];
  const empty: [] = [];
  const none = { snapshot: () => empty, subscribe: () => () => {} };
  const h = mount({
    extensions: {
      tools: none,
      inline: none,
      completions: { snapshot: () => completions, subscribe: () => () => {} },
    },
  });
  const people = vi.fn(() => new Promise<never>(() => {}));
  h.retarget({
    session: {
      ...h.session,
      channels: { ...h.session.channels, ensureList: () => {} },
      directMessages: { people },
    } as unknown as RelaySession,
  });
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Mira Example" }],
      [second.pubkey, { name: "Other Member" }],
    ]),
  );
  const chip = () =>
    within(h.input()).queryByRole("img", { name: /^Resolving mention / });
  await h.user.type(h.input(), "@mira");
  // The chooser has published for `mira` once its row shows.
  await screen.findByRole("option", { name: /Mira Example/ });
  await h.user.keyboard(" ");
  expect(h.input()).toHaveValue("@mira ");
  expect(chip()).toBeNull();
  await h.user.keyboard("Example hi");
  expect(h.input()).toHaveValue("@Mira Example hi");
  expect(chip()).toBeNull();
  expect(
    within(
      screen.getByRole("region", { name: "Explicit mentions" }),
    ).getAllByRole("button"),
  ).toHaveLength(1);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "@Mira Example hi",
    [first.pubkey],
    [],
  );
});

/** The real chooser over the real `@` syntax with `Mira Example` only in the
 * directory and every member named, so the first Space is undecided. Each
 * `people` read is held until the test releases it. */
function mountDirectoryMention(
  options: { agents?: Agents; channel?: object; session?: object } = {},
) {
  const completions: readonly Contribution<ComposerCompletion>[] = [
    {
      id: "mentions",
      key: "buzz.mentions/mentions",
      pluginId: "buzz.mentions",
      revision: "1",
      title: "Mention",
      match: ({ text, start }) => mentionQuery(text, start),
      component: MentionCompletion,
    },
  ];
  const empty: [] = [];
  const none = { snapshot: () => empty, subscribe: () => () => {} };
  const h = mount(
    {
      extensions: {
        tools: none,
        inline: none,
        completions: {
          snapshot: () => completions,
          subscribe: () => () => {},
        },
      },
    },
    undefined,
    undefined,
    options.agents,
  );
  const list = {
    status: "ready",
    channels: h.session.channels
      .list()
      .channels.map((channel) => ({ ...channel, ...options.channel })),
  };
  type Page = { people: readonly MentionRecipient[]; hasMore: boolean };
  const reads: ((page: Page) => void)[] = [];
  const people = vi.fn(
    (query: string) =>
      new Promise<Page>((resolve) => {
        reads.push(resolve);
        void query;
      }),
  );
  h.retarget({
    session: {
      ...h.session,
      channels: {
        ...h.session.channels,
        list: () => list,
        ensureList: () => {},
      },
      directMessages: { people },
      memberAdditions: { add: vi.fn() },
      ...options.session,
    } as unknown as RelaySession,
  });
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Other Member" }],
      [second.pubkey, { name: "Another Member" }],
    ]),
  );
  return {
    ...h,
    people,
    /** Answer every read made so far with `page`. */
    release: (page: Page) =>
      act(async () => {
        for (const read of reads.splice(0)) read(page);
      }),
    chip: (name: string) =>
      within(h.input()).queryByRole("img", {
        name: `Resolving mention ${name}`,
      }),
    recipients: () =>
      within(
        screen.getByRole("region", { name: "Explicit mentions" }),
      ).getAllByRole("button"),
    /** Type `@mira`, wait for the chooser to publish, then type Space. */
    async holdMira() {
      await h.user.type(h.input(), "@mira");
      await screen.findByText("Searching community…");
      await h.user.keyboard(" ");
      expect(h.input()).toHaveValue("@mira ");
      expect(this.chip("mira")).toHaveAttribute("aria-busy", "true");
    },
  };
}
const mira = { pubkey: "c".repeat(64), name: "Mira Example" };

/** The owner's agent in another community, as `Agents.joinable()` offers it. */
function elsewhereAgent(agent: MentionRecipient) {
  const snapshot = { agents: [] };
  const types: never[] = [];
  const joinable = [
    { key: agent.pubkey, ...agent, relay: "wss://oss.example.com" },
  ];
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    find: () => undefined,
    types: () => types,
    joinable: () => joinable,
    join: vi.fn(),
  } as unknown as Agents;
}

it("returns a pending mention to prose when a member shares its name with the owner's agent from another community", async () => {
  // The chooser counts the other community's agent as a local namesake, so
  // Space holds a chip; the resolver must decide over the same set.
  const h = mountDirectoryMention({
    agents: elsewhereAgent({ pubkey: "e".repeat(64), name: "Mira" }),
    channel: { channelType: "stream" },
  });
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Mira" }],
      [second.pubkey, { name: "Another Member" }],
    ]),
  );
  await h.user.type(h.input(), "@mira");
  await screen.findByRole("option", { name: /In oss\.example\.com/ });
  await h.user.keyboard(" ");
  await waitFor(() => expect(h.people).toHaveBeenCalled());
  await h.release({ people: [], hasMore: false });
  await waitFor(() => expect(h.chip("mira")).toBeNull());
  expect(h.input()).toHaveValue("@mira ");
  expect(
    screen.queryByRole("region", { name: "Explicit mentions" }),
  ).toBeNull();
  h.submit();
  await act(async () => {});
  expect(h.messages.send).toHaveBeenCalledOnce();
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([]);
});

it("settles a pending mention into the owner's agent from another community that is archived here, as Tab would", async () => {
  const rocket = { pubkey: "e".repeat(64), name: "Rocket" };
  const archives = { status: "ready" as const, archived: [rocket.pubkey] };
  const h = mountDirectoryMention({
    agents: elsewhereAgent(rocket),
    channel: { channelType: "stream" },
    session: {
      archives: {
        snapshot: () => archives,
        subscribe: () => () => {},
        state: (key: string) =>
          key === rocket.pubkey ? "archived" : "not-archived",
        ensure: async () => {},
      },
    },
  });
  // A member's name still unknown keeps the chooser from deciding Space.
  h.setProfiles(new Map([[first.pubkey, { name: "Other Member" }]]));
  await h.user.type(h.input(), "@rocket");
  await screen.findByRole("option", { name: /Rocket/ });
  await h.user.keyboard(" ");
  await waitFor(() => expect(h.people).toHaveBeenCalled());
  await h.release({ people: [], hasMore: false });
  await waitFor(() => expect(h.input()).toHaveValue("@Rocket "));
  expect(h.chip("rocket")).toBeNull();
  expect(h.recipients()).toHaveLength(1);
  h.submit();
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    /Bring Rocket into/,
  );
  expect(h.messages.send).not.toHaveBeenCalled();
});

it("extends a pending chip over the typed words that complete the one longer directory name continuing it", async () => {
  const h = mountDirectoryMention();
  await h.holdMira();
  await h.user.keyboard("Example hi");
  expect(h.input()).toHaveValue("@mira Example hi");
  // The resolver reads the page at once; the chooser unmounted with the chip.
  await waitFor(() => expect(h.people).toHaveBeenCalled());
  await h.release({ people: [mira], hasMore: false });
  await waitFor(() => expect(h.input()).toHaveValue("@Mira Example hi"));
  expect(h.chip("mira")).toBeNull();
  expect(h.chip("mira Example")).toBeNull();
  expect(h.recipients()).toHaveLength(1);
  // The extended chip's `@` opened no query.
  expect(screen.queryByRole("listbox")).toBeNull();
  h.submit();
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "Mira Example is not in this channel.",
  );
  fireEvent.click(
    screen.getByRole("button", { name: /^(Do nothing|Send anyway)$/ }),
  );
  await act(async () => {});
  expect(h.messages.send).toHaveBeenCalledOnce();
  expect(h.messages.send.mock.calls[0]?.slice(0, 3)).toEqual([
    "channel",
    "@Mira Example hi",
    [],
  ]);
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([mira.pubkey]);
});

it("keeps the separator typed after the words a pending chip extends over, so later text does not join the name", async () => {
  // The page lands while the draft ends at `Example `: the remainder that
  // spells the name is `Example`, not `Example ` (`normalizeName` trims, so
  // both spell it), and the Space stays outside the chip.
  const h = mountDirectoryMention();
  await h.holdMira();
  await h.user.keyboard("Example ");
  expect(h.input()).toHaveValue("@mira Example ");
  await waitFor(() => expect(h.people).toHaveBeenCalled());
  await h.release({ people: [mira], hasMore: false });
  await waitFor(() => expect(h.input()).toHaveValue("@Mira Example "));
  expect(h.chip("mira")).toBeNull();
  expect(h.recipients()).toHaveLength(1);
  await h.user.keyboard("hi");
  expect(h.input()).toHaveValue("@Mira Example hi");
  expect(h.recipients()).toHaveLength(1);
  h.submit();
  fireEvent.click(
    screen.getByRole("button", { name: /^(Do nothing|Send anyway)$/ }),
  );
  await act(async () => {});
  expect(h.messages.send).toHaveBeenCalledOnce();
  expect(h.messages.send.mock.calls[0]?.slice(0, 3)).toEqual([
    "channel",
    "@Mira Example hi",
    [],
  ]);
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([mira.pubkey]);
});

it("selects a longer directory name on the Space that completes it when its page arrived before the first Space", async () => {
  // The slow typist: a known longer name declines the first Space outright
  // (`continuedMention`), the query stays open, and the second Space selects.
  const h = mountDirectoryMention();
  await h.user.type(h.input(), "@mira");
  await waitFor(() => expect(h.people).toHaveBeenCalledTimes(1));
  await h.release({ people: [mira], hasMore: false });
  await screen.findByRole("option", { name: /Mira Example/ });
  await h.user.keyboard(" ");
  expect(h.input()).toHaveValue("@mira ");
  expect(h.chip("mira")).toBeNull();
  // The complete page for `mira` already answers every query extending it,
  // so the name shows on each keystroke with no further read.
  await h.user.keyboard("Example hi");
  expect(h.input()).toHaveValue("@Mira Example hi");
  expect(h.recipients()).toHaveLength(1);
  expect(h.people).toHaveBeenCalledOnce();
});

it("extends a pending chip to the one longer name the typed words complete when several continue it", async () => {
  const h = mountDirectoryMention();
  const examples = { pubkey: "d".repeat(64), name: "Mira Examples" };
  await h.holdMira();
  await h.user.keyboard("Examples hi");
  await waitFor(() => expect(h.people).toHaveBeenCalled());
  await h.release({ people: [mira, examples], hasMore: false });
  await waitFor(() => expect(h.input()).toHaveValue("@Mira Examples hi"));
  expect(h.recipients()).toHaveLength(1);
  h.submit();
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "Mira Examples is not in this channel.",
  );
  fireEvent.click(
    screen.getByRole("button", { name: /^(Do nothing|Send anyway)$/ }),
  );
  await act(async () => {});
  expect(h.messages.send).toHaveBeenCalledOnce();
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([examples.pubkey]);
});

it("returns the whole span to prose when the name a chip extended into is itself continued by a name the words do not complete", async () => {
  // `Mira Example Jr` continues `Mira Example` as that continued `mira`: the
  // chip extends once, the second resolution answers `continued` again over
  // the same page, and ` hi` completes nothing, so what was typed comes back.
  const h = mountDirectoryMention();
  const junior = { pubkey: "d".repeat(64), name: "Mira Example Jr" };
  await h.holdMira();
  await h.user.keyboard("Example hi");
  await waitFor(() => expect(h.people).toHaveBeenCalled());
  await h.release({ people: [mira, junior], hasMore: false });
  await waitFor(() => expect(h.chip("mira")).toBeNull());
  expect(h.chip("mira Example")).toBeNull();
  expect(h.input()).toHaveValue("@mira Example hi");
  expect(h.input().querySelector("[data-source]")).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Explicit mentions" }),
  ).toBeNull();
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "@mira Example hi",
    [],
    [],
  );
});

it.each([
  { case: "stop mid-name", typed: "Exam", text: "@mira Exam" },
  {
    case: "complete no longer name",
    typed: "Other hi",
    text: "@mira Other hi",
  },
])(
  "returns a pending chip to prose when the words typed after it $case",
  async ({ typed, text }) => {
    const h = mountDirectoryMention();
    await h.holdMira();
    await h.user.keyboard(typed);
    await waitFor(() => expect(h.people).toHaveBeenCalled());
    await h.release({ people: [mira], hasMore: false });
    await waitFor(() => expect(h.chip("mira")).toBeNull());
    expect(h.input()).toHaveValue(text);
    expect(h.input().querySelector("[data-source]")).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Explicit mentions" }),
    ).toBeNull();
  },
);

it("selects a longer directory name on the Space that completes it after its page returned a pending chip to prose mid-word", async () => {
  // The page lands while the longer name is still being typed: the chip
  // returns to text, the chooser reopens over `mira Exam`, and the complete
  // page for `mira` already answers that query, so the name shows at once
  // and the Space after `ple` selects it without another read.
  const h = mountDirectoryMention();
  await h.holdMira();
  await h.user.keyboard("Exam");
  await waitFor(() => expect(h.people).toHaveBeenCalledOnce());
  await h.release({ people: [mira], hasMore: false });
  await waitFor(() => expect(h.input()).toHaveValue("@mira Exam"));
  expect(
    within(h.input()).queryByRole("img", { name: /^Resolving mention / }),
  ).toBeNull();
  await screen.findByRole("option", { name: /Mira Example/ });
  expect(screen.queryByText("Searching community…")).toBeNull();
  await h.user.keyboard("ple ");
  expect(h.input()).toHaveValue("@Mira Example ");
  expect(h.recipients()).toHaveLength(1);
  expect(h.people).toHaveBeenCalledOnce();
  await h.user.keyboard("hi");
  h.submit();
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "Mira Example is not in this channel.",
  );
  fireEvent.click(
    screen.getByRole("button", { name: /^(Do nothing|Send anyway)$/ }),
  );
  await act(async () => {});
  expect(h.messages.send).toHaveBeenCalledOnce();
  expect(h.messages.send.mock.calls[0]?.slice(0, 3)).toEqual([
    "channel",
    "@Mira Example hi",
    [],
  ]);
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([mira.pubkey]);
});

it("selects a longer directory name on the Space that completes it after its page returned a pending chip to prose before the next word", async () => {
  const h = mountDirectoryMention();
  await h.holdMira();
  await waitFor(() => expect(h.people).toHaveBeenCalledOnce());
  await h.release({ people: [mira], hasMore: false });
  await waitFor(() => expect(h.chip("mira")).toBeNull());
  expect(h.input()).toHaveValue("@mira ");
  // `mira ` is admitted again: the page for `mira` names what continues it.
  await screen.findByRole("option", { name: /Mira Example/ });
  expect(screen.queryByText("Searching community…")).toBeNull();
  await h.user.keyboard("Example ");
  expect(h.input()).toHaveValue("@Mira Example ");
  expect(h.recipients()).toHaveLength(1);
  expect(h.people).toHaveBeenCalledOnce();
});

it("returns a pending chip to prose when the typed words changed under a composition before it could extend", async () => {
  const h = mountDirectoryMention();
  await h.holdMira();
  await h.user.keyboard("Example hi");
  await waitFor(() => expect(h.people).toHaveBeenCalled());
  act(() => fireEvent.compositionStart(h.input()));
  await h.release({ people: [mira], hasMore: false });
  // The extension is held until the composition ends.
  expect(h.chip("mira")).toHaveAttribute("aria-busy", "true");
  const after = h.input().querySelector("[data-source]")?.nextSibling;
  if (!(after instanceof Text)) throw new Error("No text after the chip");
  await act(async () => {
    // The IME commits a different word and ends the composition in one task.
    after.nodeValue = " Exemplar hi";
    fireEvent.compositionEnd(h.input());
  });
  await waitFor(() => expect(h.chip("mira")).toBeNull());
  expect(h.input()).toHaveValue("@mira Exemplar hi");
  expect(h.input().querySelector("[data-source]")).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Explicit mentions" }),
  ).toBeNull();
});

it("a send while a chip is pending waits through its extension, then asks about the outside recipient", async () => {
  const h = mountDirectoryMention();
  await h.holdMira();
  await h.user.keyboard("Example hi");
  await waitFor(() => expect(h.people).toHaveBeenCalled());
  h.submit();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled(),
  );
  expect(h.messages.send).not.toHaveBeenCalled();
  await h.release({ people: [mira], hasMore: false });
  await waitFor(() =>
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Mira Example is not in this channel.",
    ),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /^(Do nothing|Send anyway)$/ }),
  );
  await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
  expect(h.messages.send.mock.calls[0]?.slice(0, 3)).toEqual([
    "channel",
    "@Mira Example hi",
    [],
  ]);
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([mira.pubkey]);
});

it("a send while a chip is pending says its name could not be confirmed when the search finds namesakes", async () => {
  const h = mountDirectoryMention();
  await h.holdMira();
  await h.user.keyboard("hi");
  await waitFor(() => expect(h.people).toHaveBeenCalled());
  h.submit();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled(),
  );
  await h.release({
    people: [
      { pubkey: "c".repeat(64), name: "Mira" },
      { pubkey: "d".repeat(64), name: "Mira" },
    ],
    hasMore: false,
  });
  // Two people answer to the name, so neither is tagged, and the notice does
  // not claim the name matched no one.
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "@mira could not be confirmed as one person or agent. Send again to send it as text.",
    ),
  );
  expect(h.chip("mira")).toBeNull();
  expect(h.input()).toHaveValue("@mira hi");
  expect(h.messages.send).not.toHaveBeenCalled();
});

it("returns a chip to prose at the resolver's bound when the longer name it extended into never settles, and keeps the draft for a second send", async () => {
  // A scripted provider whose chained resolve does I/O that never answers:
  // the host holds it to the bound the first resolution gets.
  const h = mountPendingMention();
  const outcome = deferred<CompletionResolution>();
  const chained = vi.fn<CompletionPending["resolve"]>(
    () => new Promise<never>(() => {}),
  );
  expect(h.hold("mira", outcome.promise)).toBe(false);
  await h.user.keyboard("Example hi");
  expect(h.input()).toHaveValue("@mira Example hi");
  h.submit();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled(),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await act(async () =>
      outcome.resolve({
        continued: [{ name: "Mira Example", resolve: chained }],
      }),
    );
    expect(h.chip("mira Example")).toHaveAttribute("aria-busy", "true");
    expect(chained).toHaveBeenCalledOnce();
    expect(h.messages.send).not.toHaveBeenCalled();
    await act(async () =>
      vi.advanceTimersByTime(MENTION_RESOLVE_TIMEOUT_MS - 1),
    );
    expect(h.chip("mira Example")).toHaveAttribute("aria-busy", "true");
    expect(h.messages.send).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    // The chip returned to prose; the waiting send keeps the draft and says
    // which name it is, under the name the chip had when it settled.
    expect(h.chip("mira Example")).toBeNull();
    expect(h.messages.send).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "@mira Example could not be confirmed as one person or agent. Send again to send it as text.",
    );
    expect(h.input()).toHaveValue("@mira Example hi");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  } finally {
    vi.useRealTimers();
  }
  h.submit();
  await waitFor(() =>
    expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
      "channel",
      "@mira Example hi",
      [],
      [],
    ),
  );
  expect(h.input()).toHaveValue("");
});

it("returns a chip to prose at the bound when a provider's first resolution never settles, and keeps the draft for a second send", async () => {
  // The contract does not ask a provider to time its resolution; the host
  // holds the first link to the same bound as each longer name.
  const h = mountPendingMention();
  // The bound starts with the resolution, so the clock is faked before Space.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    expect(h.hold("mira", new Promise<never>(() => {}))).toBe(false);
    expect(h.resolve).toHaveBeenCalledOnce();
    const signal = h.resolve.mock.calls[0]?.[0];
    // Whether the chip was still pending when the provider was told to stop:
    // the bound aborts it, not the chip leaving the draft afterwards.
    let pendingAtAbort: boolean | undefined;
    signal?.addEventListener("abort", () => {
      pendingAtAbort = h.chip("mira") !== null;
    });
    expect(h.chip("mira")).toHaveAttribute("aria-busy", "true");
    await act(async () => h.submit());
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await act(async () =>
      vi.advanceTimersByTime(MENTION_RESOLVE_TIMEOUT_MS - 1),
    );
    expect(h.chip("mira")).toHaveAttribute("aria-busy", "true");
    expect(signal?.aborted).toBe(false);
    expect(h.messages.send).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    // The bound told the provider's in-flight work to stop, the chip returned
    // to prose, and the waiting send kept the draft with a notice.
    expect(pendingAtAbort).toBe(true);
    expect(h.chip("mira")).toBeNull();
    expect(h.messages.send).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "@mira could not be confirmed as one person or agent. Send again to send it as text.",
    );
    expect(h.input()).toHaveValue("@mira ");
  } finally {
    vi.useRealTimers();
  }
  h.submit();
  await waitFor(() =>
    expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
      "channel",
      "@mira ",
      [],
      [],
    ),
  );
  expect(h.input()).toHaveValue("");
});

it("removing a pending chip before the bound aborts the provider's signal and leaves no bound timer behind", async () => {
  // A provider that ignores abort must not keep the host's 8 s timer alive
  // after the chip left: the bound is cleared with the chip's signal.
  const h = mountPendingMention();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const timers = vi.getTimerCount();
    expect(h.hold("honey", new Promise<never>(() => {}))).toBe(false);
    const signal = h.resolve.mock.calls[0]?.[0];
    expect(signal?.aborted).toBe(false);
    // Typing leaves the editor a short timer of its own; past it, the bound
    // is the one timer the chip added.
    act(() => vi.advanceTimersByTime(100));
    expect(vi.getTimerCount()).toBe(timers + 1);
    act(() => h.input().undo(false));
    expect(h.input()).toHaveValue("@honey");
    expect(h.chip("honey")).toBeNull();
    expect(signal?.aborted).toBe(true);
    // The undo leaves the editor's short timer again; past it, nothing: the
    // bound went with the chip's signal rather than running on to 8 s.
    act(() => vi.advanceTimersByTime(100));
    expect(vi.getTimerCount()).toBe(timers);
  } finally {
    vi.useRealTimers();
  }
});

it("undo after an extended chip settled first removes the words typed after it, then leaves the typed `@mira`", async () => {
  const h = mountDirectoryMention();
  await h.holdMira();
  await h.user.keyboard("Example hi");
  await waitFor(() => expect(h.people).toHaveBeenCalled());
  await h.release({ people: [mira], hasMore: false });
  await waitFor(() => expect(h.input()).toHaveValue("@Mira Example hi"));
  act(() => h.input().undo(false));
  expect(h.input()).toHaveValue("@Mira Example");
  expect(h.recipients()).toHaveLength(1);
  act(() => h.input().undo(false));
  expect(h.input()).toHaveValue("@mira");
  expect(h.chip("mira")).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Explicit mentions" }),
  ).toBeNull();
});

it("returns a pending mention to prose when its recipient is not admitted at settle", async () => {
  const h = mountPendingMention();
  const outcome = deferred<MentionRecipient | null>();
  try {
    h.hold("eve", outcome.promise);
    // The destination became a Solo chat meanwhile: outsiders are not admitted.
    Object.assign(h.session, {
      channels: { list: () => soloList, subscribeList: () => () => {} },
    });
    await act(async () =>
      outcome.resolve({ pubkey: "e".repeat(64), name: "Eve" }),
    );
    expect(h.input()).toHaveValue("@eve ");
    expect(h.chip("eve")).toBeNull();
    expect(h.input().querySelector("[data-source]")).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Explicit mentions" }),
    ).toBeNull();
  } finally {
    outcome.resolve(null);
  }
});

it("returns a pending mention to prose when its resolution is not a well-formed recipient", async () => {
  // The resolution is a provider's answer: the same shape check a picked
  // mention gets, so a name-less object never becomes an `@undefined` chip.
  const h = mountPendingMention();
  h.setProfiles(new Map([[first.pubkey, { name: "Honey" }]]));
  const outcome = deferred<MentionRecipient | null>();
  try {
    h.hold("honey", outcome.promise);
    await act(async () =>
      outcome.resolve({
        pubkey: first.pubkey,
        name: undefined,
      } as unknown as MentionRecipient),
    );
    expect(h.input()).toHaveValue("@honey ");
    expect(h.chip("honey")).toBeNull();
    expect(h.input().querySelector("[data-source]")).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Explicit mentions" }),
    ).toBeNull();
  } finally {
    outcome.resolve(null);
  }
});

/** `@honey ` held, Send pressed while it is pending. */
async function sendWhilePending(
  options: Partial<MessageComposerProps> = {},
  prepare?: (h: ReturnType<typeof mountPendingMention>) => void,
) {
  const h = mountPendingMention(options);
  h.setProfiles(new Map([[first.pubkey, { name: "Honey" }]]));
  const outcome = deferred<MentionRecipient | null>();
  h.hold("honey", outcome.promise);
  prepare?.(h);
  h.submit();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled(),
  );
  expect(h.messages.send).not.toHaveBeenCalled();
  return { ...h, outcome };
}

it.each([
  { recipient: first, waitsForChoices: false, label: "the same recipient" },
  { recipient: second, waitsForChoices: true, label: "a different recipient" },
])(
  "captures coherent Solo choices after a pending mention resolves to $label across a storage update",
  async ({ recipient, waitsForChoices }) => {
    const key = "solo:model-picks:solo:new-draft";
    const initial = {
      [recipient.pubkey]: { model: "deep", type: "test/agent" },
    };
    const newer = { [recipient.pubkey]: { model: "fast", type: "test/agent" } };
    writeView("scope", key, initial);
    const submit = vi.fn();
    const h = mountPendingMention(
      {
        ownSoloConversation: true,
        defaultMention: first,
        requireMention: true,
        submission: {
          draftKey: "solo:new-draft",
          modelPicksKey: key,
          locked: false,
          disabled: false,
          submit,
        },
      },
      sessionAgents(
        "channel",
        [
          { id: "fast", label: "Fast", efforts: [] },
          { id: "deep", label: "Deep", efforts: [] },
        ],
        [first.pubkey, second.pubkey],
      ),
    );
    h.setLibrary([first, second]);
    h.setProfiles(
      new Map(
        [first, second].map(({ pubkey }) => [
          pubkey,
          { name: "Honey", isAgent: true },
        ]),
      ),
    );
    const outcome = deferred<MentionRecipient | null>();
    try {
      h.hold("honey", outcome.promise);
      h.submit();
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Send message" }),
        ).toBeDisabled(),
      );
      expect(submit).not.toHaveBeenCalled();
      act(() => writeView("scope", key, newer));
    } finally {
      await act(async () => outcome.resolve(recipient));
    }
    if (waitsForChoices) {
      expect(submit).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Saved model and effort choices are still loading. Try sending again shortly.",
      );
      expect(h.input()).toHaveValue("@Honey ");
      expect(readView("scope", key, null)).toEqual(newer);
      h.submit();
    }
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0]?.slice(3)).toEqual([
      { [recipient.pubkey]: { model: "fast" } },
      newer,
      JSON.stringify(newer),
    ]);
  },
);

it.each([
  { sticky: true, label: "saved choices in a shared Solo chat" },
  { sticky: false, label: "consumed next-run choices in a channel" },
])("invalidates unmounted picker state for $label", async ({ sticky }) => {
  setRememberAgentsPreference(false);
  const h = mountPendingMention(
    sticky
      ? {
          ownSoloConversation: true,
          soloConversation: true,
          requireMention: true,
        }
      : {},
    sessionAgents("channel", [
      { id: "fast", label: "Fast", efforts: [] },
      {
        id: "deep",
        label: "Deep",
        efforts: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ]),
  );
  if (sticky)
    Object.assign(h.session, {
      channels: { ...h.session.channels, list: () => soloList },
      channelWrites: {
        refreshMembership: vi.fn(async () => soloList.channels[0]),
        addAgents: vi.fn(async () => {}),
      },
    });
  h.setLibrary([first]);
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Honey", isAgent: true }],
      [second.pubkey, { name: "Sam" }],
    ]),
  );
  h.fill("question");
  act(() => h.input().replaceRecipients([first]));
  await h.user.click(
    await screen.findByRole("button", { name: /Model.*effort/ }),
  );
  const context = sticky ? "Honey in this chat" : "Honey's next run";
  await h.user.click(
    screen.getByRole("button", {
      name: `Model for ${context}`,
    }),
  );
  await h.user.click(
    await screen.findByRole("menuitemradio", { name: "Deep" }),
  );
  const effort = await screen.findByLabelText(`Effort for ${context}`);
  effort.focus();
  await h.user.keyboard("{End}{Escape}");
  if (sticky) {
    act(() => h.input().removeRecipient(first.pubkey));
    h.fill("question");
    expect(h.input()).toHaveValue("question");
  } else {
    h.submit();
    await waitFor(() => expect(h.input()).toHaveValue(""));
    expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual({
      [first.pubkey]: { model: "deep", effort: "high" },
    });
  }
  expect(screen.queryByRole("button", { name: /Model.*effort/ })).toBeNull();
  const outcome = deferred<MentionRecipient | null>();
  try {
    h.hold("honey", outcome.promise);
    h.submit();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled(),
    );
  } finally {
    await act(async () => outcome.resolve(first));
  }
  if (sticky) {
    expect(h.messages.send).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Saved model and effort choices are still loading. Try sending again shortly.",
    );
    expect(readView("scope", "solo:model-picks:channel", null)).toEqual({
      [first.pubkey]: { model: "deep", effort: "high", type: "test/agent" },
    });
    h.submit();
    await waitFor(() => expect(h.messages.send).toHaveBeenCalledOnce());
    expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual({
      [first.pubkey]: { model: "deep", effort: "high" },
    });
  } else {
    await waitFor(() => expect(h.messages.send).toHaveBeenCalledTimes(2));
    expect(h.messages.send).toHaveBeenLastCalledWith(
      "channel",
      "@Honey ",
      [first.pubkey],
      [],
    );
  }
});

it("sending while a mention is pending waits for it, then sends the recipient", async () => {
  const h = await sendWhilePending();
  await act(async () => h.outcome.resolve(first));
  await waitFor(() =>
    expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
      "channel",
      "@Honey ",
      [first.pubkey],
      [],
    ),
  );
});

it("sending while a mention is pending keeps the draft when it returns to prose, and the next send sends the text", async () => {
  const h = await sendWhilePending();
  await act(async () => h.outcome.resolve(null));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "@honey could not be confirmed as one person or agent. Send again to send it as text.",
  );
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(h.input()).toHaveValue("@honey ");
  expect(h.chip("honey")).toBeNull();
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  h.submit();
  await waitFor(() =>
    expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
      "channel",
      "@honey ",
      [],
      [],
    ),
  );
  expect(h.input()).toHaveValue("");
  expect(screen.queryByRole("alert")).toBeNull();
});

// The resolver found a recipient, but the host would not tag it: the alert
// says why, not that the name matched no one.
it.each([
  {
    refusal: "32 recipients are already tagged",
    resolution: first,
    prepare: (h: ReturnType<typeof mountPendingMention>) =>
      act(() => {
        h.input().insertText(
          "",
          Array.from({ length: 32 }, () => second),
        );
      }),
    alert:
      "@honey could not be tagged: a message can tag at most 32 recipients. Send again to send it as text.",
  },
  {
    refusal: "the recipient is not admitted here",
    resolution: { pubkey: "e".repeat(64), name: "Eve" },
    // The destination became a Solo chat meanwhile: outsiders are not admitted.
    prepare: (h: ReturnType<typeof mountPendingMention>) =>
      Object.assign(h.session, {
        channels: { list: () => soloList, subscribeList: () => () => {} },
      }),
    alert: "@honey could not be tagged here. Send again to send it as text.",
  },
  {
    refusal: "its current name would overrun the length limit",
    resolution: { pubkey: first.pubkey, name: "H".repeat(16000) },
    prepare: undefined,
    alert:
      "@honey could not be tagged: the message would be too long. Send again to send it as text.",
  },
])(
  "sending while a mention is pending says why when it resolves but $refusal",
  async ({ resolution, prepare, alert }) => {
    const h = await sendWhilePending({}, prepare);
    await act(async () => h.outcome.resolve(resolution));
    expect(screen.getByRole("alert")).toHaveTextContent(alert);
    expect(h.messages.send).not.toHaveBeenCalled();
    expect(h.input().value).toMatch(/^@honey /);
    expect(h.chip("honey")).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  },
);

it("sending while two mentions are pending says why each was not tagged", async () => {
  const h = mountPendingMention();
  const unmatched = deferred<MentionRecipient | null>();
  const long = deferred<MentionRecipient | null>();
  h.hold("honey", unmatched.promise);
  act(() => {
    h.input().insertText("@eve");
  });
  h.resolve.mockImplementation(() => long.promise);
  act(() => {
    h.publish()({
      items: [],
      spacePending: { name: "eve", resolve: h.resolve },
    });
  });
  fireEvent.keyDown(h.input(), { key: " " });
  expect(h.chip("eve")).not.toBeNull();
  h.submit();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled(),
  );
  await act(async () => {
    unmatched.resolve(null);
    long.resolve({ pubkey: first.pubkey, name: "H".repeat(16000) });
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "@honey could not be confirmed as one person or agent. @eve could not be tagged: the message would be too long. Send again to send them as text.",
  );
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(h.input()).toHaveValue("@honey @eve ");
});

it("sending while a mention is pending asks for a recipient when it returns to prose and one is required", async () => {
  const h = await sendWhilePending({ requireMention: true });
  await act(async () => h.outcome.resolve(null));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "@honey could not be confirmed as one person or agent. Tag a person or agent to send.",
  );
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(h.input()).toHaveValue("@honey ");
  // Untagged: Send stays focusable so its tooltip can say why.
  expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

it("asks about a settled outside agent before sending, like a chosen one", async () => {
  const h = mountPendingMention();
  h.setProfiles(new Map([[first.pubkey, { name: "Honey", isAgent: true }]]));
  const list = {
    status: "ready",
    channels: [
      { id: "channel", channelType: "stream", members: ["d".repeat(64)] },
    ],
  };
  Object.assign(h.session, {
    viewer: "d".repeat(64),
    channels: { list: () => list, subscribeList: () => () => {} },
    memberAdditions: { add: vi.fn() },
  });
  const outcome = deferred<MentionRecipient | null>();
  try {
    h.hold("honey", outcome.promise);
    await act(async () => outcome.resolve(first));
    expect(h.input()).toHaveValue("@Honey ");
    h.submit();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Honey is not in this channel. Invite them to the channel, or send without inviting them.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Do nothing" }));
    await act(async () => {});
    expect(h.messages.send).toHaveBeenCalledOnce();
    expect(h.messages.send.mock.calls[0]?.slice(0, 3)).toEqual([
      "channel",
      "@Honey ",
      [],
    ]);
    expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([first.pubkey]);
  } finally {
    outcome.resolve(null);
  }
});

it("keeps the resolver of a chip removed as its resolution landed, so redo settles it", async () => {
  const h = mountPendingMention();
  h.setProfiles(new Map([[first.pubkey, { name: "Honey" }]]));
  const landed = deferred<MentionRecipient | null>();
  const restarted = deferred<MentionRecipient | null>();
  try {
    h.hold("honey", landed.promise);
    // The resolution lands in the same tick as the undo removing its chip,
    // before the commit whose effect would have aborted it: nothing to settle.
    await act(async () => {
      landed.resolve(first);
      h.input().undo(false);
    });
    expect(h.input()).toHaveValue("@honey");
    expect(h.resolve).toHaveBeenCalledOnce();
    h.resolve.mockImplementation(() => restarted.promise);
    act(() => h.input().undo(true));
    expect(h.input()).toHaveValue("@honey ");
    expect(h.chip("honey")).toBeInTheDocument();
    expect(h.resolve).toHaveBeenCalledTimes(2);
    await act(async () => restarted.resolve(first));
    expect(h.input()).toHaveValue("@Honey ");
    expect(h.chip("honey")).toBeNull();
  } finally {
    landed.resolve(null);
    restarted.resolve(null);
  }
});

it("holds Space as pending when the publication withdrew the displayed exact match as undecided", async () => {
  const h = mountPendingMention();
  const outcome = deferred<MentionRecipient | null>();
  h.resolve.mockImplementation(() => outcome.promise);
  try {
    h.fill("@honey");
    const publish = h.publish();
    act(() => {
      publish({
        items: [{ id: first.pubkey, label: "Honey", edit: { mention: first } }],
        spaceId: first.pubkey,
      });
    });
    expect(screen.getByRole("option", { name: "Honey" })).toBeVisible();
    act(() => {
      // The display is not overruled by another recipient; the decision is
      // deferred to the resolver under the full rule.
      publish({
        items: [],
        spacePending: { name: "honey", resolve: h.resolve },
      });
      expect(fireEvent.keyDown(h.input(), { key: " " })).toBe(false);
    });
    expect(h.input()).toHaveValue("@honey ");
    expect(h.chip("honey")).toHaveAttribute("aria-busy", "true");
    expect(h.resolve).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("region", { name: "Explicit mentions" }),
    ).toBeNull();
    await act(async () => outcome.resolve(first));
    expect(h.input()).toHaveValue("@Honey ");
  } finally {
    outcome.resolve(null);
  }
});

it("waits for a settle held through a composition before sending, then sends and remembers the recipient", async () => {
  const h = mountPendingMention();
  h.setProfiles(new Map([[first.pubkey, { name: "Honey" }]]));
  const outcome = deferred<MentionRecipient | null>();
  try {
    h.hold("honey", outcome.promise);
    act(() => fireEvent.compositionStart(h.input()));
    await act(async () => outcome.resolve(first));
    expect(h.chip("honey")).toHaveAttribute("aria-busy", "true");
    // Send clicked under the composition: Mac WebKit leaves focus in the
    // editor, so the IME has not committed and the chip is still pending.
    h.submit();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled(),
    );
    expect(h.messages.send).not.toHaveBeenCalled();
    await act(async () => fireEvent.compositionEnd(h.input()));
    await waitFor(() =>
      expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
        "channel",
        "@Honey ",
        [first.pubkey],
        [],
      ),
    );
    expect([...(mentionHistory(h.session, "channel")?.keys() ?? [])]).toContain(
      first.pubkey,
    );
  } finally {
    outcome.resolve(null);
  }
});

it("settles a resolution landing after the composition ended under a send, and sends the recipient", async () => {
  const h = mountPendingMention();
  h.setProfiles(new Map([[first.pubkey, { name: "Honey" }]]));
  const outcome = deferred<MentionRecipient | null>();
  try {
    h.hold("honey", outcome.promise);
    act(() => fireEvent.compositionStart(h.input()));
    h.submit();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled(),
    );
    // The IME commits while the send has the editor read-only: ProseMirror
    // skips its own compositionend there and keeps its `composing` flag, so
    // only the React flag says the composition is over. The resolution lands
    // after that, and nothing else will come to replay a held settle.
    await act(async () => fireEvent.compositionEnd(h.input()));
    expect(h.chip("honey")).toHaveAttribute("aria-busy", "true");
    expect(h.messages.send).not.toHaveBeenCalled();
    await act(async () => outcome.resolve(first));
    await waitFor(() =>
      expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
        "channel",
        "@Honey ",
        [first.pubkey],
        [],
      ),
    );
    expect(h.chip("honey")).toBeNull();
  } finally {
    outcome.resolve(null);
  }
});

it("keeps the resolver of a chip gone when its held settle replays, and settles nothing", async () => {
  const h = mountPendingMention();
  h.setProfiles(new Map([[first.pubkey, { name: "Honey" }]]));
  const held = deferred<MentionRecipient | null>();
  const restarted = deferred<MentionRecipient | null>();
  try {
    h.hold("honey", held.promise);
    act(() => fireEvent.compositionStart(h.input()));
    await act(async () => held.resolve(first));
    expect(h.chip("honey")).toHaveAttribute("aria-busy", "true");
    await act(async () => {
      h.input().querySelector("[data-source]")?.remove();
    });
    expect(h.chip("honey")).toBeNull();
    h.resolve.mockImplementation(() => restarted.promise);
    await act(async () => fireEvent.compositionEnd(h.input()));
    expect(h.input().querySelector("[data-source]")).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Explicit mentions" }),
    ).toBeNull();
    expect(h.resolve).toHaveBeenCalledOnce();
    // Undo restores the chip under the same id, and its kept resolver starts again.
    act(() => h.input().undo(false));
    expect(h.chip("honey")).toBeInTheDocument();
    expect(h.resolve).toHaveBeenCalledTimes(2);
    await act(async () => restarted.resolve(first));
    expect(h.input()).toHaveValue("@Honey ");
    expect(h.chip("honey")).toBeNull();
  } finally {
    held.resolve(null);
    restarted.resolve(null);
  }
});

it("returns a pending chip to its typed query when a name character follows it, so its resolution tags no one", async () => {
  const h = mountPendingMention();
  h.setProfiles(new Map([[first.pubkey, { name: "Honey" }]]));
  const outcome = deferred<MentionRecipient | null>();
  try {
    h.hold("honey", outcome.promise);
    const signal = h.resolve.mock.calls[0]?.[0];
    const queries = h.queries();
    await h.user.keyboard("{Backspace}suckle");
    expect(h.input()).toHaveValue("@honeysuckle");
    expect(h.chip("honey")).toBeNull();
    expect(h.input().querySelector("[data-source]")).toBeNull();
    expect(signal?.aborted).toBe(true);
    // The chooser reopens over the whole word.
    expect(h.queries()).toBeGreaterThan(queries);
    await act(async () => outcome.resolve(first));
    expect(h.input()).toHaveValue("@honeysuckle");
    expect(
      screen.queryByRole("region", { name: "Explicit mentions" }),
    ).toBeNull();
    h.submit();
    expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
      "channel",
      "@honeysuckle",
      [],
      [],
    );
  } finally {
    outcome.resolve(null);
  }
});
it("removing a pending chip abandons its resolution, and redo starts it again", async () => {
  const h = mountPendingMention();
  h.setProfiles(new Map([[first.pubkey, { name: "Honey" }]]));
  const abandoned = deferred<MentionRecipient | null>();
  const restarted = deferred<MentionRecipient | null>();
  try {
    h.hold("honey", abandoned.promise);
    const signal = h.resolve.mock.calls[0]?.[0];
    act(() => h.input().undo(false));
    expect(h.input()).toHaveValue("@honey");
    expect(signal?.aborted).toBe(true);
    h.resolve.mockImplementation(() => restarted.promise);
    act(() => h.input().undo(true));
    expect(h.input()).toHaveValue("@honey ");
    expect(h.chip("honey")).toBeInTheDocument();
    expect(h.resolve).toHaveBeenCalledTimes(2);
    expect(h.resolve.mock.calls[1]?.[0]?.aborted).toBe(false);
    // The abandoned resolution settling late changes nothing.
    await act(async () => abandoned.resolve(second));
    expect(h.input()).toHaveValue("@honey ");
    expect(h.chip("honey")).toBeInTheDocument();
    await act(async () => restarted.resolve(first));
    expect(h.input()).toHaveValue("@Honey ");
    expect(h.chip("honey")).toBeNull();
  } finally {
    abandoned.resolve(null);
    restarted.resolve(null);
  }
});

describe("oversized paste feedback", () => {
  const pasteText = (input: ComposerInputElement, text: string) => {
    act(() => {
      input.focus();
      fireEvent.paste(input, {
        clipboardData: {
          items: [],
          getData: (type: string) => (type === "text/plain" ? text : ""),
        },
      });
    });
  };

  it("announces rejection, keeps the saved draft and clears feedback on recovery", () => {
    const h = mount();
    h.fill("Keep this draft.");
    pasteText(h.input(), "x".repeat(16001));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This paste would make your message too long. Shorten the text and try again.",
    );
    expect(h.input()).toHaveAccessibleDescription(
      /This paste would make your message too long/,
    );
    expect(h.input()).toHaveValue("Keep this draft.");
    expect(readView("scope", "draft:channel", null)).toMatchObject({
      text: "Keep this draft.",
    });
    expect(h.messages.send).not.toHaveBeenCalled();
    pasteText(h.input(), " OK");
    expect(h.input()).toHaveValue("Keep this draft. OK");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(h.input()).not.toHaveAttribute("aria-describedby");
    pasteText(h.input(), "x".repeat(16001));
    h.retarget({ channelId: "other-channel" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers a file only when the composer supports attachments", () => {
    const h = mount();
    h.retarget({ session: { ...h.session, attachments: { upload: vi.fn() } } });
    pasteText(h.input(), "x".repeat(16001));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Shorten it or attach the text as a file.",
    );
  });

  it("counts staged chat cards against the paste budget", () => {
    const link = "[Session: PR 45 fixes](buzz://channel/session-id)";
    writeView("scope", "draft:channel", {
      text: "",
      recipients: [],
      chatCards: [link],
    });
    const h = mount();
    const available = 16000 - link.length - 2;
    pasteText(h.input(), "x".repeat(available + 1));
    expect(h.input()).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This paste would make your message too long.",
    );
    pasteText(h.input(), "x".repeat(available));
    expect(h.input()).toHaveValue("x".repeat(available));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("region", { name: "Chat attachments" }),
    ).toBeVisible();
  });
});
