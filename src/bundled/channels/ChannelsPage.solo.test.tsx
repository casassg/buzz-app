// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { ChatNotStarted } from "../../features/relay/channel-writes";
import { keypair, signed } from "../../features/relay/testing";
import type { RelayData } from "../../features/relay/service";
import type { ChannelSummary } from "../../features/relay/contracts";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import type { PageNavigation } from "../../features/navigation/service";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { ChannelNavigationProvider } from "../../features/channel-navigation/ChannelNavigationState";
import {
  conversationTarget,
  soloDraftTarget,
} from "../../features/channel-navigation/routes";
import { linkedDraftKey } from "../../features/solo/linked-chat";
import { readView, writeView } from "../../shared/view-state";
import { splitPartition } from "../../features/relay/partition";
import {
  ChannelsPage,
  type ArchiveShortcut,
  type ReadShortcut,
} from "./ChannelsPage";
import { SoloWorkspaces } from "./SoloWorkspaces";
import type { RelaySession } from "../../features/relay/session";
import type { ReadTarget } from "../../features/relay/read-state-model";

composerDOMFixture();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.unstubAllGlobals();
});
const id = "11111111-1111-4111-8111-111111111111";
const agent = "a".repeat(64);
const empty: readonly never[] = [];
const contribution = { snapshot: () => empty, subscribe: () => () => {} };
const extensions = { tools: contribution, inline: contribution };
function fixture({
  placed = true,
  type = "solo",
  target,
  behindSettings = false,
  people = [],
  unloaded = false,
  departed = false,
  ownedBy,
  archived = false,
  viewerNamed = false,
  others = [],
  unread,
  capability = "frontier-sync",
}: {
  /** Observed unread messages in this chat; fakes the read state when given. */
  unread?: number;
  /** What the read state can do on this connection. */
  capability?: "unsupported" | "read-only" | "frontier-sync";
  /** Other Solo chats listed after this one in the sidebar's Chats. */
  others?: readonly string[];
  /** The viewer's own profile has loaded too. */
  viewerNamed?: boolean;
  /** Someone other than the viewer or its agent created the chat. */
  ownedBy?: string;
  archived?: boolean;
  /** Other people in the chat besides the viewer and its agent. */
  people?: readonly string[];
  /** The people's profiles never load, so nothing confirms they are people. */
  unloaded?: boolean;
  /** The people have left by the time a send refreshes the roster. */
  departed?: boolean;
  /** Whether the viewer created the chat, rather than joining it as a guest. */
  placed?: boolean;
  type?: "solo" | "stream";
  target?: (scope: string) => OpenTarget;
  /** Settings is open over this retained page. */
  behindSettings?: boolean;
} = {}) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const viewer = keypair();
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: keypair().pubkey,
      scope: "https://test.example",
      media: () => undefined,
      query: async () => [],
      writer: {
        kinds: [9, 9000],
        sign: async (event) => signed(viewer, event),
        publish: async () => {},
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  const scope = `https://test.example:${viewer.pubkey}`;
  const listeners = new Set<() => void>();
  const channel: ChannelSummary = {
    id,
    name: "Planning",
    channelType: type,
    private: true as const,
    creator: ownedBy ?? (placed ? viewer.pubkey : agent),
    members: [viewer.pubkey, agent, ...people],
    ...(archived && { archived }),
  };
  const neighbors = others.map((other, index) => ({
    ...channel,
    id: other,
    name: `Other ${index + 1}`,
  }));
  let list = { status: "ready" as const, channels: [channel, ...neighbors] };
  const listListeners = new Set<() => void>();
  const emitList = () => {
    for (const listener of listListeners) listener();
  };
  const window = {
    ...owner.session.channels.window(id),
    status: "ready" as const,
    rows: [],
  };
  const send = vi.fn<typeof owner.session.messages.send>(() => "d".repeat(64));
  // Like the relay, settle the roster before the confirmed action resolves.
  const run = vi.fn(
    async (action: string, _id?: string, _signal?: AbortSignal) => {
      list = {
        ...list,
        channels: [
          ...(action === "archive"
            ? [{ ...channel, archived: true as const }]
            : []),
          ...neighbors,
        ],
      };
      emitList();
    },
  );
  // The default agent comes first, so a named agent is distinguishable from it.
  const agents = [
    { pubkey: "b".repeat(64), name: "Helper", managed: false },
    { pubkey: agent, name: "Scout", managed: false },
  ];
  const choices = {
    ...owner.session.agentChoices.snapshot(),
    status: "ready" as const,
    complete: true,
    identities: agents,
    selectable: agents,
    archives: { status: "unavailable" as const, archived: [] },
  };
  // A stable snapshot, as useSyncExternalStore requires.
  const projects = {
    status: "ready" as const,
    data: {
      sections: [{ id: "work", name: "Work", order: 0 }],
      assignments: {},
      starred: [],
      muted: [],
    },
  };
  // A stable snapshot, as useSyncExternalStore requires.
  const profiles = new Map<string, { name: string }>([
    ...(unloaded
      ? []
      : people.map((key) => [key, { name: "Teammate" }] as const)),
    ...(viewerNamed ? [[viewer.pubkey, { name: "Viewer" }] as const] : []),
  ]);
  const markRead = vi.fn(async (_channelId: string) => ({}) as never);
  // useSyncExternalStore needs stable snapshots.
  const unreadState = {
    observedCount: unread ?? 0,
    attentionCount: 0,
    coverage: "observed" as const,
    freshness: "observed" as const,
    manual: "none" as const,
  };
  const unreadStates = new Map<
    string,
    typeof unreadState & { target: ReadTarget }
  >();
  const noActivity = {
    channelId: id,
    items: [],
    coverage: "observed" as const,
    freshness: "observed" as const,
  };
  const session = {
    ...owner.session,
    profiles: {
      ...owner.session.profiles,
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: () => new Promise<never>(() => {}),
    },
    agentChoices: {
      ...owner.session.agentChoices,
      retain: () => () => {},
      snapshot: () => choices,
      subscribe: () => () => {},
      refresh: async () => {},
    },
    channelLifecycle: {
      ...owner.session.channelLifecycle,
      available: true,
      load: vi.fn(async () => ({
        channelId: id,
        channelType: "stream" as const,
        canArchive: true,
        canUnarchive: false,
        canDelete: true,
        canLeave: false,
        canHide: false,
      })),
      run,
    },
    channelDetails: {
      ...owner.session.channelDetails,
      available: true,
      load: vi.fn(async () => ({
        channelId: id,
        version: "test",
        name: "Planning",
        description: "",
        visibility: "private" as const,
        canEdit: true,
      })),
    },
    channels: {
      ...owner.session.channels,
      list: () => list,
      subscribeList: (listener: () => void) => {
        listListeners.add(listener);
        return () => {
          listListeners.delete(listener);
        };
      },
      ensureList() {},
      refreshRoster: vi.fn(async () => true),
      window: () => window,
      ensure() {},
    },
    soloPreferences: {
      ...owner.session.soloPreferences,
      snapshot: () => projects,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    messages: { ...owner.session.messages, send },
    unread:
      unread === undefined
        ? owner.session.unread
        : {
            ...owner.session.unread,
            sync: () => ({
              capability,
              status: "reconciled" as const,
              completeness: "snapshot" as const,
            }),
            snapshot: (
              target: Parameters<typeof owner.session.unread.snapshot>[0],
            ) => {
              const key = JSON.stringify(target);
              let state = unreadStates.get(key);
              if (!state) {
                state = { ...unreadState, target };
                unreadStates.set(key, state);
              }
              return state;
            },
            activity: () => noActivity,
            markChannelRead: markRead,
          },
    channelWrites: {
      ...owner.session.channelWrites,
      available: true,
      // A new chat joins the owner's list once its creation is requested.
      create: vi.fn((chat: string) => {
        list = {
          ...list,
          channels: [...list.channels, { ...channel, id: chat, name: "" }],
        };
        emitList();
        return "c".repeat(64);
      }),
      // Starts through the create above; the relay accepts it at once.
      start: vi.fn((chat: string) => ({
        create: session.channelWrites.create(chat),
        ready: Promise.resolve(),
      })),
      delivered: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
      addAgents: vi.fn(async () => {}),
      refreshMembership: vi.fn(async () =>
        departed ? { ...channel, members: [viewer.pubkey, agent] } : channel,
      ),
    },
  };
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope,
    viewer: viewer.pubkey,
    session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const abort = new AbortController();
  const complete = vi.fn(() => true);
  const navigation: PageNavigation = {
    entryId: "visit",
    target: target?.(scope) ?? conversationTarget(scope, id),
    signal: abort.signal,
    position: () => undefined,
    savePosition() {},
    forSession: () => navigation,
    complete,
    resolve: () => true,
  };
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const navigator = {
    open,
    retry() {},
    snapshot: () => ({
      entry: {
        id: navigation.entryId,
        target: behindSettings
          ? { version: 1, kind: "settings", scope: null }
          : navigation.target,
      },
      attempt: { signal: abort.signal },
    }),
  } as unknown as Navigation;
  const archive: ArchiveShortcut = {};
  const read: ReadShortcut = {};
  const page = (sidebar = false) => (
    <ChannelNavigationProvider relay={relay}>
      {sidebar && (
        <SoloWorkspaces
          session={session as unknown as RelaySession}
          navigator={navigator}
          scope={scope}
          chats={[channel, ...neighbors].map((chat) => ({
            id: chat.id,
            title: chat.name,
          }))}
          renderChat={(item) => <button type="button">{item.title}</button>}
        />
      )}
      <ChannelsPage
        relay={relay}
        panels={{
          ...contribution,
          register() {},
          resolve: () => undefined,
          requestOpen: () => false,
          handleOpenRequests: () => () => {},
        }}
        extensions={extensions}
        navigation={navigation}
        navigator={navigator}
        archive={archive}
        read={read}
      />
    </ChannelNavigationProvider>
  );
  return {
    mount: () => render(page()),
    mountWithSidebar: () => render(page(true)),
    mountWithToasts: () => render(<ToastProvider>{page()}</ToastProvider>),
    abort,
    archive,
    read,
    markRead,
    open,
    run,
    send,
    scope,
    session,
    setArchived(archived: boolean) {
      const next = { ...channel };
      if (archived) next.archived = true;
      else delete next.archived;
      list = { ...list, channels: [next] };
      emitList();
    },
    // Chat activity: a new summary object for the same chat.
    retitle(name: string) {
      list = { ...list, channels: [{ ...channel, name }] };
      emitList();
    },
  };
}
it("archives from the shortcut without confirmation, then opens a new Solo draft", async () => {
  const f = fixture();
  f.mount();
  await waitFor(() => expect(f.archive.current?.available()).toBe(true));
  await act(async () => f.archive.current?.run());
  expect(f.session.channelLifecycle.load).toHaveBeenCalledWith(
    id,
    expect.any(AbortSignal),
  );
  expect(screen.queryByRole("dialog", { name: /^Archive chat/ })).toBeNull();
  await waitFor(() => expect(f.open).toHaveBeenCalled());
  expect(f.run).toHaveBeenCalledExactlyOnceWith(
    "archive",
    id,
    expect.any(AbortSignal),
  );
  expect(f.open).toHaveBeenCalledExactlyOnceWith(soloDraftTarget(f.scope));
  expect(f.archive.current).toBeUndefined();
});

it("offers no Archive shortcut outside a Solo chat", async () => {
  const f = fixture({ type: "stream" });
  f.mount();
  await screen.findByRole("textbox", { name: "Message #Planning" });
  expect(f.archive.current).toBeUndefined();
});

it("retires the Archive shortcut once the chat is archived", async () => {
  const f = fixture();
  f.mount();
  await waitFor(() => expect(f.archive.current).toBeDefined());
  await act(() => f.run("archive"));
  await waitFor(() => expect(f.archive.current).toBeUndefined());
});

it("opens no Archive from the shortcut where the menu offers none", async () => {
  const f = fixture();
  f.mount();
  await waitFor(() => expect(f.archive.current).toBeDefined());
  f.session.channelLifecycle.load.mockResolvedValueOnce({
    channelId: id,
    channelType: "stream",
    canArchive: false,
    canUnarchive: false,
    canDelete: false,
    canLeave: true,
    canHide: false,
  });
  await act(async () => f.archive.current?.run());
  f.session.channelLifecycle.load.mockRejectedValueOnce(new Error("offline"));
  await act(async () => f.archive.current?.run());
  // Each press reads permission afresh.
  expect(f.session.channelLifecycle.load).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.run).not.toHaveBeenCalled();
});

it("keeps a shortcut Archive across chat activity during the permission read", async () => {
  const f = fixture();
  let release = () => {};
  f.session.channelLifecycle.load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            channelId: id,
            channelType: "stream",
            canArchive: true,
            canUnarchive: false,
            canDelete: true,
            canLeave: false,
            canHide: false,
          });
      }),
  );
  f.mountWithToasts();
  await waitFor(() => expect(f.archive.current).toBeDefined());
  let pending: Promise<void> | undefined;
  act(() => {
    pending = f.archive.current?.run();
  });
  act(() => f.retitle("Roadmap"));
  await act(async () => {
    release();
    await pending;
  });
  // The result names the latest summary, not the one at keypress.
  expect(
    await screen.findByRole("dialog", { name: "Chat archived: Roadmap" }),
  ).toBeInTheDocument();
});

it("stops offering the Archive shortcut when its visit ends", async () => {
  const f = fixture();
  f.mount();
  await waitFor(() => expect(f.archive.current?.available()).toBe(true));
  f.abort.abort();
  expect(f.archive.current?.available()).toBe(false);
});

it("renders a Solo draft route as the new chat composer", async () => {
  const f = fixture({ target: (scope) => soloDraftTarget(scope) });
  f.mount();
  const region = await screen.findByRole("region", { name: "New chat" });
  expect(
    within(region).getByRole("textbox", { name: "Message your agents" }),
  ).toBeVisible();
  expect(screen.queryByLabelText("Channel message history")).toBeNull();
  expect(f.archive.current).toBeUndefined();
});

it("keeps refused-start restoration visibly retryable when window ownership fails again", async () => {
  const f = fixture({ target: (scope) => soloDraftTarget(scope, { agent }) });
  let refuse!: () => void;
  const ready = new Promise<void>((_resolve, reject) => {
    refuse = () => reject(new ChatNotStarted("Channel creation rejected"));
  });
  f.session.channelWrites.start.mockImplementationOnce((chat) => ({
    create: f.session.channelWrites.create(chat),
    ready,
  }));
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  const available = {
    request: async (_name: string, run: () => unknown) => run(),
  };
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: available,
  });
  f.mountWithToasts();
  const user = userEvent.setup();
  try {
    await user.type(
      await screen.findByRole("textbox", { name: "Message your agents" }),
      "Keep this message",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(f.open).toHaveBeenCalledOnce());
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async () => {
          throw new Error("Lock refused");
        },
      },
    });
    await act(async () => {
      refuse();
      await ready.catch(() => {});
    });
    const retry = () =>
      screen.findByRole("button", { name: "Retry restoring message" });
    const firstRetry = await retry();
    fireEvent.click(firstRetry);
    // The toast consumes its action before invoking it; a second failure must
    // offer a new action retaining the same refused prompt.
    await waitFor(() => expect(firstRetry).not.toBeInTheDocument());
    const offeredAgain = await retry();
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: available,
    });
    fireEvent.click(offeredAgain);
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Message your agents" }),
      ).toHaveTextContent("Keep this message"),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Retry restoring message" }),
      ).toBeNull(),
    );
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.session.channelWrites.start).toHaveBeenCalledOnce();
  } finally {
    if (descriptor) Object.defineProperty(navigator, "locks", descriptor);
    else Reflect.deleteProperty(navigator, "locks");
  }
});

it("starts a Solo draft route in its project, with that project's saved draft", async () => {
  const f = fixture({
    target: (scope) => soloDraftTarget(scope, { project: "work" }),
  });
  writeView(f.scope, "solo:project:work:new-draft", {
    text: "Plan the week",
    recipients: [],
  });
  writeView(f.scope, "solo:new-draft", { text: "Unfiled", recipients: [] });
  f.mount();
  const region = await screen.findByRole("region", { name: "New chat" });
  expect(
    within(region).getByRole("textbox", { name: "Message your agents" }),
  ).toHaveTextContent("Plan the week");
  await waitFor(() =>
    expect(
      within(region).getByRole("button", { name: "Workspace: Work" }),
    ).toBeEnabled(),
  );
});

it("addresses a Solo draft route's agent in the new chat without tagging the text", async () => {
  const f = fixture({ target: (scope) => soloDraftTarget(scope, { agent }) });
  f.mount();
  const region = await screen.findByRole("region", { name: "New chat" });
  const input = within(region).getByRole("textbox", {
    name: "Message your agents",
  });
  expect(
    within(region).getByRole("button", { name: "Add workspace" }),
  ).toBeVisible();
  // The routed agent is the recipient, held outside the text.
  const user = userEvent.setup();
  await user.click(input);
  expect(input).not.toHaveTextContent("@");
  await user.keyboard("Hello{Enter}");
  await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  expect(f.send).toHaveBeenCalledWith(expect.any(String), "Hello", [agent]);
});

it("a new Solo chat finishing behind Settings stays put and retires its draft", async () => {
  const f = fixture({ behindSettings: true, target: soloDraftTarget });
  writeView(f.scope, "solo:new-draft", {
    text: "@Scout Started behind Settings",
    recipients: [{ pubkey: agent, name: "Scout", start: 0, end: 6 }],
  });
  f.mount();
  // Stands in for a field in the Settings modal that owns focus.
  const settingsField = document.createElement("input");
  document.body.append(settingsField);
  const region = await screen.findByRole("region", { name: "New chat" });
  try {
    // The start runs while Settings owns focus.
    settingsField.focus();
    fireEvent.click(
      within(region).getByRole("button", { name: "Send message" }),
    );
    await waitFor(() =>
      expect(f.session.channelWrites.create).toHaveBeenCalledOnce(),
    );
    expect(f.open).not.toHaveBeenCalled();
    // A fresh draft replaces the submitted one, so it cannot start again.
    const composer = () =>
      within(screen.getByRole("region", { name: "New chat" })).getByRole(
        "textbox",
        { name: "Message your agents" },
      );
    await waitFor(() =>
      expect(composer()).not.toHaveTextContent("Started behind Settings"),
    );
    // The replacement never pulls focus out of Settings.
    expect(settingsField).toHaveFocus();
    expect(f.open).not.toHaveBeenCalled();
  } finally {
    settingsField.remove();
  }
});

it("sends the owner's Solo chat to its only agent without a tag, and gives it its project", async () => {
  const f = fixture();
  f.mount();
  const input = await screen.findByRole("textbox", {
    name: "Message your agents",
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add workspace" })).toBeEnabled(),
  );
  const user = userEvent.setup();
  await user.click(input);
  await user.keyboard("Untagged{Enter}");
  // The chat's only agent is already in the pill, so no tag is needed.
  await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  expect(f.send.mock.calls[0]?.[2]).toEqual([agent]);
  expect(
    screen.queryByText("Choose an agent to send", { selector: "[role=alert]" }),
  ).toBeNull();
});

it("sends a guest alone with agents to the chat's only agent, who can still file the chat", async () => {
  const f = fixture({ placed: false });
  f.mount();
  const input = await screen.findByRole("textbox", {
    name: "Message your agents",
  });
  // A shared chat is the guest's to file in their own workspaces.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add workspace" })).toBeEnabled(),
  );
  const user = userEvent.setup();
  await user.click(input);
  await user.keyboard("Hello team{Enter}");
  // The chat's only agent is already in the pill, so no tag is needed.
  await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  expect(f.send.mock.calls[0]?.[2]).toEqual([agent]);
  expect(
    screen.queryByText("Choose an agent to send", { selector: "[role=alert]" }),
  ).toBeNull();
});

it.each([
  ["owner", true],
  ["guest", false],
] as const)(
  "lets the %s talk without a tag once another person is in the chat",
  async (_, placed) => {
    const f = fixture({ placed, people: ["c".repeat(64)] });
    f.mount();
    const input = await screen.findByRole("textbox", {
      name: "Message this conversation",
    });
    const user = userEvent.setup();
    await user.click(input);
    await user.keyboard("Hello team{Enter}");
    await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Tag a person or agent to send")).toBeNull();
  },
);

it.each([
  ["a person", false],
  ["a person and an agent", true],
] as const)(
  "with queued follow-ups, the owner's send to %s goes out now",
  async (_, withAgent) => {
    localStorage.setItem("buzz-follow-up-behavior.v1", "queue");
    try {
      const person = "c".repeat(64);
      const f = fixture({ people: [person] });
      const text = withAgent ? "@Teammate @Scout hi" : "@Teammate hi";
      writeView(f.scope, `draft:${id}`, {
        text,
        recipients: [
          { pubkey: person, name: "Teammate", start: 0, end: 9 },
          ...(withAgent
            ? [{ pubkey: agent, name: "Scout", start: 10, end: 16 }]
            : []),
        ],
      });
      f.mount();
      const input = await screen.findByRole("textbox", {
        name: "Message this conversation",
      });
      const user = userEvent.setup();
      await user.click(input);
      await user.keyboard("{Enter}");
      await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
      expect(f.send.mock.calls[0]?.[2]).toEqual(
        withAgent ? [person, agent] : [person],
      );
      expect(
        screen.queryByText(/no longer available/, { selector: "[role=alert]" }),
      ).toBeNull();
    } finally {
      localStorage.removeItem("buzz-follow-up-behavior.v1");
    }
  },
);

it("keeps the tag requirement while a member's profile has not loaded", async () => {
  const f = fixture({ people: ["c".repeat(64)], unloaded: true });
  f.mount();
  const input = await screen.findByRole("textbox", {
    name: "Message your agents",
  });
  const user = userEvent.setup();
  await user.click(input);
  await user.keyboard("Hello team{Enter}");
  expect(
    await screen.findByText("Tag a person or agent to send", {
      selector: "[role=alert]",
    }),
  ).toBeVisible();
  expect(f.send).not.toHaveBeenCalled();
});

it("refuses an untagged send once the fresh roster has no other person", async () => {
  const f = fixture({ people: ["c".repeat(64)], departed: true });
  f.mount();
  const input = await screen.findByRole("textbox", {
    name: "Message this conversation",
  });
  const user = userEvent.setup();
  await user.click(input);
  await user.keyboard("Hello team{Enter}");
  expect(await screen.findByText("Tag an agent to send.")).toBeVisible();
  expect(f.send).not.toHaveBeenCalled();
});

it.each([
  ["archive", "Archive chat", undefined],
  ["delete", "Delete chat", "Delete Planning?"],
] as const)(
  "runs %s from Chat actions, then opens a new Solo draft",
  async (action, label, title) => {
    const f = fixture();
    f.mount();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Chat actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: label }));
    // Archive is undoable from its result toast, so only Delete confirms.
    if (title) {
      const dialog = screen.getByRole("dialog", { name: title });
      await user.click(within(dialog).getByRole("button", { name: label }));
    }
    await waitFor(() => expect(f.run).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(f.run).toHaveBeenCalledExactlyOnceWith(
      action,
      id,
      expect.any(AbortSignal),
    );
    expect(f.open).toHaveBeenCalledExactlyOnceWith(soloDraftTarget(f.scope));
  },
);

it.each([
  ["open", true],
  ["another", false],
] as const)(
  "archives the %s chat from its sidebar row; only leaving the open chat opens a new Solo draft",
  async (_, open) => {
    const f = fixture(
      open ? {} : { target: (scope) => soloDraftTarget(scope) },
    );
    f.mountWithSidebar();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Actions for Planning" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Archive chat" }),
    );
    await waitFor(() => expect(f.run).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(f.run).toHaveBeenCalledExactlyOnceWith(
      "archive",
      id,
      expect.any(AbortSignal),
    );
    if (open)
      expect(f.open).toHaveBeenCalledExactlyOnceWith(soloDraftTarget(f.scope));
    else expect(f.open).not.toHaveBeenCalled();
  },
);

it.each([
  ["Chat actions", "archive", "Archive chat", undefined],
  ["Chat actions", "delete", "Delete chat", "Delete Planning?"],
  ["Actions for Planning", "archive", "Archive chat", undefined],
] as const)(
  "from %s, %s leaves the open chat for its sidebar neighbor",
  async (trigger, action, label, title) => {
    const other = "22222222-2222-4222-8222-222222222222";
    const f = fixture({ others: [other] });
    f.mountWithSidebar();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: trigger }));
    await user.click(await screen.findByRole("menuitem", { name: label }));
    // Archive is undoable from its result toast, so only Delete confirms.
    if (title) {
      const dialog = await screen.findByRole("dialog", { name: title });
      await user.click(within(dialog).getByRole("button", { name: label }));
    }
    await waitFor(() => expect(f.open).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(f.run).toHaveBeenCalledExactlyOnceWith(
      action,
      id,
      expect.any(AbortSignal),
    );
    expect(f.open).toHaveBeenCalledExactlyOnceWith(
      conversationTarget(f.scope, other),
    );
  },
);

it("offers the header's chat actions from the sidebar row, plus inline Rename", async () => {
  const f = fixture();
  f.mountWithSidebar();
  const user = userEvent.setup();
  const items = async (trigger: string) => {
    await user.click(await screen.findByRole("button", { name: trigger }));
    const menu = await screen.findByRole("menu", { name: trigger });
    await within(menu).findByRole("menuitem", { name: "Delete chat" });
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    return names;
  };
  const header = await items("Chat actions");
  expect(header).toEqual([
    "Chat settings",
    "Move to",
    "Share access",
    "Copy link",
    "Convert to channel",
    "Archive chat",
    "Delete chat",
  ]);
  expect(await items("Actions for Planning")).toEqual(["Rename", ...header]);
});

it("runs the header's own chat actions and returns focus to Chat actions", async () => {
  const f = fixture();
  const assign = vi.fn(async () => {});
  Object.assign(f.session.soloPreferences, { writable: true, assign });
  f.mount();
  const user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: "Chat actions" });
  await user.click(trigger);
  (await screen.findByRole("menuitem", { name: "Move to" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(await screen.findByRole("menuitem", { name: "Work" }));
  expect(assign).toHaveBeenCalledExactlyOnceWith(id, "work");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Chat settings" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Edit chat" });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("reports a failed header move beside the header and retries it", async () => {
  const f = fixture();
  const base = f.session.soloPreferences.snapshot();
  let current: ReturnType<typeof f.session.soloPreferences.snapshot> = base;
  const listeners = new Set<() => void>();
  const publish = (next: typeof current) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const failed = {
    ...base,
    moves: [
      {
        id: 1,
        channelId: id,
        destination: { section: "work" },
        pending: false,
        error: "Relay unavailable",
      },
    ],
  } as unknown as typeof current;
  const retryMove = vi.fn(async () => {});
  Object.assign(f.session.soloPreferences, {
    writable: true,
    snapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    assign: vi.fn(async () => {
      publish(failed);
      throw new Error("Relay unavailable");
    }),
    retryMove,
    dismissMoveError: () => publish(base),
  });
  f.mountWithToasts();
  const user = userEvent.setup();
  // No failure is shown for a move this header did not start.
  act(() => publish(failed));
  expect(screen.queryByText("Chat wasn’t moved")).toBeNull();
  act(() => publish(base));
  await user.click(await screen.findByRole("button", { name: "Chat actions" }));
  (await screen.findByRole("menuitem", { name: "Move to" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(await screen.findByRole("menuitem", { name: "Work" }));
  expect(await screen.findByText("Chat wasn’t moved")).toBeVisible();
  // Toasts own swipe gestures, so press their buttons without a pointer.
  fireEvent.click(screen.getByRole("button", { name: "Retry move" }));
  expect(retryMove).toHaveBeenCalledExactlyOnceWith(id);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  await waitFor(() =>
    expect(screen.queryByText("Chat wasn’t moved")).toBeNull(),
  );
});

it("returns focus to Chat actions when its confirmation is cancelled", async () => {
  const f = fixture();
  f.mount();
  const user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: "Chat actions" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete chat" }),
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();
  expect(f.run).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
});

it("keeps Chat settings in the chat actions menu, not as a separate heading button", async () => {
  const f = fixture();
  f.mount();
  await screen.findByRole("button", { name: "Chat actions" });
  expect(screen.queryByRole("button", { name: "Chat settings" })).toBeNull();
});

it("names the owner on the access controls of someone else's shared chat", async () => {
  const person = "e".repeat(64);
  const f = fixture({ placed: false, ownedBy: person, people: [person] });
  f.mountWithSidebar();
  const user = userEvent.setup();
  // The owner's avatar stands in for the people icon on both controls.
  const header = await screen.findByRole("button", {
    name: "Share access, Teammate’s chat",
  });
  expect(header).toHaveTextContent("T");
  await user.hover(header);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Teammate’s chat",
  );
  const mark = screen.getByRole("button", { name: "Teammate’s chat" });
  expect(mark).toHaveTextContent("T");
  await user.click(mark);
  expect(
    await screen.findByRole("dialog", { name: /Share access/ }),
  ).toBeInTheDocument();
  // Closing returns focus to the mark, not the row's select button.
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mark).toHaveFocus();
});

it.each([
  ["the viewer's own chat", { people: ["e".repeat(64)], viewerNamed: true }],
  [
    "a chat whose owner's profile has not loaded",
    {
      placed: false,
      ownedBy: "e".repeat(64),
      people: ["e".repeat(64)],
      unloaded: true,
    },
  ],
])("names no owner on %s", async (_, options) => {
  fixture(options).mountWithSidebar();
  expect(
    await screen.findByRole("button", { name: "Share access" }),
  ).toBeInTheDocument();
  expect(screen.queryByText(/’s chat/)).toBeNull();
});

it("marks an archived chat once and keeps only its lifecycle actions", async () => {
  fixture({ archived: true }).mount();
  await screen.findByRole("button", { name: "Chat actions" });
  expect(screen.getAllByText("Archived")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Share access" })).toBeNull();
  expect(
    await screen.findByRole("region", { name: "Archived chat" }),
  ).toHaveTextContent("This chat is archived");
  expect(screen.queryByRole("textbox")).toBeNull();
});

it.each(["solo", "stream"] as const)(
  "replaces an archived %s composer with a notice and restores its draft on unarchive",
  async (type) => {
    const f = fixture({ type });
    const place = type === "solo" ? "chat" : "channel";
    f.mount();
    const editor = await screen.findByRole("textbox");
    expect(editor).toHaveFocus();
    const user = userEvent.setup();
    await user.click(editor);
    await user.keyboard("Keep this draft");
    await act(() => f.run("archive"));
    expect(
      await screen.findByRole("region", { name: `Archived ${place}` }),
    ).toHaveTextContent(`This ${place} is archived`);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
    // Remote unarchive restores composition without taking the reader's focus.
    const history = screen.getByRole("region", {
      name: "Channel message history",
    });
    history.focus();
    expect(history).toHaveFocus();
    act(() => f.setArchived(false));
    expect(await screen.findByRole("textbox")).toHaveTextContent(
      "Keep this draft",
    );
    expect(
      screen.queryByRole("region", { name: `Archived ${place}` }),
    ).toBeNull();
    expect(history).toHaveFocus();
    expect(f.send).not.toHaveBeenCalled();
  },
);

it("does not recreate a consumed linked draft on history navigation", () => {
  const linked = "22222222-2222-4222-8222-222222222222";
  const f = fixture({ target: (scope) => soloDraftTarget(scope, { linked }) });
  f.mount();
  expect(
    screen.getByText(
      "This linked chat draft is unavailable. Start again from its source.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(readView(f.scope, linkedDraftKey(linked), null)).toBeNull();
});

it("finishes a linked chat across roster updates without appending source prose", async () => {
  const linked = "22222222-2222-4222-8222-222222222222";
  const f = fixture({ target: (scope) => soloDraftTarget(scope, { linked }) });
  const source = {
    channelId: "33333333-3333-4333-8333-333333333333",
    link: `buzz://message?channel=33333333-3333-4333-8333-333333333333&id=${"e".repeat(64)}`,
  };
  writeView(f.scope, linkedDraftKey(linked), source);
  f.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("textbox"));
  await user.keyboard("Investigate this");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(f.open).toHaveBeenCalledOnce());
  expect(screen.queryByText("Draft unavailable")).toBeNull();
  expect(f.send.mock.calls[0]?.[1]).not.toContain("Source:");
  expect(f.session.channelWrites.start).toHaveBeenCalledOnce();
  expect(f.send.mock.calls[0]?.[1]).toContain(source.link);
});

it("marks the open conversation read from Escape while it shows unread", async () => {
  const f = fixture({ unread: 3 });
  f.mount();
  await waitFor(() => expect(f.read.current?.available()).toBe(true));
  await act(async () => f.read.current?.run());
  expect(f.markRead).toHaveBeenCalledExactlyOnceWith(id);
});

it("offers no Escape mark-read for a read chat, without read sync, or after the visit", async () => {
  const read = fixture();
  read.mount();
  await waitFor(() => expect(read.read.current).toBeDefined());
  expect(read.read.current?.available()).toBe(false);
  cleanup();
  const unsynced = fixture({ unread: 2, capability: "read-only" });
  unsynced.mount();
  await waitFor(() => expect(unsynced.read.current).toBeDefined());
  expect(unsynced.read.current?.available()).toBe(false);
  cleanup();
  const visit = fixture({ unread: 2 });
  visit.mount();
  await waitFor(() => expect(visit.read.current?.available()).toBe(true));
  visit.abort.abort();
  expect(visit.read.current?.available()).toBe(false);
});

it("offers no Escape mark-read for a read-only preview or the new message page", async () => {
  const f = fixture({
    unread: 2,
    target: (scope) => ({
      version: 1,
      kind: "page",
      pluginId: "buzz.channels",
      pageId: "channels",
      scope: splitPartition(scope) as never,
      route: { version: 1, params: "new-message" },
    }),
  });
  f.mount();
  await screen.findByRole("textbox", { name: /message/i }).catch(() => {});
  expect(f.read.current).toBeUndefined();
});

it("reports a failed Escape mark-read in a toast and keeps the chat open", async () => {
  const f = fixture({ unread: 1 });
  f.markRead.mockRejectedValueOnce(new Error("offline"));
  f.mountWithToasts();
  await waitFor(() => expect(f.read.current?.available()).toBe(true));
  await act(async () => f.read.current?.run());
  expect(await screen.findByText("Couldn’t mark as read.")).toBeInTheDocument();
});

it("leaves Escape to a text field outside the composer", async () => {
  const f = fixture({ unread: 1 });
  f.mount();
  await waitFor(() => expect(f.read.current?.available()).toBe(true));
  const field = document.createElement("input");
  document.body.append(field);
  field.focus();
  expect(f.read.current?.available()).toBe(false);
  field.remove();
});
