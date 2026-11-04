// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import { projectTemplateId } from "./workspace";
import { composerDOMFixture } from "../messages/composer-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import type { RelaySession } from "../relay/session";
import { readView, writeView } from "../../shared/view-state";
import { linkedDraftKey, type LinkedChat } from "./linked-chat";
import { SoloDraft, resetNewChatProject } from "./SoloDraft";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ChatNotStarted, createChannelWrites } from "../relay/channel-writes";
import { createOutbox } from "../relay/outbox";
import { keypair, signed } from "../relay/testing";
import { SOLO_LABEL } from "./labels";
import { attachmentDraft } from "../messages/attachment-draft";
import type {
  ComposerToolProps,
  ConversationExtensions,
} from "../conversation/contracts";
import { createAgentChoices } from "../agents/choices";
import { createAgentLibrary } from "../agents/library";
import { AgentsContext } from "../agents/react";
import type { Agents } from "../agents/service";
import { MentionCompletion } from "../../bundled/mentions/MentionCompletion";
import { mentionQuery } from "../../bundled/mentions/mention-query";
import type { ComposerCompletion } from "../conversation/contracts";
import type { Contribution } from "../../plugins/contributions";

composerDOMFixture();
afterEach(cleanup);
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "locks");
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: async (_name: string, run: () => unknown) => run() },
  });
  // jsdom lacks what the completion popup uses to position and reveal rows.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
const existing = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Engineering",
  channelType: "stream" as const,
  members: ["a".repeat(64)],
};
function taggedDraft(
  text: string,
  key = "a".repeat(64),
  name = "Member agent",
) {
  const mention = `@${name}`;
  return {
    text: `${mention} ${text}`,
    recipients: [{ pubkey: key, name, start: 0, end: mention.length }],
  };
}
const noOperations: readonly never[] = [];
/** Stands in for the mentions picker's pill: same name, same audience contract. */
function Audience({ audience }: ComposerToolProps) {
  return audience ? (
    <>
      <output
        aria-label={`Sending to ${audience.recipients
          .map((person) => person.name)
          .join(", ")}. Change agents`}
      />
      {[
        { pubkey: "a".repeat(64), name: "Member agent" },
        { pubkey: "b".repeat(64), name: "Outside agent" },
      ].map((agent) => (
        <button
          key={agent.pubkey}
          type="button"
          onClick={() => audience.only([agent])}
        >
          Send to {agent.name}
        </button>
      ))}
    </>
  ) : null;
}
const pillTools = [
  {
    id: "audience",
    key: "test/audience",
    pluginId: "test",
    revision: "1",
    title: "Audience",
    component: Audience,
  },
];
const noInline: readonly never[] = [];
const withPill = {
  inline: { snapshot: () => noInline, subscribe: () => () => {} },
  tools: { snapshot: () => pillTools, subscribe: () => () => {} },
} as unknown as ConversationExtensions;
const sendingTo = (names: string) =>
  screen.getByRole("status", { name: `Sending to ${names}. Change agents` });
function setup(available = true) {
  const rows = [
    { pubkey: "a".repeat(64), name: "Member agent" },
    { pubkey: "b".repeat(64), name: "Outside agent" },
  ];
  const agents = {
    status: "ready",
    complete: true,
    identities: rows,
    selectable: rows,
    archives: { status: "unavailable" as const, archived: [] },
  };
  const emoji = { status: "ready", entries: [] };
  const channelWrites = {
    available,
    addAgents: vi.fn(async () => {}),
    create: vi.fn<RelaySession["channelWrites"]["create"]>(() =>
      "c".repeat(64),
    ),
    delivered: vi.fn<RelaySession["channelWrites"]["delivered"]>(
      async () => {},
    ),
    refresh: vi.fn(async () => {}),
    failed: (_id: string) => false,
    discardFailed: vi.fn(async (_id: string) => {}),
    ready: Promise.resolve() as Promise<void>,
    start: vi.fn(
      (
        id: string,
        title: string,
        members: readonly string[],
        ttlSeconds?: number,
        named = false,
        setup?: { canvas: string; apply(): Promise<void> },
      ) => {
        const create = channelWrites.create(
          id,
          title,
          ttlSeconds,
          named,
          members,
        );
        void channelWrites.ready.then(() => setup?.apply()).catch(() => {});
        return { create, ready: channelWrites.ready };
      },
    ),
  };
  const messages = {
    send: vi.fn<RelaySession["messages"]["send"]>(() => "d".repeat(64)),
  };
  const viewer = "f".repeat(64);
  let channelSnapshot = {
    channels: [
      {
        id: "",
        channelType: "solo" as const,
        creator: viewer,
        members: existing.members,
      },
    ],
  };
  const profileSnapshot = new Map();
  const session = {
    viewer,
    channelWrites,
    messages,
    channels: {
      list: () => {
        // The chat a start last refreshed, or the one it just created.
        const id =
          (
            channelWrites.refresh.mock.calls.at(-1) as string[] | undefined
          )?.[0] ??
          channelWrites.create.mock.calls.at(-1)?.[0] ??
          "";
        if (channelSnapshot.channels[0]?.id !== id)
          channelSnapshot = {
            channels: [
              {
                id,
                channelType: "solo",
                creator: viewer,
                members: existing.members,
              },
            ],
          };
        return channelSnapshot;
      },
      subscribeList: () => () => {},
    },
    profiles: {
      ensure: vi.fn(async () => {}),
      snapshot: () => profileSnapshot,
      subscribe: () => () => {},
    },
    agentChoices: {
      retain: () => () => {},
      snapshot: () => agents,
      subscribe: () => () => {},
      refresh: async () => {},
    },
    emoji: {
      snapshot: () => emoji,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    outbox: {
      supports: () => true,
      snapshot: () => noOperations,
      subscribe: () => () => {},
      dismiss: vi.fn(async () => {}),
    },
    media: (url: string) => url,
  } as unknown as RelaySession;
  return { session, channelWrites, messages };
}
it("uses restored explicit mentions, not a separate picker", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  writeView("test", "solo:new-draft", {
    text: "@Outside agent Help",
    recipients: [
      { pubkey: "b".repeat(64), name: "Outside agent", start: 0, end: 14 },
    ],
  });
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  expect(screen.queryByRole("button", { name: "Choose an agent" })).toBeNull();
  await user.click(screen.getByRole("textbox"));
  await user.keyboard("{Enter}");
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const id = test.channelWrites.create.mock.calls[0]?.[0];
  // The create names the agent; no separate add.
  expect(test.channelWrites.start).toHaveBeenCalledWith(
    id,
    expect.any(String),
    ["b".repeat(64)],
    undefined,
    false,
    undefined,
  );
  expect(test.channelWrites.addAgents).not.toHaveBeenCalled();
  expect(test.messages.send).toHaveBeenCalledWith(id, "@Outside agent Help", [
    "b".repeat(64),
  ]);
});
type User = ReturnType<typeof userEvent.setup>;
it.each([
  {
    begun: "text",
    begin: (user: User) => user.type(screen.getByRole("textbox"), "Next idea"),
    kept: () =>
      expect(screen.getByRole("textbox")).toHaveTextContent("Next idea"),
  },
  {
    begun: "a file",
    begin: (user: User) =>
      user.upload(
        screen.getByLabelText("Choose attachments"),
        new File(["notes"], "notes.txt", { type: "text/plain" }),
      ),
    // The chip is still animating in; whether it is kept is what matters.
    kept: () =>
      expect(
        screen.getByRole("button", { name: "Remove notes.txt" }),
      ).toBeInTheDocument(),
  },
  {
    begun: "settings",
    begin: async (user: User) => {
      await user.click(screen.getByRole("button", { name: "Chat settings" }));
      await user.click(
        await screen.findByRole("radio", { name: /^Temporary/ }),
      );
      await user.click(screen.getByRole("button", { name: "Save changes" }));
    },
    kept: () =>
      expect(readView("test", "solo:settings", null)).toMatchObject({
        ttlSeconds: 604800,
      }),
  },
  {
    begun: "a workspace",
    begin: async (user: User) => {
      await user.click(screen.getByRole("button", { name: "Add workspace" }));
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Other" }),
      );
    },
    kept: () =>
      expect(
        screen.getByRole("button", { name: "Workspace: Other" }),
      ).toBeVisible(),
  },
])(
  "a refused start reports why and never overwrites $begun begun in New chat since",
  async ({ begin, kept }) => {
    const test = await projectSetup(),
      onStarted = vi.fn(),
      onFailed = vi.fn(),
      user = userEvent.setup();
    Object.assign(test.session, {
      attachments: { uploadForNewChat: vi.fn(async () => notes) },
    });
    const refuse = refusedStart(test);
    const view = () => (
      <SoloDraft
        session={test.session}
        scope="test"
        onStarted={onStarted}
        onFailed={onFailed}
      />
    );
    const first = render(view());
    await user.type(screen.getByRole("textbox"), "Lost start");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    const id = test.channelWrites.create.mock.calls[0]?.[0];
    first.unmount();
    // A new chat is being written when the relay refuses the first.
    render(view());
    await begin(user);
    await refuse();
    await waitFor(() =>
      expect(onFailed).toHaveBeenCalledWith(
        id,
        expect.stringMatching(
          /^Couldn't start ".+": Channel creation rejected\. New chat has a newer draft, so your message was not restored\.$/,
        ),
      ),
    );
    kept();
    expect(screen.getByRole("textbox")).not.toHaveTextContent("Lost start");
    expect(readView("test", `draft:${id}`, null)).toBeNull();
  },
);
it("a refused start gives its prompt, files and settings back to a blank New chat", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const uploadForNewChat = vi.fn(async () => notes);
  Object.assign(test.session, { attachments: { uploadForNewChat } });
  const refuse = refusedStart(test);
  writeView("test", "solo:new-draft", taggedDraft("Audit the onboarding flow"));
  writeView("test", "solo:settings", { name: "Onboarding audit" });
  const view = () => (
    <SoloDraft
      session={test.session}
      scope="test"
      onStarted={onStarted}
      onFailed={onFailed}
    />
  );
  const first = render(view());
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledOnce());
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const id = test.channelWrites.create.mock.calls[0]?.[0];
  first.unmount();
  // New chat is open and still blank when the relay refuses the first.
  render(view());
  expect(screen.getByRole("textbox")).not.toHaveTextContent("Audit");
  await refuse();
  await waitFor(() =>
    expect(onFailed).toHaveBeenCalledWith(
      id,
      `Couldn't start "Onboarding audit": Channel creation rejected. Your message is back in New chat.`,
    ),
  );
  expect(screen.getByRole("textbox")).toHaveTextContent(
    "Audit the onboarding flow",
  );
  expect(screen.getByRole("button", { name: "Remove notes.txt" })).toBeTruthy();
  expect(readView("test", `draft:${id}`, null)).toBeNull();
  // Sending again starts a new chat with the same name and the upload made.
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(2));
  const retry = test.channelWrites.create.mock.calls[1]?.[0];
  expect(retry).not.toBe(id);
  expect(test.channelWrites.start).toHaveBeenLastCalledWith(
    retry,
    "Onboarding audit",
    ["a".repeat(64)],
    undefined,
    true,
    undefined,
  );
  expect(test.messages.send).toHaveBeenLastCalledWith(
    retry,
    taggedDraft("Audit the onboarding flow").text,
    ["a".repeat(64)],
    [notes],
  );
  expect(uploadForNewChat).toHaveBeenCalledOnce();
});
/** The next start the relay refuses once `refuse` is called. */
function refusedStart(test: ReturnType<typeof setup>) {
  let refuse = () => {};
  const ready = new Promise<void>((_resolve, reject) => {
    refuse = () => reject(new ChatNotStarted("Channel creation rejected"));
  });
  ready.catch(() => {});
  test.channelWrites.ready = ready;
  return async () => {
    await act(async () => {
      refuse();
      await ready.catch(() => {});
    });
  };
}
/** Writes to these view keys fail, as when storage is full. */
function failingViewWrites(
  keys: readonly string[],
  fails: (value: string) => boolean = () => true,
) {
  const names = new Set(
    keys.map((key) => `buzz-view.v1:${JSON.stringify(["test", key])}`),
  );
  const setItem = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    name,
    value,
  ) {
    if (names.has(name) && fails(value)) throw new Error("Storage full");
    setItem.call(this, name, value);
  });
}
it.each([true, false])(
  "a prompt given back to an open New chat keeps the caret only where it was (in the editor=%s)",
  async (inEditor) => {
    const test = setup(),
      onStarted = vi.fn(),
      onFailed = vi.fn(),
      user = userEvent.setup();
    const refuse = refusedStart(test);
    writeView("test", "solo:new-draft", taggedDraft("Audit the flow"));
    const view = (focusRequest = 0) => (
      <SoloDraft
        focusRequest={focusRequest}
        session={test.session}
        scope="test"
        onStarted={onStarted}
        onFailed={onFailed}
      />
    );
    const first = render(view());
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    first.unmount();
    render(view(1));
    expect(screen.getByRole("textbox")).toHaveFocus();
    // Stands in for Settings or another surface that owns focus.
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    try {
      if (!inEditor) elsewhere.focus();
      await refuse();
      await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
      const input = screen.getByRole("textbox") as HTMLTextAreaElement;
      expect(input).toHaveTextContent("Audit the flow");
      if (inEditor) {
        expect(input).toHaveFocus();
        expect(input.selectionStart).toBe(input.value.length);
      } else expect(elsewhere).toHaveFocus();
    } finally {
      elsewhere.remove();
    }
  },
);
it("a prompt that can't be saved back leaves an open New chat as it is", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const refuse = refusedStart(test);
  writeView("test", "solo:new-draft", taggedDraft("Audit the flow"));
  writeView("test", "solo:settings", { name: "Audit the flow" });
  const view = () => (
    <SoloDraft
      session={test.session}
      scope="test"
      onStarted={onStarted}
      onFailed={onFailed}
    />
  );
  const first = render(view());
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  first.unmount();
  render(view());
  const storage = failingViewWrites(["solo:new-draft"]);
  try {
    await refuse();
    await waitFor(() =>
      expect(onFailed).toHaveBeenCalledWith(
        expect.any(String),
        `Couldn't start "Audit the flow": Channel creation rejected. Your message could not be saved on this device.`,
      ),
    );
    // Nothing else is given back either: the settings would be those of a
    // prompt New chat does not hold.
    expect(screen.getByRole("textbox")).not.toHaveTextContent("Audit");
    expect(readView("test", "solo:settings", null)).toBeNull();
  } finally {
    storage.mockRestore();
  }
});
it("a newer draft the composer couldn't save still keeps a refused prompt out of New chat", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const refuse = refusedStart(test);
  const refused = taggedDraft("Audit");
  writeView("test", "solo:new-draft", refused);
  const modelAgents = soloModelAgents();
  const view = () => (
    <AgentsContext.Provider value={modelAgents}>
      <SoloDraft
        session={test.session}
        scope="test"
        onStarted={onStarted}
        onFailed={onFailed}
      />
    </AgentsContext.Provider>
  );
  const first = render(view());
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  first.unmount();
  render(view());
  // Storage near its quota: the longer new prompt no longer fits, while the
  // shorter refused one still would.
  const storage = failingViewWrites(
    ["solo:new-draft"],
    (value) => value.length > JSON.stringify(refused).length,
  );
  try {
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    input.value = "A much longer idea than storage has room for now. ".repeat(
      4,
    );
    fireEvent.input(input);
    expect(readView("test", "solo:new-draft", null)).toBe("");
    // Saving a model choice must not clear the unsaved text guard either.
    await user.click(
      screen.getByRole("button", { name: "Model and effort for this chat" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Model for Member agent in this chat",
      }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Deep" }),
    );
    // Remove the durable choice so only the unsaved text protects recovery.
    act(() => {
      writeView("test", "solo:model-picks:solo:new-draft", null);
    });
    await refuse();
    await waitFor(() =>
      expect(onFailed).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringMatching(
          /\. New chat has a newer draft, so your message was not restored\.$/,
        ),
      ),
    );
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input.value).toContain("A much longer idea");
    expect(readView("test", "solo:new-draft", null)).toBe("");
  } finally {
    storage.mockRestore();
  }
});
it("a prompt given back whose settings can't be saved says so instead of retrying with defaults", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const refuse = refusedStart(test);
  writeView("test", "solo:new-draft", taggedDraft("Audit the flow"));
  writeView("test", "solo:settings", { name: "Audit", ttlSeconds: 604800 });
  const view = () => (
    <SoloDraft
      session={test.session}
      scope="test"
      onStarted={onStarted}
      onFailed={onFailed}
    />
  );
  const first = render(view());
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  first.unmount();
  render(view());
  const storage = failingViewWrites(["solo:settings", "solo:new-project"]);
  try {
    await refuse();
    await waitFor(() =>
      expect(onFailed).toHaveBeenCalledWith(
        expect.any(String),
        `Couldn't start "Audit": Channel creation rejected. Your message is back in New chat, but its settings and workspace could not be saved on this device.`,
      ),
    );
    expect(screen.getByRole("textbox")).toHaveTextContent("Audit the flow");
    expect(readView("test", "solo:settings", null)).toBeNull();
  } finally {
    storage.mockRestore();
  }
});
it("a refused start leaves New chat alone while its settings are being edited", async () => {
  const test = await projectSetup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const refuse = refusedStart(test);
  writeView("test", "solo:new-draft", taggedDraft("Audit the flow"));
  writeView("test", "solo:settings", { name: "Audit", ttlSeconds: 604800 });
  const view = () => (
    <SoloDraft
      session={test.session}
      scope="test"
      onStarted={onStarted}
      onFailed={onFailed}
    />
  );
  const first = render(view());
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  first.unmount();
  render(view());
  await user.click(screen.getByRole("button", { name: "Chat settings" }));
  const name = await screen.findByRole("textbox", { name: /^Chat name/ });
  expect(name).toHaveValue("");
  await refuse();
  await waitFor(() =>
    expect(onFailed).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(
        /\. New chat has a newer draft, so your message was not restored\.$/,
      ),
    ),
  );
  // The dialog saves what it shows, not settings it never showed.
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(readView("test", "solo:settings", null)).toEqual({
      canvas: "",
      name: "",
    }),
  );
  expect(screen.getByRole("textbox")).not.toHaveTextContent("Audit the flow");
});
it("a second refused start finds the first's prompt in New chat and says so", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const view = () => (
    <SoloDraft
      session={test.session}
      scope="test"
      onStarted={onStarted}
      onFailed={onFailed}
    />
  );
  const refuseFirst = refusedStart(test);
  const first = render(view());
  await user.type(screen.getByRole("textbox"), "First idea");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  first.unmount();
  const refuseSecond = refusedStart(test);
  const second = render(view());
  await user.type(screen.getByRole("textbox"), "Second idea");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(2));
  second.unmount();
  const [a, b] = test.channelWrites.create.mock.calls.map((call) => call[0]);
  await refuseFirst();
  await waitFor(() =>
    expect(onFailed).toHaveBeenCalledWith(
      a,
      expect.stringMatching(/\. Your message is back in New chat\.$/),
    ),
  );
  await refuseSecond();
  await waitFor(() =>
    expect(onFailed).toHaveBeenCalledWith(
      b,
      expect.stringMatching(
        /\. New chat holds an earlier message that couldn't be sent, so this one was not restored\.$/,
      ),
    ),
  );
  render(view());
  expect(screen.getByRole("textbox")).toHaveTextContent("First idea");
  expect(screen.getByRole("textbox")).not.toHaveTextContent("Second idea");
});
it("a refused start gives the pill's chosen agent back with its prompt", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const refuse = refusedStart(test);
  const view = () => (
    <SoloDraft
      session={test.session}
      scope="test"
      extensions={withPill}
      onStarted={onStarted}
      onFailed={onFailed}
    />
  );
  const first = render(view());
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  await user.click(
    screen.getByRole("button", { name: "Send to Outside agent" }),
  );
  expect(sendingTo("Outside agent")).toBeInTheDocument();
  await user.type(screen.getByRole("textbox"), "Hello");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const id = test.channelWrites.create.mock.calls[0]?.[0];
  expect(test.messages.send).toHaveBeenLastCalledWith(id, "Hello", [
    "b".repeat(64),
  ]);
  first.unmount();
  // New chat opens again from the default agent, as always.
  render(view());
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  await refuse();
  await waitFor(() =>
    expect(onFailed).toHaveBeenCalledWith(
      id,
      expect.stringMatching(/\. Your message is back in New chat\.$/),
    ),
  );
  expect(screen.getByRole("textbox")).toHaveTextContent("Hello");
  await waitFor(() => expect(sendingTo("Outside agent")).toBeInTheDocument());
  expect(screen.getByRole("textbox")).not.toHaveTextContent("@");
  // The relay accepts the retry.
  test.channelWrites.ready = Promise.resolve();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(2));
  const retry = test.channelWrites.create.mock.calls[1]?.[0];
  expect(test.channelWrites.start).toHaveBeenLastCalledWith(
    retry,
    expect.any(String),
    ["b".repeat(64)],
    undefined,
    false,
    undefined,
  );
  expect(test.messages.send).toHaveBeenLastCalledWith(retry, "Hello", [
    "b".repeat(64),
  ]);
  // The pick was for that prompt: the next New chat starts from the default.
  expect(readView("test", "solo:new-draft:agents", null)).toBeNull();
});
it("a pick after a refused start's agent comes back replaces it, unsaved", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const refuse = refusedStart(test);
  const view = () => (
    <SoloDraft
      session={test.session}
      scope="test"
      extensions={withPill}
      onStarted={onStarted}
      onFailed={onFailed}
    />
  );
  const sent = render(view());
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  await user.click(
    screen.getByRole("button", { name: "Send to Outside agent" }),
  );
  await user.type(screen.getByRole("textbox"), "Hello");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  sent.unmount();
  await refuse();
  await waitFor(() =>
    expect(onFailed).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/\. Your message is back in New chat\.$/),
    ),
  );
  const restored = render(view());
  await waitFor(() => expect(sendingTo("Outside agent")).toBeInTheDocument());
  await user.click(
    screen.getByRole("button", { name: "Send to Member agent" }),
  );
  expect(sendingTo("Member agent")).toBeInTheDocument();
  restored.unmount();
  // Shown again, New chat starts from the default, not the refused pick.
  render(view());
  expect(screen.getByRole("textbox")).toHaveTextContent("Hello");
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
});
it("a refused linked start gives its source and workspace back to the New chat opened after it", async () => {
  const test = await projectSetup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const refuse = refusedStart(test);
  const linkedId = "22222222-2222-4222-8222-222222222222";
  const source: LinkedChat = {
    channelId: "design",
    link: "buzz://channel/design",
  };
  writeView("test", linkedDraftKey(linkedId), source);
  const view = () => (
    <SoloDraft
      session={test.session}
      scope="test"
      linkedId={linkedId}
      source={source}
      focusRequest={1}
      extensions={withPill}
      onStarted={onStarted}
      onFailed={onFailed}
    />
  );
  const first = render(view());
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  expect(screen.getByRole("textbox")).toHaveValue(`${source.link} `);
  await user.keyboard("Investigate");
  await user.click(screen.getByRole("button", { name: "Add workspace" }));
  await user.click(await screen.findByRole("menuitemradio", { name: "Other" }));
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  first.unmount();
  // The start used up the source, so nothing could open this draft again.
  expect(readView("test", linkedDraftKey(linkedId), null)).toBeNull();
  await refuse();
  await waitFor(() =>
    expect(onFailed).toHaveBeenCalledWith(
      test.channelWrites.create.mock.calls[0]?.[0],
      expect.stringMatching(/\. Your message is back in New chat\.$/),
    ),
  );
  expect(readView("test", linkedDraftKey(linkedId), null)).toEqual(source);
  expect(test.messages.send).toHaveBeenCalledExactlyOnceWith(
    test.channelWrites.create.mock.calls[0]?.[0],
    `${source.link} Investigate`,
    ["a".repeat(64)],
  );
  // New chat, opened as the refusal is reported, holds it all again.
  render(view());
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(input.value).toBe(`${source.link} Investigate`);
  expect(input).toHaveFocus();
  expect(input.selectionStart).toBe(input.value.length);
  expect(
    screen.getByRole("button", { name: "Workspace: Other" }),
  ).toBeVisible();
});

it("a start that is only unconfirmed keeps the chat and its message", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  test.channelWrites.ready = Promise.reject(
    new Error("Still waiting for confirmation"),
  );
  test.channelWrites.ready.catch(() => {});
  render(
    <SoloDraft
      session={test.session}
      scope="test"
      onStarted={onStarted}
      onFailed={onFailed}
    />,
  );
  await user.type(screen.getByRole("textbox"), "Maybe made");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  await act(() => test.channelWrites.ready.catch(() => {}));
  expect(onFailed).not.toHaveBeenCalled();
  expect(test.session.outbox?.dismiss).not.toHaveBeenCalled();
  expect(test.channelWrites.discardFailed).not.toHaveBeenCalled();
  expect(readView("test", "solo:new-draft", null)).toBe("");
});
it("cannot send on an unsupported community", async () => {
  const test = setup(false),
    user = userEvent.setup();
  render(
    <SoloDraft session={test.session} scope="test" onStarted={() => {}} />,
  );
  await user.type(screen.getByRole("textbox"), "Draft");
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(test.channelWrites.create).not.toHaveBeenCalled();
});

it("opens the chat and sends its message before the relay confirms the create", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  test.channelWrites.ready = new Promise(() => {});
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  await user.type(screen.getByRole("textbox"), "Right away");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(test.channelWrites.start).toHaveBeenCalledOnce();
  expect(test.channelWrites.delivered).not.toHaveBeenCalled();
  expect(test.messages.send).toHaveBeenCalledWith(
    test.channelWrites.create.mock.calls[0]?.[0],
    "Right away",
    ["a".repeat(64)],
  );
});

it.each([false, true])(
  "applies section defaults once the chat starts; failed setup still keeps the chat (failure=%s)",
  async (failure) => {
    vi.stubGlobal("crypto", webcrypto);
    try {
      const test = setup();
      const sequence: string[] = [];
      const onStarted = vi.fn();
      const id = await projectTemplateId("work");
      const canvasSave = vi.fn(async (_channel: string, _content: string) => {
        sequence.push("canvas");
        if (failure) throw new Error("Canvas save failed");
        return { id: "f".repeat(64) };
      });
      Object.assign(test.session, {
        channelKit: {
          refresh: async () => {},
          snapshot: () => ({
            status: "ready",
            entries: [
              {
                eventId: "head",
                record: {
                  value: {
                    type: "template",
                    id,
                    canvas: "Use /repo",
                    agents: [],
                    teamIds: [],
                  },
                },
              },
            ],
          }),
        },
        soloPreferences: {
          writable: true,
          refresh: async () => {},
          snapshot: () => ({
            status: "ready",
            data: { sections: [{ id: "work", name: "Work" }], assignments: {} },
          }),
          assign: async () => {
            sequence.push("placement");
          },
        },
        canvas: { read: async () => undefined, save: canvasSave },
      });
      test.messages.send.mockImplementation(() => {
        sequence.push("send");
        return "d".repeat(64);
      });
      writeView(
        "test",
        "solo:project:work:new-draft",
        taggedDraft("Build this"),
      );
      render(
        <SoloDraft
          session={test.session}
          scope="test"
          projectId="work"
          onStarted={onStarted}
        />,
      );
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("textbox", { name: "Message your agents" }),
      );
      await user.keyboard("{Enter}");
      await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
      expect(test.channelWrites.create).toHaveBeenCalledOnce();
      await waitFor(() =>
        // The chat joins its workspace at once and its message goes out;
        // the Canvas is saved behind them.
        expect(sequence).toEqual(["placement", "send", "canvas"]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it("edits draft settings before creation, restores them, and applies Canvas once the chat starts", async () => {
  const test = setup();
  const order: string[] = [];
  const saveCanvas = vi.fn(async () => {
    order.push("canvas");
  });
  Object.assign(test.session, {
    canvas: { read: async () => undefined, save: saveCanvas },
  });
  test.messages.send.mockImplementation(() => {
    order.push("send");
    return "d".repeat(64);
  });
  const onStarted = vi.fn();
  const user = userEvent.setup();
  const view = (focusRequest: number | AbortSignal = 0) => (
    <SoloDraft
      focusRequest={focusRequest}
      session={test.session}
      scope="test"
      onStarted={onStarted}
    />
  );
  let mounted = render(view());
  await user.click(screen.getByRole("button", { name: "Chat settings" }));
  const canvas = await screen.findByRole("textbox", { name: /^Instructions/ });
  expect(canvas).toHaveValue("");
  await user.clear(canvas);
  await user.type(canvas, "Keep the change small");
  // A stray outside click keeps the dialog and the typed instructions.
  const backdrop = document.querySelector(".buzz-dialog-backdrop") as Element;
  fireEvent.pointerDown(backdrop);
  fireEvent.mouseDown(backdrop);
  fireEvent.click(backdrop);
  await Promise.resolve();
  expect(screen.getByRole("textbox", { name: /^Instructions/ })).toHaveValue(
    "Keep the change small",
  );
  await user.click(screen.getByRole("radio", { name: /^Temporary/ }));
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Chat settings" })).toHaveFocus(),
  );
  expect(screen.queryByRole("menu")).toBeNull();
  expect(test.channelWrites.create).not.toHaveBeenCalled();
  expect(saveCanvas).not.toHaveBeenCalled();
  mounted.unmount();
  mounted = render(view(1));
  const composer = screen.getByRole("textbox", {
    name: "Message your agents",
  });
  expect(composer).toHaveFocus();
  const actions = screen.getByRole("button", { name: "Chat settings" });
  actions.focus();
  expect(actions).toHaveFocus();
  mounted.rerender(view(new AbortController().signal));
  expect(composer).toHaveFocus();
  await user.type(composer, "Build this");
  await user.keyboard("{Enter}");
  await waitFor(() => expect(onStarted).toHaveBeenCalled());
  expect(test.channelWrites.create.mock.calls[0]?.[2]).toBe(604800);
  expect(test.channelWrites.create).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(saveCanvas).toHaveBeenCalledWith(
      expect.any(String),
      "Keep the change small",
      undefined,
    ),
  );
  expect(order).toEqual(["send", "canvas"]);
});

it("a new Solo chat for a named agent starts with it in the pill, not the default", async () => {
  const f = setup();
  const user = userEvent.setup();
  const started = vi.fn();
  const agent = "b".repeat(64);
  render(
    <SoloDraft
      agent={agent}
      session={f.session}
      scope="me-route-agent"
      extensions={withPill}
      onStarted={started}
    />,
  );
  const input = screen.getByRole("textbox");
  await waitFor(() => expect(sendingTo("Outside agent")).toBeInTheDocument());
  // The agent is never inserted into the text.
  expect(input).not.toHaveTextContent("@");
  await user.type(input, "Hello");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  const [id] = started.mock.calls[0] ?? [];
  expect(f.messages.send).toHaveBeenCalledExactlyOnceWith(id, "Hello", [agent]);
});

it("a named agent replaces a saved new-chat draft that holds only another agent's tag", async () => {
  const f = setup();
  const scope = "me-route-agent-after-default";
  // A draft saved by an earlier default that tagged its agent in the text.
  writeView(scope, "solo:new-draft", taggedDraft(""));
  render(
    <SoloDraft
      agent={"b".repeat(64)}
      session={f.session}
      scope={scope}
      extensions={withPill}
      onStarted={vi.fn()}
    />,
  );
  const input = screen.getByRole("textbox");
  await waitFor(() => expect(sendingTo("Outside agent")).toBeInTheDocument());
  expect(input).not.toHaveTextContent("@Member agent");
});

it("a named agent keeps a saved new-chat draft that has the person's own text, whose mention is the recipient", async () => {
  const f = setup();
  const user = userEvent.setup();
  const started = vi.fn();
  const scope = "me-route-agent-after-text";
  writeView(scope, "solo:new-draft", taggedDraft("Keep this"));
  render(
    <SoloDraft
      agent={"b".repeat(64)}
      session={f.session}
      scope={scope}
      extensions={withPill}
      onStarted={started}
    />,
  );
  const input = screen.getByRole("textbox");
  await waitFor(() => expect(input).toHaveTextContent("Keep this"));
  expect(input).toHaveTextContent("@Member agent");
  expect(input).not.toHaveTextContent("@Outside agent");
  // Its inline mention decides who hears it; the named agent steps aside.
  expect(sendingTo("Member agent")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(f.messages.send).toHaveBeenCalledExactlyOnceWith(
    started.mock.calls[0]?.[0],
    expect.stringContaining("Keep this"),
    ["a".repeat(64)],
  );
});

it("a new Solo chat needs a tagged agent to send", async () => {
  const f = setup();
  // No agent is available, so nothing seeds the pill.
  const none = {
    status: "ready",
    complete: true,
    identities: [],
    selectable: [],
    archives: { status: "unavailable" as const, archived: [] },
  };
  Object.assign(f.session.agentChoices, { snapshot: () => none });
  const user = userEvent.setup();
  render(
    <SoloDraft
      session={f.session}
      scope="me-untagged"
      extensions={withPill}
      onStarted={vi.fn()}
    />,
  );
  expect(sendingTo("")).toBeInTheDocument();
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  input.value = "Start here";
  fireEvent.input(input);
  await user.keyboard("{Enter}");
  const form = input.closest("form");
  if (!form) throw new Error("Missing composer form");
  fireEvent.submit(form);
  expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(f.channelWrites.create).not.toHaveBeenCalled();
});

it("opens and saves local draft settings in a fresh Solo project after a failed initial read", async () => {
  vi.stubGlobal("crypto", webcrypto);
  try {
    const f = setup();
    const refreshSolo = vi.fn(async () => {});
    // Both the workspace's preload on mount and the settings dialog's read
    // fail.
    refreshSolo
      .mockRejectedValueOnce(new Error("Settings unavailable"))
      .mockRejectedValueOnce(new Error("Settings unavailable"));
    Object.assign(f.session, {
      soloPreferences: {
        writable: true,
        refresh: refreshSolo,
        snapshot: () => ({
          status: "ready",
          data: {
            sections: [{ id: "solo-only", name: "Work" }],
            assignments: {},
          },
        }),
      },
      channelKit: {
        refresh: async () => {},
        snapshot: () => ({ status: "ready", entries: [] }),
      },
    });
    const view = () => (
      <SoloDraft
        session={f.session}
        scope="solo-settings"
        projectId="solo-only"
        onStarted={() => {}}
      />
    );
    const user = userEvent.setup();
    const mounted = render(view());
    const open = async () => {
      await user.click(screen.getByRole("button", { name: "Chat settings" }));
    };
    await open();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Settings unavailable",
    );
    expect(screen.queryByText("Loading settings…")).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    refreshSolo.mockImplementationOnce(() => held);
    const reads = refreshSolo.mock.calls.length;
    try {
      await user.click(screen.getByRole("button", { name: "Retry settings" }));
      await waitFor(() => expect(refreshSolo).toHaveBeenCalledTimes(reads + 1));
      expect(screen.getByRole("status")).toHaveTextContent("Loading settings…");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toBeDisabled();
    } finally {
      release();
    }
    await user.type(
      await screen.findByRole("textbox", { name: /^Instructions/ }),
      "Keep this Solo draft",
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(refreshSolo).toHaveBeenCalledTimes(reads + 1);
    mounted.unmount();
    render(view());
    await open();
    expect(
      await screen.findByRole("textbox", { name: /^Instructions/ }),
    ).toHaveValue("Keep this Solo draft");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(f.channelWrites.create).not.toHaveBeenCalled();
    expect(f.messages.send).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("invalid stored draft lifetime fails visibly without a new create", async () => {
  const h = setup();
  writeView("test", "solo:new-draft", taggedDraft("Keep this draft"));
  writeView("test", "solo:settings", { canvas: "", ttlSeconds: -1 });
  const user = userEvent.setup();
  render(<SoloDraft session={h.session} scope="test" onStarted={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "duration could not be verified",
  );
  expect(h.channelWrites.create).not.toHaveBeenCalled();
  expect(h.channelWrites.delivered).not.toHaveBeenCalled();
});

async function projectSetup() {
  vi.stubGlobal("crypto", webcrypto);
  const f = setup();
  const entries = await Promise.all(
    ["work", "other"].map(async (id) => ({
      eventId: id,
      record: {
        value: {
          type: "template",
          id: await projectTemplateId(id),
          canvas: `${id} instructions`,
          agents: [],
          teamIds: [],
        },
      },
    })),
  );
  const preferences = {
    status: "ready",
    data: {
      sections: [
        { id: "work", name: "Work" },
        { id: "other", name: "Other" },
      ],
      assignments: {},
    },
  };
  const saveCanvas = vi.fn(async () => {});
  const assign = vi.fn(async (_id: string, _sectionId?: string) => {});
  Object.assign(f.session, {
    soloPreferences: {
      writable: true,
      refresh: async () => {},
      snapshot: () => preferences,
      subscribe: () => () => {},
      assign,
    },
    channelKit: {
      refresh: async () => {},
      snapshot: () => ({ status: "ready", entries }),
    },
    canvas: { read: async () => undefined, save: saveCanvas },
  });
  return { ...f, saveCanvas, assign, entries };
}

it("a workspace's defaults changed while New chat is open start the chat", async () => {
  const f = await projectSetup();
  const refresh = vi.fn(async () => {});
  Object.assign(f.session.channelKit, { refresh });
  const user = userEvent.setup();
  const started = vi.fn();
  render(
    <SoloDraft
      session={f.session}
      scope="changed-defaults"
      projectId="work"
      onStarted={started}
    />,
  );
  // The defaults load once the workspace is picked; then they are saved anew.
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  await act(async () => {});
  const [work] = f.entries;
  if (!work) throw new Error("missing work defaults");
  f.entries[0] = {
    ...work,
    eventId: "work-2",
    record: {
      value: { ...work.record.value, canvas: "new work instructions" },
    },
  };
  await user.type(screen.getByRole("textbox"), "Go");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(f.saveCanvas).toHaveBeenCalledWith(
      expect.any(String),
      "new work instructions",
      undefined,
    ),
  );
});

it("re-entering a mounted project clears changed defaults", async () => {
  const f = await projectSetup();
  const started = vi.fn();
  const scope = "project-reset";
  const key = "solo:project:work";
  writeView(scope, `${key}:new-project`, "other");
  writeView(scope, `${key}:settings`, "other edited instructions");
  render(
    <SoloDraft
      projectId="work"
      session={f.session}
      scope={scope}
      onStarted={started}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Workspace: Other" }),
  ).toBeVisible();
  act(() => resetNewChatProject(scope, "work"));
  expect(
    await screen.findByRole("button", { name: "Workspace: Work" }),
  ).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Chat settings" }));
  expect(
    await screen.findByRole("textbox", { name: /^Instructions/ }),
  ).toHaveValue("work instructions");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.type(screen.getByRole("textbox"), "Start in Work");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(f.assign).toHaveBeenCalledWith(expect.any(String), "work");
  expect(f.saveCanvas).toHaveBeenCalledWith(
    expect.any(String),
    "work instructions",
    undefined,
  );
});

it("keeps a locally chosen project when its persistence fails and other draft writes succeed", async () => {
  const f = await projectSetup();
  const started = vi.fn();
  const user = userEvent.setup();
  const scope = "project-write-failure";
  const key = `buzz-view.v1:${JSON.stringify([scope, "solo:project:work:new-project"])}`;
  const setItem = Storage.prototype.setItem;
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, name, value) {
      if (name === key) throw new Error("Storage unavailable");
      setItem.call(this, name, value);
    });
  try {
    render(
      <SoloDraft
        projectId="work"
        session={f.session}
        scope={scope}
        onStarted={started}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Workspace: Work" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Other" }),
    );
    await user.type(screen.getByRole("textbox"), "Keep this project");
    expect(
      screen.getByRole("button", { name: "Workspace: Other" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(f.assign).toHaveBeenCalledWith(expect.any(String), "other");
  } finally {
    storage.mockRestore();
  }
});

it("inherits the project's defaults for two consecutive new chats", async () => {
  const f = await projectSetup();
  const user = userEvent.setup();
  const started = vi.fn();
  for (let index = 0; index < 2; index++) {
    const view = render(
      <SoloDraft
        session={f.session}
        scope="repeat-project"
        projectId="work"
        onStarted={started}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Workspace: Work" }),
    ).toBeVisible();
    await user.type(screen.getByRole("textbox"), `Chat ${index}`);
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledTimes(index + 1));
    await waitFor(() =>
      expect(f.saveCanvas).toHaveBeenNthCalledWith(
        index + 1,
        expect.any(String),
        "work instructions",
        undefined,
      ),
    );
    view.unmount();
  }
  expect(f.channelWrites.create.mock.calls[0]?.[0]).not.toBe(
    f.channelWrites.create.mock.calls[1]?.[0],
  );
});

it.each([
  { saved: true, remount: true, fromProject: true },
  { saved: false, remount: false, fromProject: false },
])(
  "switching projects uses new defaults and retains independent naming/lifetime (saved=$saved, remount=$remount, fromProject=$fromProject)",
  async ({ saved, remount, fromProject }) => {
    const f = await projectSetup();
    const user = userEvent.setup();
    const started = vi.fn();
    const draftKey = fromProject ? "solo:project:work" : "solo";
    writeView("switch-project", `${draftKey}:settings`, {
      name: "My chosen title",
      ttlSeconds: 600,
    });
    const view = () => (
      <SoloDraft
        session={f.session}
        scope="switch-project"
        projectId={fromProject ? "work" : undefined}
        onStarted={started}
      />
    );
    const mounted = render(view());
    const openSettings = async () => {
      await user.click(screen.getByRole("button", { name: "Chat settings" }));
      return screen.findByRole("textbox", { name: /^Instructions/ });
    };
    if (saved) {
      const canvas = await openSettings();
      await waitFor(() =>
        expect(canvas).toHaveValue(fromProject ? "work instructions" : ""),
      );
      await user.clear(canvas);
      await user.type(canvas, "Old project override");
      await user.click(screen.getByRole("button", { name: "Save changes" }));
    }
    await user.click(
      screen.getByRole("button", {
        name: fromProject ? "Workspace: Work" : "Add workspace",
      }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: /^Other$/ }),
    );
    if (remount) {
      mounted.unmount();
      render(view());
    }
    const canvas = await openSettings();
    await waitFor(() => expect(canvas).toHaveValue("other instructions"));
    expect(screen.getByRole("textbox", { name: /^Chat name/ })).toHaveValue(
      "My chosen title",
    );
    expect(screen.getByRole("radio", { name: /^Temporary/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await user.type(screen.getByRole("textbox"), "New project chat");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(f.channelWrites.create).toHaveBeenCalledWith(
      expect.any(String),
      "My chosen title",
      600,
      true,
      ["a".repeat(64)],
    );
    await waitFor(() =>
      expect(f.assign).toHaveBeenCalledWith(expect.any(String), "other"),
    );
    expect(f.saveCanvas).toHaveBeenCalledWith(
      expect.any(String),
      "other instructions",
      undefined,
    );
  },
);

it("allows changing an unavailable assistant before any remote creation", async () => {
  const f = setup();
  const user = userEvent.setup();
  const started = vi.fn();
  const choices = f.session.agentChoices.snapshot();
  vi.spyOn(f.session.agentChoices, "snapshot").mockReturnValue({
    ...choices,
    selectable: choices.selectable.filter(
      (agent) => agent.pubkey === "a".repeat(64),
    ),
  });
  writeView(
    "unavailable-agent",
    "solo:new-draft",
    taggedDraft("Keep my draft", "b".repeat(64), "Outside agent"),
  );
  render(
    <SoloDraft
      session={f.session}
      scope="unavailable-agent"
      onStarted={started}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText(
    "Only your available agents can be mentioned in Solo chats. Remove the unavailable recipient and retry.",
  );
  expect(f.channelWrites.create).not.toHaveBeenCalled();
  cleanup();
  writeView(
    "unavailable-agent",
    "solo:new-draft",
    taggedDraft("Keep my draft"),
  );
  render(
    <SoloDraft
      session={f.session}
      scope="unavailable-agent"
      onStarted={started}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(f.messages.send).toHaveBeenCalledWith(
    expect.any(String),
    "@Member agent Keep my draft",
    ["a".repeat(64)],
  );
});

it.each([{ fields: { name: 7 } }, { fields: { name: "x".repeat(121) } }])(
  "rejects malformed persisted naming before start side effects: $fields",
  async ({ fields }) => {
    const h = setup(),
      user = userEvent.setup(),
      started = vi.fn();
    const refreshPreferences = vi.fn(async () => {});
    const refreshSetup = vi.fn(async () => {});
    const readCanvas = vi.fn(async () => undefined);
    const saveCanvas = vi.fn(async () => {});
    const refreshAgents = vi.fn(async () => {});
    Object.assign(h.session, {
      channelKit: { refresh: refreshSetup },
      soloPreferences: {
        refresh: refreshPreferences,
        snapshot: () => ({
          data: { sections: [{ id: "work", name: "Work" }] },
        }),
      },
      canvas: { read: readCanvas, save: saveCanvas },
      agentChoices: { ...h.session.agentChoices, refresh: refreshAgents },
    });
    const key = "solo:project:work";
    writeView("test", `${key}:new-draft`, taggedDraft("Keep this draft"));
    writeView("test", `${key}:settings`, fields);
    render(
      <SoloDraft
        session={h.session}
        scope="test"
        projectId="work"
        onStarted={started}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/name/i);
    // The workspace's defaults load when it is picked; that is a read, not a
    // start.
    for (const operation of [
      readCanvas,
      saveCanvas,
      refreshAgents,
      h.channelWrites.create,
      h.channelWrites.delivered,
      h.channelWrites.refresh,
      h.channelWrites.addAgents,
      h.messages.send,
      started,
    ]) {
      expect(operation).not.toHaveBeenCalled();
    }
  },
);

it.each([false, true])(
  "naming crosses the real composer → creation/outbox boundary with frozen intent (explicit=%s)",
  async (explicit) => {
    const h = setup();
    const viewer = keypair();
    const publish = vi.fn(async (_event: Parameters<typeof signed>[1]) => {});
    const sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
      signed(viewer, template),
    );
    const outbox = createOutbox(
      viewer.pubkey,
      { kinds: [9, 9007], sign, publish },
      { load: () => [], save() {} },
    );
    const lifetime = new AbortController();
    writeView("real-creation", "solo:settings", {
      name: explicit ? "Chosen title" : "",
      ttlSeconds: 600,
    });
    writeView(
      "real-creation",
      "solo:new-draft",
      taggedDraft(
        "Original [\\#design](buzz://channel/design) prompt",
        viewer.pubkey,
        "Viewer",
      ),
    );
    let observed = outbox.outbox.snapshot();
    let channelList = {
      status: "ready" as const,
      channels: [] as {
        id: string;
        name: string;
        channelType: "solo";
        creator: string;
        members: string[];
      }[],
    };
    const channels = {
      ...h.session.channels,
      list: () => {
        const next = outbox.outbox.snapshot();
        if (next !== observed) {
          observed = next;
          channelList = {
            status: "ready",
            channels: next
              .filter(({ event }) => event.kind === 9007)
              .map(({ event }) => ({
                id: event.tags.find(([key]) => key === "h")?.[1] ?? "",
                name: "Chosen title",
                channelType: "solo",
                creator: viewer.pubkey,
                members: [viewer.pubkey],
              })),
          };
        }
        return channelList;
      },
    };
    const authority = keypair();
    const channelWrites = createChannelWrites(
      outbox.outbox,
      channels,
      {
        read: async (filters) =>
          filters.flatMap((filter) =>
            filter.kinds?.includes(39002)
              ? [
                  signed(authority, {
                    kind: 39002,
                    content: "",
                    created_at: 1,
                    tags: [
                      ["d", filter["#d"]?.[0] ?? ""],
                      ["p", viewer.pubkey],
                    ],
                  }),
                ]
              : [],
          ),
      },
      lifetime.signal,
      undefined,
      undefined,
      undefined,
      authority.pubkey,
      undefined,
      true,
    );
    const eligible = {
      ...h.session.agentChoices.snapshot(),
      selectable: [{ pubkey: viewer.pubkey, name: "Viewer", managed: true }],
    };
    const session = {
      ...h.session,
      agentChoices: { ...h.session.agentChoices, snapshot: () => eligible },
      viewer: viewer.pubkey,
      channels,
      channelWrites,
      messages: {
        ...h.session.messages,
        send: (id: string, text: string, recipients: readonly string[] = []) =>
          outbox.outbox.send({
            kind: 9,
            content: text,
            tags: [["h", id], ...recipients.map((key) => ["p", key])],
          }),
      },
    } as RelaySession;
    const started = vi.fn();
    const mounted = render(
      <SoloDraft session={session} scope="real-creation" onStarted={started} />,
    );
    try {
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(started).toHaveBeenCalledOnce());
      const created = publish.mock.calls
        .map(([event]) => event)
        .find((event) => event.kind === 9007);
      expect(created?.tags).toContainEqual([
        "name",
        explicit ? "Chosen title" : "Original #design prompt",
      ]);
      expect(created?.tags).toContainEqual(["t", SOLO_LABEL]);
      expect(created?.tags.some(([key]) => key === "about")).toBe(false);
      expect(created?.tags).toContainEqual(["ttl", "600"]);
      expect(publish.mock.calls.map(([event]) => event.kind)).toEqual([
        9007, 9,
      ]);
      expect(publish.mock.calls[1]?.[0].content).toContain(
        "[\\#design](buzz://channel/design)",
      );
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      mounted.unmount();
      lifetime.abort();
      outbox.dispose();
    }
  },
);

it("starts a new chat with a session card and no caption", async () => {
  const h = setup(),
    started = vi.fn(),
    user = userEvent.setup();
  const link = "[Session: Fix](buzz://channel/session-id)";
  writeView("test", "solo:new-draft", taggedDraft(link));
  render(<SoloDraft session={h.session} scope="test" onStarted={started} />);
  const send = screen.getByRole("button", { name: "Send message" });
  expect(send).toBeEnabled();
  await user.click(send);
  await waitFor(() => expect(started).toHaveBeenCalled());
  expect(h.channelWrites.create).toHaveBeenCalledOnce();
  expect(h.messages.send).toHaveBeenCalledWith(
    h.channelWrites.create.mock.calls[0]?.[0],
    expect.stringContaining(link),
    ["a".repeat(64)],
  );
});

it("starting titles omit structured leading tags but retain literal @ text", async () => {
  const f = setup();
  const content = "@Literal investigate this";
  writeView("clean-title", "solo:new-draft", taggedDraft(content));
  render(
    <SoloDraft session={f.session} scope="clean-title" onStarted={vi.fn()} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(f.messages.send).toHaveBeenCalledOnce());
  expect(f.channelWrites.create.mock.calls[0]?.[1]).toBe(content);
});

it.each(["remember", "off"])(
  "first Solo send reaches all tagged agents and leaves the chat's next draft empty, as every routed send does (%s)",
  async (mode) => {
    const { setRememberAgentsPreference } = await import(
      "../messages/mention-preferences"
    );
    const { followupDraft } = await import("../messages/mention-draft");
    const f = setup();
    const recipients = [
      { pubkey: "a".repeat(64), name: "Member agent" },
      { pubkey: "b".repeat(64), name: "Outside agent" },
    ];
    const tags = followupDraft(recipients);
    writeView("first-followup", "solo:new-draft", {
      ...tags,
      text: `${tags.text}Start here`,
    });
    if (mode === "off") setRememberAgentsPreference(false);
    const started = vi.fn();
    render(
      <SoloDraft
        session={f.session}
        scope="first-followup"
        onStarted={started}
      />,
    );
    try {
      await userEvent.click(
        screen.getByRole("button", { name: "Send message" }),
      );
      await waitFor(() => expect(started).toHaveBeenCalledOnce());
      expect(f.messages.send).toHaveBeenCalledOnce();
      expect(f.channelWrites.create).toHaveBeenCalledOnce();
      const id = started.mock.calls[0]?.[0];
      expect(readView("first-followup", `draft:${id}`, null)).toEqual({
        text: "",
        recipients: [],
      });
      expect(f.messages.send.mock.calls[0]?.[2]).toEqual(
        recipients.map((r) => r.pubkey),
      );
    } finally {
      setRememberAgentsPreference(true);
    }
  },
);

it("a routed first send leaves the chat's follow-up draft empty", async () => {
  const f = setup();
  const started = vi.fn();
  render(
    <SoloDraft
      session={f.session}
      scope="routed-followup"
      extensions={withPill}
      onStarted={started}
    />,
  );
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  await userEvent.type(screen.getByRole("textbox"), "Start here");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  const id = started.mock.calls[0]?.[0];
  expect(f.messages.send.mock.calls[0]?.[2]).toEqual(["a".repeat(64)]);
  expect(readView("routed-followup", `draft:${id}`, null)).toEqual({
    text: "",
    recipients: [],
  });
});

const notes = {
  name: "notes.txt",
  url: `https://relay.test/media/${"f".repeat(64)}.txt`,
  type: "text/plain",
  size: 5,
  sha256: "f".repeat(64),
};

it("uploads files as soon as they are attached to a new chat, then sends them", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  const upload = vi.fn();
  const uploadForNewChat = vi.fn(async () => notes);
  Object.assign(test.session, { attachments: { upload, uploadForNewChat } });
  writeView("test", "solo:new-draft", taggedDraft("See attached"));
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledOnce());
  expect(test.channelWrites.create).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(uploadForNewChat).toHaveBeenCalledOnce();
  expect(upload).not.toHaveBeenCalled();
  const id = test.channelWrites.create.mock.calls[0]?.[0];
  expect(test.messages.send).toHaveBeenCalledWith(
    id,
    expect.stringContaining("See attached"),
    ["a".repeat(64)],
    [notes],
  );
  if (!id) throw new Error("Expected a created chat");
  expect(
    attachmentDraft(test.session, `test:draft:${id}`, id).snapshot(),
  ).toEqual([]);
});

it("a file dropped anywhere on the new chat page attaches to its composer", async () => {
  const test = setup();
  const uploadForNewChat = vi.fn(async () => notes);
  Object.assign(test.session, {
    attachments: { upload: vi.fn(), uploadForNewChat },
  });
  render(<SoloDraft session={test.session} scope="test" onStarted={vi.fn()} />);
  const page = screen.getByRole("region", { name: "New chat" });
  const dataTransfer = {
    types: ["Files"],
    files: [new File(["notes"], "notes.txt", { type: "text/plain" })],
    dropEffect: "uninitialized",
  };
  fireEvent.dragEnter(page, { dataTransfer });
  expect(
    await screen.findByText("Drop files into this conversation"),
  ).toBeInTheDocument();
  fireEvent.drop(page, { dataTransfer });
  await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledOnce());
  expect(screen.queryByText("Drop files into this conversation")).toBeNull();
});

it("a failed upload blocks a new chat before anything is created", async () => {
  const test = setup(),
    user = userEvent.setup();
  const uploadForNewChat = vi.fn(async () => {
    throw new Error("Upload failed. Retry or remove this file.");
  });
  Object.assign(test.session, { attachments: { uploadForNewChat } });
  writeView("test", "solo:new-draft", taggedDraft("See attached"));
  render(<SoloDraft session={test.session} scope="test" onStarted={vi.fn()} />);
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  expect(
    await screen.findByRole("button", { name: "Retry notes.txt" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(test.channelWrites.create).not.toHaveBeenCalled();
  expect(test.messages.send).not.toHaveBeenCalled();
});

it("a first message that can't go out waits in the new chat's composer with its files", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  Object.assign(test.session, {
    attachments: { uploadForNewChat: vi.fn(async () => notes) },
  });
  test.messages.send.mockImplementationOnce(() => {
    throw new Error("offline");
  });
  writeView("test", "solo:new-draft", taggedDraft("See attached"));
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const [id] = onStarted.mock.calls[0] ?? [];
  expect(readView("test", `draft:${id}`, null)).toEqual(
    taggedDraft("See attached"),
  );
  expect(
    attachmentDraft(test.session, `test:draft:${id}`, id)
      .snapshot()
      .map((item) => item.uploaded),
  ).toEqual([notes]);
});

function soloModelAgents() {
  const pubkey = "a".repeat(64);
  const agent = {
    pubkey,
    key: pubkey,
    name: "Member agent",
    type: "test/agent",
  };
  const snapshot = { status: "ready", agents: [agent] };
  const types = [
    {
      key: "test/agent",
      models: () => ({
        current: "fast",
        sendDefaults: true,
        models: [
          { id: "fast", label: "Fast", efforts: [] },
          {
            id: "deep",
            label: "Deep",
            efforts: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      }),
    },
  ];
  return {
    find: (key: string) => (key === pubkey ? agent : undefined),
    joinable: () => [],
    sessionState: () => "unavailable" as const,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    types: () => types,
  } as unknown as Agents;
}

it("sends the selected model and effort with a Solo chat's first message", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  const pubkey = "a".repeat(64);
  const modelAgents = soloModelAgents();
  writeView("test", "solo:new-draft", taggedDraft("Start with care"));
  const firstMount = render(
    <AgentsContext.Provider value={modelAgents}>
      <SoloDraft session={test.session} scope="test" onStarted={onStarted} />
    </AgentsContext.Provider>,
  );

  await user.click(
    await screen.findByRole("button", { name: /Model.*effort/ }),
  );
  await user.click(
    await screen.findByRole("button", {
      name: "Model for Member agent in this chat",
    }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "Deep" }));
  const effort = await screen.findByLabelText(
    "Effort for Member agent in this chat",
  );
  effort.focus();
  await user.keyboard("{ArrowRight}");
  expect(effort).toHaveAttribute("aria-valuetext", "High");

  expect(readView("test", "solo:model-picks:solo:new-draft", null)).toEqual({
    [pubkey]: { model: "deep", effort: "high", type: "test/agent" },
  });
  firstMount.unmount();
  render(
    <AgentsContext.Provider value={modelAgents}>
      <SoloDraft session={test.session} scope="test" onStarted={onStarted} />
    </AgentsContext.Provider>,
  );
  await user.click(
    screen.getByRole("button", { name: "Model and effort for this chat" }),
  );
  const restoredModel = await screen.findByRole("button", {
    name: "Model for Member agent in this chat",
  });
  expect(restoredModel).toHaveTextContent("Deep");
  expect(
    await screen.findByLabelText("Effort for Member agent in this chat"),
  ).toHaveAttribute("aria-valuetext", "High");

  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const [id] = onStarted.mock.calls[0] ?? [];
  expect(test.messages.send).toHaveBeenLastCalledWith(
    id,
    "@Member agent Start with care",
    [pubkey],
    [],
    undefined,
    [],
    { [pubkey]: { model: "deep", effort: "high" } },
  );
  expect(readView("test", `solo:model-picks:${id}`, null)).toEqual({
    [pubkey]: { model: "deep", effort: "high", type: "test/agent" },
  });
  await waitFor(() =>
    expect(
      readView("test", "solo:model-picks:solo:new-draft", null),
    ).toBeNull(),
  );
});

it("restores model and effort after a refused first Solo start", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const pubkey = "a".repeat(64);
  const modelAgents = soloModelAgents();
  const refuse = refusedStart(test);
  writeView("test", "solo:new-draft", taggedDraft("Retry with care"));
  render(
    <AgentsContext.Provider value={modelAgents}>
      <SoloDraft
        session={test.session}
        scope="test"
        onStarted={onStarted}
        onFailed={onFailed}
      />
    </AgentsContext.Provider>,
  );

  await user.click(
    screen.getByRole("button", { name: "Model and effort for this chat" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Model for Member agent in this chat" }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "Deep" }));
  const effort = await screen.findByLabelText(
    "Effort for Member agent in this chat",
  );
  effort.focus();
  await user.keyboard("{ArrowRight}");
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const [id] = onStarted.mock.calls[0] ?? [];
  expect(test.messages.send.mock.calls[0]?.at(-1)).toEqual({
    [pubkey]: { model: "deep", effort: "high" },
  });

  await refuse();
  await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
  expect(readView("test", `solo:model-picks:${id}`, null)).toBeNull();
  expect(readView("test", "solo:model-picks:solo:new-draft", null)).toEqual({
    [pubkey]: { model: "deep", effort: "high", type: "test/agent" },
  });
  expect(
    screen.getByRole("button", { name: "Model and effort for this chat" }),
  ).toBeVisible();

  test.channelWrites.ready = Promise.resolve();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(2));
  expect(test.messages.send.mock.calls[1]?.at(-1)).toEqual({
    [pubkey]: { model: "deep", effort: "high" },
  });
});

it.each(["select", "reset"])(
  "consumes the saved New chat baseline after an unsaved %s and storage recovery",
  async (action) => {
    const test = setup(),
      onStarted = vi.fn(),
      user = userEvent.setup();
    const pubkey = "a".repeat(64);
    const key = "solo:model-picks:solo:new-draft";
    const modelAgents = soloModelAgents();
    writeView("test", "solo:new-draft", taggedDraft("First start"));
    const baseline = {
      [pubkey]: {
        model: action === "select" ? "fast" : "deep",
        type: "test/agent",
      },
    };
    writeView("test", key, baseline);
    const view = () => (
      <AgentsContext.Provider value={modelAgents}>
        <SoloDraft session={test.session} scope="test" onStarted={onStarted} />
      </AgentsContext.Provider>
    );
    const first = render(view());
    await user.click(
      await screen.findByRole("button", { name: /Model.*effort/ }),
    );
    const storage = failingViewWrites([key]);
    try {
      if (action === "select") {
        await user.click(
          await screen.findByRole("button", {
            name: "Model for Member agent in this chat",
          }),
        );
        await user.click(
          await screen.findByRole("menuitemradio", { name: "Deep" }),
        );
      } else {
        await user.click(
          screen.getByRole("button", { name: "Reset model and effort" }),
        );
      }
      expect(readView("test", key, null)).toEqual(baseline);
    } finally {
      storage.mockRestore();
    }
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    const [id] = onStarted.mock.calls[0] ?? [];
    expect(test.messages.send.mock.calls[0]?.[6]).toEqual(
      action === "select" ? { [pubkey]: { model: "deep" } } : undefined,
    );
    expect(readView("test", `solo:model-picks:${id}`, null)).toEqual(
      action === "select"
        ? { [pubkey]: { model: "deep", type: "test/agent" } }
        : null,
    );
    expect(readView("test", key, null)).toBeNull();
    first.unmount();
    writeView("test", "solo:new-draft", taggedDraft("Next start"));
    render(view());
    await user.click(
      await screen.findByRole("button", { name: /Model.*effort/ }),
    );
    expect(
      await screen.findByRole("button", {
        name: "Model for Member agent in this chat",
      }),
    ).toHaveTextContent("Fast");
  },
);

it.each(["before Send", "after notification", "during upload"])(
  "preserves newer shared model choices written %s while the first start awaits an upload",
  async (timing) => {
    const test = setup(),
      onStarted = vi.fn(),
      user = userEvent.setup();
    const pubkey = "a".repeat(64);
    const key = "solo:model-picks:solo:new-draft";
    const newer = { [pubkey]: { model: "fast", type: "test/agent" } };
    let release!: () => void;
    const pending = new Promise<typeof notes>((resolve) => {
      release = () => resolve(notes);
    });
    const uploadForNewChat = vi.fn(() => pending);
    Object.assign(test.session, { attachments: { uploadForNewChat } });
    writeView("test", "solo:new-draft", taggedDraft("First start"));
    writeView("test", key, {
      [pubkey]: { model: "deep", effort: "high", type: "test/agent" },
    });
    render(
      <AgentsContext.Provider value={soloModelAgents()}>
        <SoloDraft session={test.session} scope="test" onStarted={onStarted} />
      </AgentsContext.Provider>,
    );
    try {
      await user.upload(
        screen.getByLabelText("Choose attachments"),
        new File(["notes"], "notes.txt", { type: "text/plain" }),
      );
      await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledOnce());
      if (timing === "during upload")
        await user.click(screen.getByRole("button", { name: "Send message" }));
      const storageKey = `buzz-view.v1:${JSON.stringify(["test", key])}`;
      localStorage.setItem(storageKey, JSON.stringify(newer));
      if (timing === "after notification") {
        const send = screen.getByRole("button", { name: "Send message" });
        act(() => {
          // Deliver the external revision, then submit before its render commits.
          window.dispatchEvent(
            new StorageEvent("storage", {
              key: storageKey,
              storageArea: localStorage,
            }),
          );
          send.click();
        });
      }
      if (timing === "before Send")
        await user.click(screen.getByRole("button", { name: "Send message" }));
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
      expect(test.channelWrites.start).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        release();
        await pending;
      });
    }
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    expect(test.messages.send.mock.calls[0]?.at(-1)).toEqual({
      [pubkey]: { model: "deep", effort: "high" },
    });
    expect(readView("test", key, null)).toEqual(newer);
  },
);

it("keeps a newer New chat draft while the first start awaits model ownership", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  writeView("test", "solo:new-draft", taggedDraft("First start"));
  render(
    <AgentsContext.Provider value={soloModelAgents()}>
      <SoloDraft session={test.session} scope="test" onStarted={onStarted} />
    </AgentsContext.Provider>,
  );
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const requested = new Promise<void>((resolve) => {
    entered = resolve;
  });
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (_name: string, run: () => unknown) => {
        entered();
        await pending;
        return run();
      },
    },
  });
  const newer = taggedDraft("Newer draft");
  try {
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await requested;
    expect(test.messages.send).toHaveBeenCalledOnce();
    expect(onStarted).not.toHaveBeenCalled();
    // Another context can begin its next draft while local ownership is pending.
    writeView("test", "solo:new-draft", newer);
    writeView("test", "solo:settings", { name: "Newer title" });
  } finally {
    await act(async () => {
      release();
      await pending;
    });
  }
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(readView("test", "solo:new-draft", null)).toEqual(newer);
  expect(readView("test", "solo:settings", null)).toEqual({
    name: "Newer title",
  });
});

it.each([
  ...["created", "refused"].flatMap((outcome) =>
    ["saved", "unsaved"].map((storage) => ({ outcome, storage })),
  ),
  { outcome: "refused", storage: "pending" },
])(
  "keeps a later New chat's $storage choices separate while the first start is $outcome",
  async ({ outcome, storage }) => {
    const test = setup(),
      onStarted = vi.fn(),
      onFailed = vi.fn(),
      user = userEvent.setup();
    const pubkey = "a".repeat(64);
    const modelAgents = soloModelAgents();
    const picks = { [pubkey]: { model: "deep", type: "test/agent" } };
    let settle!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      settle = () => {
        if (outcome === "created") resolve();
        else reject(new ChatNotStarted("Channel creation rejected"));
      };
    });
    test.channelWrites.ready = ready;
    writeView("test", "solo:new-draft", taggedDraft("First start"));
    writeView("test", "solo:model-picks:solo:new-draft", picks);
    const view = () => (
      <AgentsContext.Provider value={modelAgents}>
        <SoloDraft
          session={test.session}
          scope="test"
          onStarted={onStarted}
          onFailed={onFailed}
        />
      </AgentsContext.Provider>
    );
    const first = render(view());
    let writes: ReturnType<typeof failingViewWrites> | undefined;
    let release: (() => void) | undefined;
    let tail: Promise<unknown> = Promise.resolve();
    try {
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
      first.unmount();
      render(view());
      if (storage === "pending") {
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered!: () => void;
        const requested = new Promise<void>((resolve) => {
          entered = resolve;
        });
        Object.defineProperty(navigator, "locks", {
          configurable: true,
          value: {
            request: (_name: string, run: () => unknown) => {
              entered();
              const result = tail.then(run);
              tail = result.catch(() => {});
              return result;
            },
          },
        });
        // Queue refusal recovery before the new pick's save can acquire ownership.
        await act(async () => {
          settle();
          await ready.catch(() => {});
          await requested;
        });
      }
      if (storage === "unsaved")
        writes = failingViewWrites(["solo:model-picks:solo:new-draft"]);
      await user.click(
        screen.getByRole("button", { name: "Model and effort for this chat" }),
      );
      const model = screen.getByRole("button", {
        name: "Model for Member agent in this chat",
      });
      expect(model).toHaveTextContent("Fast");
      // Deliberately choose the same model: equality with the first start's
      // snapshot must not let that start clear this later draft's choice.
      await user.click(model);
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Deep" }),
      );
      if (writes) {
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Could not save model and effort",
        );
        writes.mockRestore();
        // A successful text save must not clear the unsaved model guard.
        const input = screen.getByRole("textbox") as HTMLTextAreaElement;
        input.value = " ";
        fireEvent.input(input);
      }
    } finally {
      writes?.mockRestore();
      await act(async () => {
        release?.();
        await tail;
        if (storage !== "pending") settle();
        await ready.catch(() => {});
      });
    }
    if (outcome === "refused")
      await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    expect(readView("test", "solo:model-picks:solo:new-draft", null)).toEqual(
      storage === "unsaved" ? null : picks,
    );
    expect(
      screen.getByRole("button", {
        name: "Model for Member agent in this chat",
      }),
    ).toHaveTextContent("Deep");
    expect(screen.getByRole("textbox")).not.toHaveTextContent("First start");
    if (outcome === "refused")
      expect(onFailed).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("New chat has a newer draft"),
      );
  },
);

it.each(
  ["missing", "rejected"].flatMap((ownership) =>
    [false, true].map((newer) => ({ ownership, newer })),
  ),
)(
  "retains a refused start for retry after $ownership ownership, protecting newer work=$newer",
  async ({ ownership, newer }) => {
    const test = setup(),
      onStarted = vi.fn(),
      onFailed = vi.fn(),
      user = userEvent.setup();
    const pubkey = "a".repeat(64);
    const picks = { [pubkey]: { model: "deep", type: "test/agent" } };
    const modelKey = "solo:model-picks:solo:new-draft";
    const modelAgents = soloModelAgents();
    const refuse = refusedStart(test);
    writeView(
      "test",
      "solo:new-draft",
      taggedDraft("Keep this refused message"),
    );
    writeView("test", modelKey, picks);
    const view = () => (
      <AgentsContext.Provider value={modelAgents}>
        <SoloDraft
          session={test.session}
          scope="test"
          onStarted={onStarted}
          onFailed={onFailed}
        />
      </AgentsContext.Provider>
    );
    const first = render(view());
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    const id = onStarted.mock.calls[0]?.[0];
    first.unmount();
    render(view());
    const locks = navigator.locks;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value:
        ownership === "missing"
          ? undefined
          : {
              request: async () => {
                throw new Error("Lock refused");
              },
            },
    });
    try {
      await refuse();
      await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
      // Ownership failure changes neither shared model map.
      expect(readView("test", modelKey, null)).toBeNull();
      expect(readView("test", `solo:model-picks:${id}`, null)).toEqual(picks);
      expect(onFailed.mock.calls[0]?.[1]).toContain("Window ownership");
      const retry = onFailed.mock.calls[0]?.[2];
      expect(retry).toEqual(expect.any(Function));
      await act(async () => {
        await retry();
      });
      expect(onFailed).toHaveBeenCalledTimes(2);
      expect(onFailed.mock.calls[1]?.[2]).toBe(retry);
      expect(readView("test", modelKey, null)).toBeNull();
      expect(readView("test", `solo:model-picks:${id}`, null)).toEqual(picks);
    } finally {
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: locks,
      });
    }
    if (newer) {
      await user.type(screen.getByRole("textbox"), "Newer draft");
      await user.click(
        screen.getByRole("button", { name: "Model and effort for this chat" }),
      );
      await user.click(
        screen.getByRole("button", {
          name: "Model for Member agent in this chat",
        }),
      );
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Fast" }),
      );
    }
    await act(async () => {
      const retry = onFailed.mock.calls[1]?.[2];
      await Promise.all([retry(), retry()]);
    });
    await waitFor(() => expect(onFailed).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("textbox")).toHaveTextContent(
      newer ? "Newer draft" : "Keep this refused message",
    );
    expect(readView("test", modelKey, null)).toEqual(
      newer ? { [pubkey]: { model: "fast", type: "test/agent" } } : picks,
    );
    expect(readView("test", `solo:model-picks:${id}`, null)).toBeNull();
    expect(onFailed.mock.calls[2]?.[1]).toContain(
      newer ? "New chat has a newer draft" : "Your message is back in New chat",
    );
    // A stale callback is harmless after a completed restore.
    writeView("test", `solo:model-picks:${id}`, picks);
    await act(async () => {
      await onFailed.mock.calls[1]?.[2]();
    });
    expect(readView("test", `solo:model-picks:${id}`, null)).toEqual(picks);
    expect(onFailed).toHaveBeenCalledTimes(3);
    expect(test.messages.send).toHaveBeenCalledOnce();
  },
);

it.each(["chat", "draft", "missing", "rejected"])(
  "reports and recovers failed first-send choice storage for the %s",
  async (failure) => {
    const test = setup(),
      onStarted = vi.fn(),
      user = userEvent.setup();
    const pubkey = "a".repeat(64);
    const picks = { [pubkey]: { model: "deep", type: "test/agent" } };
    writeView("test", "solo:new-draft", taggedDraft("Keep the first send"));
    writeView("test", "solo:model-picks:solo:new-draft", picks);
    const create = test.channelWrites.start.getMockImplementation();
    if (!create) throw new Error("Expected the start fixture implementation");
    let storage: ReturnType<typeof failingViewWrites> | undefined;
    test.channelWrites.start.mockImplementationOnce((...args) => {
      if (failure === "missing" || failure === "rejected") {
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
      } else
        storage = failingViewWrites([
          failure === "chat"
            ? `solo:model-picks:${args[0]}`
            : "solo:model-picks:solo:new-draft",
        ]);
      return create(...args);
    });
    render(
      <ToastProvider>
        <AgentsContext.Provider value={soloModelAgents()}>
          <SoloDraft
            session={test.session}
            scope="test"
            onStarted={onStarted}
          />
        </AgentsContext.Provider>
      </ToastProvider>,
    );
    try {
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
      expect(test.messages.send.mock.calls[0]?.at(-1)).toEqual({
        [pubkey]: { model: "deep" },
      });
      expect(
        await screen.findByRole("dialog", {
          name:
            failure === "chat"
              ? "Could not save model and effort for this chat. Choose them again before your next message."
              : "Could not clear model and effort from New chat. Reset them before starting another chat.",
        }),
      ).toBeVisible();
    } finally {
      storage?.mockRestore();
    }
    if (failure === "draft") {
      expect(readView("test", "solo:model-picks:solo:new-draft", null)).toEqual(
        picks,
      );
      await user.click(
        screen.getByRole("button", { name: "Model and effort for this chat" }),
      );
      await user.click(
        screen.getByRole("button", { name: "Reset model and effort" }),
      );
      expect(readView("test", "solo:model-picks:solo:new-draft", null)).toEqual(
        {},
      );
      expect(test.messages.send).toHaveBeenCalledOnce();
    }
  },
);

it("keeps provider defaults unchanged on an unconfigured Solo first message", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  const pubkey = "a".repeat(64);
  const agent = {
    pubkey,
    key: pubkey,
    name: "Member agent",
    type: "test/agent",
  };
  const snapshot = { status: "ready", agents: [agent] };
  const types = [
    {
      key: "test/agent",
      models: () => ({
        current: "fast",
        sendDefaults: true,
        models: [
          { id: "fast", label: "Fast", efforts: [] },
          { id: "deep", label: "Deep", efforts: [] },
        ],
      }),
    },
  ];
  const modelAgents = {
    find: (key: string) => (key === pubkey ? agent : undefined),
    joinable: () => [],
    sessionState: () => "unavailable" as const,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    types: () => types,
  } as unknown as Agents;
  writeView("test", "solo:new-draft", taggedDraft("Use configured defaults"));
  render(
    <AgentsContext.Provider value={modelAgents}>
      <SoloDraft session={test.session} scope="test" onStarted={onStarted} />
    </AgentsContext.Provider>,
  );

  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const [id] = onStarted.mock.calls[0] ?? [];
  expect(test.messages.send).toHaveBeenLastCalledWith(
    id,
    "@Member agent Use configured defaults",
    [pubkey],
  );
  expect(readView("test", `solo:model-picks:${id}`, null)).toBeNull();
});

it("resumes a new chat's interrupted upload after navigating away and back", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  const uploadForNewChat = vi.fn(
    (_file: File, signal: AbortSignal) =>
      new Promise<typeof notes>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      ),
  );
  Object.assign(test.session, { attachments: { uploadForNewChat } });
  writeView("test", "solo:new-draft", taggedDraft("See attached"));
  const view = render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledOnce());
  view.unmount();

  uploadForNewChat.mockImplementation(async () => notes);
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledTimes(2));
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(test.messages.send).toHaveBeenCalledWith(
    test.channelWrites.create.mock.calls[0]?.[0],
    expect.stringContaining("See attached"),
    ["a".repeat(64)],
    [notes],
  );
});

it("shows an editable ordinary source link and sends it to the pill's default agent", async () => {
  const t = setup();
  const linkedId = "22222222-2222-4222-8222-222222222222";
  const source: LinkedChat = {
    channelId: "design",
    link: `buzz://message?channel=design&id=${"c".repeat(64)}&thread=${"b".repeat(64)}`,
  };
  writeView("test", linkedDraftKey(linkedId), source);
  const started = vi.fn();
  render(
    <SoloDraft
      session={t.session}
      scope="test"
      linkedId={linkedId}
      source={source}
      extensions={withPill}
      onStarted={started}
    />,
  );
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(input.value).toContain(source.link);
  expect(input.value).not.toContain("@Member agent");
  expect(t.channelWrites.create).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  const id = started.mock.calls[0]?.[0];
  expect(t.channelWrites.start).toHaveBeenCalledWith(
    id,
    expect.any(String),
    ["a".repeat(64)],
    undefined,
    false,
    undefined,
  );
  expect(t.messages.send).toHaveBeenCalledWith(
    id,
    expect.stringContaining(source.link),
    ["a".repeat(64)],
  );
});
it("types prose after a seeded source link instead of extending it", async () => {
  const t = setup();
  const linkedId = "22222222-2222-4222-8222-222222222222";
  const source: LinkedChat = {
    channelId: "design",
    link: `buzz://message?channel=design&id=${"c".repeat(64)}`,
  };
  writeView("test", linkedDraftKey(linkedId), source);
  render(
    <SoloDraft
      session={t.session}
      scope="test"
      linkedId={linkedId}
      source={source}
      focusRequest={1}
      extensions={withPill}
      onStarted={vi.fn()}
    />,
  );
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(input.value).toBe(`${source.link} `);
  expect(input.selectionStart).toBe(input.value.length);
  await userEvent.keyboard("Investigate");
  expect(input.value).toBe(`${source.link} Investigate`);
});
it("starting again from a sent source seeds its link and the pill's default agent again", async () => {
  const t = setup();
  const linkedId = "22222222-2222-4222-8222-222222222222";
  const source: LinkedChat = {
    channelId: "design",
    link: "buzz://channel/design",
  };
  const start = () => {
    writeView("test", linkedDraftKey(linkedId), source);
    return render(
      <SoloDraft
        session={t.session}
        scope="test"
        linkedId={linkedId}
        source={source}
        extensions={withPill}
        onStarted={started}
      />,
    );
  };
  const started = vi.fn();
  const first = start();
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  first.unmount();
  start();
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  const again = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(again.value).toContain(source.link);
  expect(again.value).not.toContain("@Member agent");
});
it("keeps the pill's default agent out of the text when the linked draft is reopened", async () => {
  const t = setup();
  const linkedId = "22222222-2222-4222-8222-222222222222";
  const source: LinkedChat = {
    channelId: "design",
    link: "buzz://channel/design",
  };
  writeView("test", linkedDraftKey(linkedId), source);
  const draft = () => (
    <SoloDraft
      session={t.session}
      scope="test"
      linkedId={linkedId}
      source={source}
      extensions={withPill}
      onStarted={vi.fn()}
    />
  );
  const first = render(draft());
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  await userEvent.clear(input);
  await userEvent.type(input, source.link);
  await waitFor(() =>
    expect(
      readView<{ text?: string } | null>(
        "test",
        `${linkedDraftKey(linkedId)}:new-draft`,
        null,
      )?.text,
    ).toBe(source.link),
  );
  first.unmount();
  render(draft());
  const reopened = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(reopened.value).toBe(source.link);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(reopened.value).not.toContain("@Member agent");
  // The pill still holds the default agent; it is never a removable tag.
  expect(sendingTo("Member agent")).toBeInTheDocument();
});
it("keeps an edited linked draft instead of reinserting its removed source", async () => {
  const t = setup();
  const started = vi.fn();
  const linkedId = "22222222-2222-4222-8222-222222222222";
  const source: LinkedChat = {
    channelId: "design",
    link: "buzz://channel/design",
  };
  writeView(
    "test",
    `${linkedDraftKey(linkedId)}:new-draft`,
    taggedDraft("Changed request"),
  );
  render(
    <SoloDraft
      session={t.session}
      scope="test"
      linkedId={linkedId}
      source={source}
      onStarted={started}
    />,
  );
  expect(
    (screen.getByRole("textbox") as HTMLTextAreaElement).value,
  ).not.toContain(source.link);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(t.messages.send.mock.calls[0]?.[1]).toBe(
    "@Member agent Changed request",
  );
});
const aaron = { pubkey: "e".repeat(64), name: "Aaron" };
/** A new Solo chat over the real mentions completion, with the agent
 * inventory answered by `read`; returns the composer and the `p` tags the
 * eventual send carried. */
function soloDraftWithInventory(
  read: () => Promise<{ definitions: []; identities: [typeof aaron] }>,
) {
  const test = setup();
  const library = createAgentLibrary(read);
  const session = {
    ...test.session,
    agentChoices: createAgentChoices({
      scope: "test",
      library: library.queries,
      signal: new AbortController().signal,
    }),
  } as unknown as RelaySession;
  const completions: readonly Contribution<ComposerCompletion>[] = [
    {
      id: "typeahead",
      key: "buzz.mentions/typeahead",
      pluginId: "buzz.mentions",
      revision: "1",
      title: "Mention",
      match: ({ text, start }) => mentionQuery(text, start),
      component: MentionCompletion,
    },
  ];
  const empty: [] = [];
  const none = { snapshot: () => empty, subscribe: () => () => {} };
  const onStarted = vi.fn();
  render(
    <SoloDraft
      session={session}
      scope="test"
      onStarted={onStarted}
      extensions={{
        tools: none,
        inline: none,
        completions: { snapshot: () => completions, subscribe: () => () => {} },
      }}
    />,
  );
  const input = screen.getByRole("textbox");
  return {
    input,
    chip: () =>
      within(input).queryByRole("img", { name: "Resolving mention Aaron" }),
    async send() {
      await userEvent.click(
        screen.getByRole("button", { name: "Send message" }),
      );
      await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
      const id = test.channelWrites.create.mock.calls[0]?.[0];
      expect(test.channelWrites.start).toHaveBeenCalledWith(
        id,
        expect.any(String),
        [aaron.pubkey],
        undefined,
        false,
        undefined,
      );
      expect(test.messages.send).toHaveBeenCalledWith(id, "@Aaron hi", [
        aaron.pubkey,
      ]);
    },
    dispose: library.dispose,
  };
}
it("tags an agent whose name was typed with Space before the agent inventory loaded", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const draft = soloDraftWithInventory(async () => {
    await gate;
    return { definitions: [], identities: [aaron] };
  });
  try {
    // Fast typing: the inventory has not answered when Space arrives.
    await userEvent.type(draft.input, "@Aaron hi");
    expect(draft.input).toHaveValue("@Aaron hi");
    expect(draft.chip()).toHaveAttribute("aria-busy", "true");
    await act(async () => release());
    await waitFor(() => expect(draft.chip()).toBeNull());
    await draft.send();
  } finally {
    release();
    draft.dispose();
  }
});
it("tags an agent whose name was typed with Space while a retry after a failed inventory read loads", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const draft = soloDraftWithInventory(async () => {
    if (reads++ === 0) throw new Error("offline");
    await gate;
    return { definitions: [], identities: [aaron] };
  });
  try {
    await userEvent.click(
      await screen.findByRole("button", { name: "Retry agents" }),
    );
    // The failed read settled the roster empty; the retry's Space must wait
    // for the retry, not consume that settled roster.
    await userEvent.type(draft.input, "@Aaron hi");
    expect(draft.input).toHaveValue("@Aaron hi");
    expect(draft.chip()).toHaveAttribute("aria-busy", "true");
    await act(async () => release());
    await waitFor(() => expect(draft.chip()).toBeNull());
    await draft.send();
  } finally {
    release();
    draft.dispose();
  }
});

it("does not start a named Solo chat from a file alone", async () => {
  const test = setup(),
    user = userEvent.setup();
  const uploadForNewChat = vi.fn(async () => notes);
  Object.assign(test.session, { attachments: { uploadForNewChat } });
  render(<SoloDraft session={test.session} scope="test" onStarted={vi.fn()} />);
  await user.clear(screen.getByRole("textbox"));
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledOnce());
  // The pill addresses the main agent, so only the missing text disables Send.
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  const form = screen.getByRole("textbox").closest("form");
  if (!form) throw new Error("Expected composer form");
  fireEvent.submit(form);
  expect(test.channelWrites.create).not.toHaveBeenCalled();
  expect(test.messages.send).not.toHaveBeenCalled();
});
