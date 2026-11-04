import { AgentTabs } from "../agents/AgentTabs";
import type {
  Agent,
  Agents,
  NewAgent,
  RegisteredAgentType,
} from "../../features/agents/service";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pubkeyOf } from "../../features/agents/membership";
import { ownerReads } from "../../features/agents/reads";
import {
  fileStore,
  localStore,
  type AgentStore,
} from "../../features/agents/state";
import type { AgentViewProps } from "../../features/agents/service";
import { AgentCreateDialog } from "../agents/AgentCreateDialog";
import type { HostProcessOptions } from "../../features/host/service";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { defaults, type Config } from "./config";
import { sessionTag } from "./prompt";
import { CodexProvider, createTabs } from "./tabs";
import { CodexRuntime } from "./runtime";
import type { Wire } from "./rpc";
import { CodexSetup } from "./setup";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  // jsdom has no layout observers; the compact model picker sizes itself with one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
function fixture({
  signedIn = true,
  requiresOpenaiAuth = true,
  installed = true,
  saved = {},
  turns = () => ({ result: { data: [] } }),
  threads = [],
  configured = {},
  modelAReasoningEfforts = ["low", "high"],
  modelBReasoningEfforts = ["medium"],
  storage = localStore(),
  channels = [{ id: "channel", name: "general" }],
}: {
  /** Agent storage, which keeps the provider defaults. */
  storage?: AgentStore;
  /** The community's channels, read each time they are listed. */
  channels?: readonly ChannelSummary[];
  signedIn?: boolean;
  /** Whether the configured model provider needs an OpenAI sign-in. */
  requiresOpenaiAuth?: boolean;
  installed?: boolean;
  saved?: Record<string, unknown>;
  turns?: (threadId: string) => Wire;
  threads?: { id: string; name: string; updatedAt: number }[] | string;
  configured?: { model?: string; model_reasoning_effort?: string };
  modelAReasoningEfforts?: string[];
  modelBReasoningEfforts?: string[];
} = {}) {
  const processes: { end: ReturnType<typeof vi.fn> }[] = [];
  // Buzz's copy, as its launcher answers: `codex login` runs until it ends.
  const disk = { signedIn, installed };
  const logins: ReturnType<typeof deferred<number | null>>[] = [];
  const spawn = vi.fn(async (id: string, options?: HostProcessOptions) => {
    const exit = deferred<number | null>();
    if (id === "codex") {
      const args = options?.args?.join(" ");
      if (args === "login") logins.push(exit);
      else if (!disk.installed) exit.resolve(127);
      else if (args === "login status") exit.resolve(disk.signedIn ? 0 : 1);
      else {
        queueMicrotask(() => options?.onStdout?.("codex-cli 0.162.1\n"));
        exit.resolve(0);
      }
      return {
        write: async (_text: string) => {},
        end: vi.fn(async () => {
          exit.resolve(0);
        }),
        kill: vi.fn(async () => {
          exit.resolve(null);
        }),
        exited: exit.promise,
      };
    }
    const process = {
      write: async (text: string) => {
        const wire: Wire = JSON.parse(text);
        if (wire.id == null) return;
        if (wire.method === "thread/turns/list") {
          const reply = turns((wire.params as { threadId: string }).threadId);
          options?.onStdout?.(`${JSON.stringify({ id: wire.id, ...reply })}\n`);
          return;
        }
        let result: unknown = {};
        if (wire.method === "config/read") result = { config: configured };
        if (wire.method === "thread/list") {
          if (typeof threads === "string") {
            options?.onStdout?.(
              `${JSON.stringify({
                id: wire.id,
                error: { code: -32603, message: threads },
              })}\n`,
            );
            return;
          }
          const { searchTerm } = wire.params as { searchTerm: string };
          result = {
            data: threads.filter((thread) => thread.name.includes(searchTerm)),
            nextCursor: null,
          };
        }
        if (wire.method === "account/read")
          result = {
            account: disk.signedIn
              ? { type: "chatgpt", email: "test@example.com" }
              : null,
            requiresOpenaiAuth,
          };
        if (wire.method === "model/list")
          result = {
            data: [
              {
                id: "a",
                model: "model-a",
                displayName: "Model A",
                description: "Model A description.",
                isDefault: true,
                defaultReasoningEffort: "low",
                supportedReasoningEfforts: modelAReasoningEfforts.map(
                  (reasoningEffort) => ({ reasoningEffort }),
                ),
              },
              {
                id: "b",
                model: "model-b",
                displayName: "Model B",
                description: "Model B description.",
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: modelBReasoningEfforts.map(
                  (reasoningEffort) => ({ reasoningEffort }),
                ),
              },
            ],
            nextCursor: null,
          };
        options?.onStdout?.(`${JSON.stringify({ id: wire.id, result })}\n`);
      },
      end: vi.fn(async () => {
        exit.resolve(0);
      }),
      kill: vi.fn(async () => {
        exit.resolve(null);
      }),
      exited: exit.promise,
    };
    processes.push(process);
    return process;
  });
  const setup = new CodexSetup(spawn);
  const provider = new CodexProvider(spawn, storage, setup);
  const relay = {
    snapshot: () => ({
      status: "ready",
      session: {
        channels: {
          list: () => ({ channels }),
        },
      },
    }),
  } as unknown as RelayData;
  const sessions = localStore({
    getItem: () => JSON.stringify(saved),
    setItem: () => undefined,
  } as unknown as Storage);
  const runtime = new CodexRuntime(
    spawn,
    (key) => ownerReads(relay, pubkeyOf(key)),
    async () => undefined,
    sessions,
    (raw) => provider.resolve(raw),
  );
  const tabs = createTabs(provider, runtime, spawn, setup);
  const props = (settings = defaults, save = vi.fn(async () => {})) =>
    ({
      agent: {
        key: "a".repeat(64),
        pubkey: "a".repeat(64),
        name: "Sol",
        config: settings,
      },
      save,
    }) as unknown as AgentViewProps<Config>;
  return {
    spawn,
    processes,
    provider,
    runtime,
    setup,
    tabs,
    props,
    disk,
    logins,
  };
}
it("lists saved conversations and shows one's Codex thread, or that Codex no longer has it", async () => {
  const root = "e".repeat(64);
  const f = fixture({
    saved: {
      [JSON.stringify(["channel", "channel"])]: {
        threadId: "deleted",
        workspace: "/w",
        at: 1,
      },
      [JSON.stringify(["channel", root])]: {
        threadId: "kept",
        workspace: "/w",
        at: 2,
      },
    },
    turns: (threadId) =>
      threadId === "kept"
        ? {
            result: {
              data: [
                {
                  id: "turn-1",
                  status: "completed",
                  error: null,
                  startedAt: 1,
                  completedAt: 2,
                  items: [
                    {
                      type: "userMessage",
                      id: "u",
                      content: [
                        { type: "text", text: 'Request: "what changed?"' },
                      ],
                    },
                    { type: "agentMessage", id: "a", text: "Two files." },
                  ],
                },
              ],
              nextCursor: null,
            },
          }
        : {
            error: { code: -32600, message: `thread not loaded: ${threadId}` },
          },
  });
  const save = vi.fn();
  render(<f.tabs.ActivityTab {...f.props(defaults, save)} />);
  const viewButton = (index: number) =>
    screen.getAllByRole("button", { name: /^View transcript/ })[
      index
    ] as HTMLElement;
  expect(screen.getByTitle("general · thread eeeeeeee")).toBeVisible();
  fireEvent.click(viewButton(0));
  expect(await screen.findByText("what changed?")).toBeVisible();
  expect(screen.getByText("Two files.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Refresh transcript" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh transcript" }),
    ).not.toHaveAttribute("data-loading"),
  );
  expect(screen.getByText("Two files.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Back to profile" }));
  fireEvent.click(viewButton(1));
  expect(
    await screen.findByText(/Codex has no history for this conversation/),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("sets the conversation the profile was opened from apart from recent conversations", () => {
  const root = "e".repeat(64);
  const f = fixture({
    saved: {
      [JSON.stringify(["channel", "channel"])]: {
        threadId: "channel-thread",
        workspace: "/w",
        at: 1,
      },
      [JSON.stringify(["channel", root])]: {
        threadId: "thread",
        workspace: "/w",
        at: 2,
      },
    },
  });
  render(
    <f.tabs.ActivityTab
      {...f.props()}
      conversation={{ channelId: "channel", rootId: root }}
    />,
  );
  const opened = screen.getByRole("region", { name: "This thread" });
  expect(
    within(opened).getByRole("button", { name: /^View transcript/ }),
  ).toBeVisible();
  expect(screen.getByTitle("general · channel")).toBeVisible();
  expect(screen.queryByText(/thread eeeeeeee/)).toBeNull();
});

it("brings an open transcript's tab back, and closes it when the profile moves", async () => {
  const root = "e".repeat(64);
  const f = fixture({
    saved: {
      [JSON.stringify(["channel", root])]: {
        threadId: "kept",
        workspace: "/w",
        at: 2,
      },
    },
  });
  const Panel = ({
    conversation,
  }: {
    conversation: { channelId: string; rootId?: string };
  }) => (
    <PanelWorkspace
      value="profile"
      select={() => undefined}
      items={[
        {
          id: "profile",
          label: "Sol",
          close: () => undefined,
          content: (
            <f.tabs.ActivityTab {...f.props()} conversation={conversation} />
          ),
        },
      ]}
    />
  );
  const user = userEvent.setup();
  const view = render(
    <Panel conversation={{ channelId: "channel", rootId: root }} />,
  );
  const tab = (name: string) => screen.getByRole("tab", { name });
  const viewHere = () =>
    user.click(
      within(screen.getByRole("region", { name: "This thread" })).getByRole(
        "button",
        { name: /^View transcript/ },
      ),
    );
  const transcript = "general · thread eeeeeeee";
  await viewHere();
  expect(tab(transcript)).toHaveAttribute("aria-selected", "true");
  await user.click(tab("Sol"));
  await viewHere();
  expect(tab(transcript)).toHaveAttribute("aria-selected", "true");
  view.rerender(<Panel conversation={{ channelId: "channel" }} />);
  expect(screen.queryByRole("tab", { name: transcript })).toBeNull();
  expect(tab("Sol")).toHaveAttribute("aria-selected", "true");
  view.rerender(
    <Panel conversation={{ channelId: "channel", rootId: root }} />,
  );
  expect(screen.queryByRole("tab", { name: transcript })).toBeNull();
  await viewHere();
  expect(tab(transcript)).toHaveAttribute("aria-selected", "true");
});

it("opens a channel's thread transcript when opened from one of its threads' activity", async () => {
  // A channel-scoped agent keeps one thread per channel, so the opened
  // thread's own lookup finds it only after the profile is shown.
  const f = fixture({
    saved: {
      [JSON.stringify(["channel", "channel"])]: {
        threadId: "kept",
        workspace: "/w",
        at: 2,
      },
    },
    turns: () => ({
      result: {
        data: [
          {
            id: "turn-1",
            status: "completed",
            error: null,
            startedAt: 1,
            completedAt: 2,
            items: [{ type: "agentMessage", id: "a", text: "Two files." }],
          },
        ],
        nextCursor: null,
      },
    }),
  });
  const done = vi.fn();
  render(
    <f.tabs.ActivityTab
      {...f.props()}
      conversation={{ channelId: "channel", rootId: "e".repeat(64) }}
      initialTranscript={{ opening: 1, done }}
    />,
  );
  expect(await screen.findByText("Two files.")).toBeVisible();
  expect(done).toHaveBeenCalledTimes(1);
});

describe("opened from activity", () => {
  const root = "e".repeat(64);
  const transcript = "general · thread eeeeeeee";
  const opened = () => {
    const f = fixture({
      saved: {
        [JSON.stringify(["channel", root])]: {
          threadId: "kept",
          workspace: "/w",
          at: 2,
        },
      },
    });
    const close = vi.fn();
    const done = vi.fn();
    // Each call is a new opening, as each Working now click is.
    let openings = 0;
    const panel = (done?: () => void) => (
      <PanelWorkspace
        value="profile"
        select={() => undefined}
        tabMenu={{
          key: "channel",
          closeAll: () => false,
          closeOthers: () => false,
        }}
        items={[
          {
            id: "profile",
            label: "Sol",
            close: () => undefined,
            content: (
              <f.tabs.ActivityTab
                {...f.props()}
                conversation={{ channelId: "channel", rootId: root }}
                {...(done && {
                  initialTranscript: { opening: ++openings, done },
                })}
                close={close}
              />
            ),
          },
        ]}
      />
    );
    return { close, done, panel };
  };

  it("shows the transcript, and closing it closes the panel", async () => {
    const { close, done, panel } = opened();
    render(panel(done));
    expect(
      await screen.findByRole("tab", { name: transcript }),
    ).toHaveAttribute("aria-selected", "true");
    expect(done).toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: `Close ${transcript} tab` }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the panel when the profile's other tabs are closed", async () => {
    const user = userEvent.setup();
    const { close, done, panel } = opened();
    render(panel(done));
    await screen.findByRole("tab", { name: transcript });
    await user.pointer({
      target: screen.getByRole("tab", { name: "Sol" }),
      keys: "[MouseRight]",
    });
    await user.click(
      await screen.findByRole("menuitem", { name: "Close other tabs" }),
    );
    expect(screen.queryByRole("tab", { name: transcript })).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it("shows the transcript again when the kept profile is opened again", async () => {
    const user = userEvent.setup();
    const { done, panel } = opened();
    const view = render(panel(done));
    await screen.findByRole("tab", { name: transcript });
    await user.pointer({
      target: screen.getByRole("tab", { name: "Sol" }),
      keys: "[MouseRight]",
    });
    await user.click(
      await screen.findByRole("menuitem", { name: "Close other tabs" }),
    );
    // The panel offered its request, so it no longer asks.
    view.rerender(panel());
    expect(screen.queryByRole("tab", { name: transcript })).toBeNull();
    // Working now opens the same profile again: a new request.
    const again = vi.fn();
    view.rerender(panel(again));
    expect(
      await screen.findByRole("tab", { name: transcript }),
    ).toHaveAttribute("aria-selected", "true");
    expect(again).toHaveBeenCalledOnce();
  });
});

it("finds the thread's Codex session another build started", async () => {
  const root = "f".repeat(64);
  const tag = sessionTag("a".repeat(64), { channelId: "channel", root });
  const f = fixture({
    turns: (threadId) => ({
      result: {
        data:
          threadId === "elsewhere"
            ? [
                {
                  id: "turn-1",
                  status: "completed",
                  error: null,
                  startedAt: 1,
                  completedAt: 2,
                  items: [
                    {
                      type: "userMessage",
                      id: "u",
                      content: [
                        { type: "text", text: 'Request: "what changed?"' },
                      ],
                    },
                  ],
                },
              ]
            : [],
        nextCursor: null,
      },
    }),
    threads: [
      {
        id: "elsewhere",
        name: `Buzz #general · Sol · ${tag}`,
        updatedAt: 5,
      },
    ],
  });
  render(
    <f.tabs.ActivityTab
      {...f.props()}
      conversation={{ channelId: "channel", rootId: root }}
    />,
  );
  const opened = screen.getByRole("region", { name: "This thread" });
  fireEvent.click(
    await within(opened).findByRole("button", { name: /^View transcript/ }),
  );
  expect(await screen.findByText("what changed?")).toBeVisible();
});

it("shows the channel's current kind for a session another build started", async () => {
  const root = "f".repeat(64);
  const tag = sessionTag("a".repeat(64), { channelId: "channel", root });
  const channels: ChannelSummary[] = [
    { id: "channel", name: "general", channelType: "stream", private: true },
  ];
  const f = fixture({
    threads: [
      {
        id: "elsewhere",
        name: `Buzz general · Sol · ${tag}`,
        updatedAt: 5,
      },
    ],
    channels,
  });
  // A new element each time, so that rerendering renders the tab again.
  const shown = () => (
    <f.tabs.ActivityTab
      {...f.props()}
      conversation={{ channelId: "channel", rootId: root }}
    />
  );
  const view = render(shown());
  const here = screen.getByRole("region", { name: "This thread" });
  await within(here).findByRole("button", { name: /^View transcript/ });
  expect(within(here).getByTitle("general").querySelector("svg")).toHaveClass(
    "tabler-icon-lock",
  );

  // Made public, the lock found with the session does not stay.
  channels[0] = { id: "channel", name: "general", channelType: "stream" };
  view.rerender(shown());
  expect(within(here).getByTitle("general").querySelector("svg")).toHaveClass(
    "tabler-icon-hash",
  );
});

it("reports when looking for another build's Codex session fails", async () => {
  const f = fixture({ threads: "database is locked" });
  render(
    <f.tabs.ActivityTab
      {...f.props()}
      conversation={{ channelId: "channel" }}
    />,
  );
  expect(
    await within(
      screen.getByRole("region", { name: "This channel" }),
    ).findByRole("alert"),
  ).toHaveTextContent("Could not look for a Codex session: database is locked");
});

it("keeps provider readiness quiet and shows recovery when needed", async () => {
  const f = fixture();
  const onClose = vi.fn();
  render(<f.tabs.ProviderDialogBody onClose={onClose} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Default thinking")).toBeEnabled(),
  );
  expect(screen.queryByLabelText("Default model")).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByLabelText("Default thinking"));
  await user.click(await screen.findByRole("option", { name: "High" }));
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(f.provider.resolve(defaults)).toMatchObject({
    model: "",
    effort: "high",
  });
  expect(onClose).toHaveBeenCalledOnce();
  const storageFailure = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Storage full");
    });
  await user.click(screen.getByLabelText("Default thinking"));
  await user.click(
    await screen.findByRole("option", { name: "Low · Default" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Storage full");
  expect(onClose).toHaveBeenCalledOnce();
  storageFailure.mockRestore();
  cleanup();
  const signedOut = fixture({ signedIn: false });
  render(<signedOut.tabs.ProviderDialogBody onClose={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Codex needs you to sign in.",
  );
  expect(signedOut.provider.snapshot()).toMatchObject({
    readiness: "attention",
    attentionLabel: "Log in to Codex",
  });
  expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
  expect(screen.queryByText("Connection")).not.toBeInTheDocument();
});
it("keeps the provider dialog and its draft open while defaults could not be saved", async () => {
  let failing = true;
  const storage = fileStore(new Map(), async () => {
    if (failing) throw new Error("disk full");
  });
  const f = fixture({ storage });
  const onClose = vi.fn();
  render(<f.tabs.ProviderDialogBody onClose={onClose} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Default thinking")).toBeEnabled(),
  );
  const user = userEvent.setup();
  await user.click(screen.getByLabelText("Default thinking"));
  await user.click(await screen.findByRole("option", { name: "High" }));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  error.mockRestore();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Default thinking")).toHaveTextContent("High");
  // Nothing inherits defaults that were not saved.
  expect(f.provider.snapshot().defaults.effort).toBe("");
  failing = false;
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(f.provider.resolve(defaults).effort).toBe("high");
  expect(storage.get("buzz.codex.provider-defaults.v1")).toContain("high");
});

it("holds the default thinking while it saves, so the dialog closes on what was saved", async () => {
  let release = () => {};
  const storage = fileStore(
    new Map(),
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  const f = fixture({ storage });
  const onClose = vi.fn();
  render(<f.tabs.ProviderDialogBody onClose={onClose} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Default thinking")).toBeEnabled(),
  );
  const user = userEvent.setup();
  await user.click(screen.getByLabelText("Default thinking"));
  await user.click(await screen.findByRole("option", { name: "High" }));
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Default thinking")).toBeDisabled(),
  );
  release();
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(f.provider.resolve(defaults).effort).toBe("high");
});

it("applies provider precedence without rewriting records and falls back for incompatible thinking", async () => {
  const f = fixture();
  await f.provider.check();
  await f.provider.saveDefaults({ model: "model-a", effort: "high" });
  const inherited = { ...defaults };
  expect(f.provider.resolve(inherited)).toMatchObject({
    model: "model-a",
    effort: "high",
  });
  expect(inherited).toEqual(defaults);
  expect(f.provider.resolve({ ...defaults, model: "model-b" })).toMatchObject({
    model: "model-b",
    effort: "medium",
  });
  expect(
    f.provider.resolve({ ...defaults, model: "model-b", effort: "high" }),
  ).toMatchObject({ model: "model-b", effort: "high" });

  await f.provider.saveDefaults({ model: "model-b", effort: "medium" });
  render(<f.tabs.SettingsTab {...f.props()} />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "Model B · Default",
    ),
  );
  // Inheriting a saved provider preference is a default, not a recommendation.
  expect(screen.getByLabelText("Thinking")).toHaveTextContent(
    "Medium · Default",
  );
  expect(screen.queryByText(/Recommended/)).not.toBeInTheDocument();
  cleanup();

  localStorage.setItem("buzz.codex.provider-defaults.v1", "invalid");
  const invalid = new CodexProvider(f.spawn, localStore());
  expect(invalid.resolve(defaults)).toEqual(defaults);
});
it("selects a model in the Settings dropdown without changing local Codex preferences", async () => {
  const configured = { model: "model-b", model_reasoning_effort: "high" };
  const f = fixture({ configured });
  await f.provider.check();
  render(<f.tabs.DefaultControl onConfigure={vi.fn()} />);
  const user = userEvent.setup();
  const control = screen.getByRole("button", { name: /^Codex default model:/ });
  expect(control).toHaveTextContent("Model A");
  expect(control).toHaveTextContent("Automatic");
  await user.click(control);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Other" }));
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Model B" }),
  );
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Medium" }));
  expect(
    new CodexProvider(f.spawn, localStore()).resolve(defaults),
  ).toMatchObject({ model: "model-b", effort: "medium" });
  await waitFor(() => expect(control).toHaveTextContent("Medium"));
  fireEvent.click(control);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Use Codex recommended" }),
  );
  await waitFor(() => expect(f.provider.snapshot().defaults.model).toBe(""));

  expect(configured).toEqual({
    model: "model-b",
    model_reasoning_effort: "high",
  });
});
it("falls back for an unavailable provider default and restores it when the catalog recovers", async () => {
  localStorage.setItem(
    "buzz.codex.provider-defaults.v1",
    JSON.stringify({ version: 1, model: "model-a", effort: "high" }),
  );
  const f = fixture();
  expect(f.provider.resolve(defaults)).toMatchObject({
    model: "model-a",
    effort: "high",
  });
  const spawn = f.spawn.getMockImplementation();
  if (!spawn) throw new Error("Missing host fixture");
  f.spawn.mockImplementation((id, options) =>
    spawn(id, {
      ...options,
      onStdout: (data) => {
        if (id === "codex") return options?.onStdout?.(data);
        const wire = JSON.parse(data);
        if (Array.isArray(wire.result?.data))
          wire.result.data = wire.result.data.filter(
            (model: { model: string }) => model.model !== "model-a",
          );
        options?.onStdout?.(`${JSON.stringify(wire)}\n`);
      },
    }),
  );
  await f.provider.check();
  expect(f.provider.resolve(defaults)).toEqual(defaults);
  expect(f.provider.resolve({ ...defaults, model: "model-b" })).toMatchObject({
    model: "model-b",
    effort: "medium",
  });
  expect(
    JSON.parse(
      localStorage.getItem("buzz.codex.provider-defaults.v1") ?? "null",
    ),
  ).toMatchObject({ model: "model-a", effort: "high" });
  render(<f.tabs.ProviderDialogBody onClose={vi.fn()} />);
  expect(screen.queryByLabelText("Default model")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Default thinking")).toHaveTextContent(
    "High (unavailable)",
  );
  cleanup();
  f.spawn.mockImplementation(spawn);
  await f.provider.check();
  expect(f.provider.resolve(defaults)).toMatchObject({
    model: "model-a",
    effort: "high",
  });
});
it("shows a provider model recheck inside a focusable inactive picker", async () => {
  const f = fixture();
  await f.provider.check();
  render(<f.tabs.DefaultControl onConfigure={vi.fn()} />);
  const picker = screen.getByRole("button", { name: /^Codex default model:/ });
  expect(picker).toHaveTextContent("Model A");
  const spawn = f.spawn.getMockImplementation();
  if (!spawn) throw new Error("Missing host fixture");
  const listed = deferred<void>();
  f.spawn.mockImplementation((id, options) =>
    spawn(id, {
      ...options,
      onStdout: (data) => {
        if (id !== "codex" && data.includes('"model-a"'))
          void listed.promise.then(() => options?.onStdout?.(data));
        else options?.onStdout?.(data);
      },
    }),
  );
  const checked = f.provider.check();
  try {
    await waitFor(() => expect(picker).toHaveTextContent("Loading models…"));
    expect(picker).not.toHaveAttribute("disabled");
    expect(picker).toHaveAttribute("aria-disabled", "true");
    picker.focus();
    expect(picker).toHaveFocus();
    const user = userEvent.setup();
    await user.keyboard("{Enter}");
    await user.click(picker);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(picker).not.toHaveTextContent("Default");
  } finally {
    listed.resolve();
  }
  await act(() => checked);
  await waitFor(() => expect(picker).toBeEnabled());
  expect(picker).not.toHaveAttribute("aria-disabled", "true");
  expect(picker).toHaveTextContent("Model A");
});
it("keeps model-default provider thinking dynamic across save and reopen", async () => {
  const f = fixture();
  await f.provider.check();
  await f.provider.saveDefaults({ model: "", effort: "high" });
  const onClose = vi.fn();
  const view = render(<f.tabs.ProviderDialogBody onClose={onClose} />);
  const user = userEvent.setup();

  expect(screen.getByLabelText("Default thinking")).toHaveTextContent(/^High$/);
  await user.click(screen.getByLabelText("Default thinking"));
  await user.click(
    await screen.findByRole("option", { name: "Low · Default" }),
  );
  await user.click(screen.getByRole("button", { name: "Save defaults" }));

  expect(onClose).toHaveBeenCalledOnce();
  expect(
    JSON.parse(
      localStorage.getItem("buzz.codex.provider-defaults.v1") ?? "null",
    ),
  ).toMatchObject({ effort: "" });

  view.unmount();
  const reopened = fixture();
  render(<reopened.tabs.ProviderDialogBody onClose={vi.fn()} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Default thinking")).toBeEnabled(),
  );
  expect(screen.getByLabelText("Default thinking")).toHaveTextContent(
    "Low · Default",
  );
});
it("shows the recommended model and default thinking despite different local Codex preferences", async () => {
  const f = fixture({
    configured: { model: "model-b", model_reasoning_effort: "high" },
  });
  render(<f.tabs.SettingsTab {...f.props()} />);
  await waitFor(() => expect(screen.getByLabelText("Model")).toBeEnabled());
  expect(screen.getByLabelText("Model")).toHaveTextContent("Model A");
  expect(screen.getByLabelText("Thinking")).toHaveTextContent("Low");
});
it("loads model/effort choices and saves only after a validated workspace, holding the saving state", async () => {
  const f = fixture();
  const saving = deferred<void>();
  const save = vi.fn(() => saving.promise);
  render(<f.tabs.SettingsTab {...f.props(defaults, save)} />);
  await waitFor(() => expect(screen.getByLabelText("Model")).toBeEnabled());
  expect(screen.queryByText("Model A description.")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Model")).toHaveTextContent("Model A · Default");
  expect(screen.getByLabelText("Thinking")).toHaveTextContent("Low · Default");
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  expect(
    await screen.findByRole("option", {
      name: "Model A · Default",
      description: "Model A description.",
    }),
  ).toHaveAccessibleDescription("Model A description.");
  const model = await screen.findByRole("option", { name: "Model B" });
  expect(model).toHaveAccessibleDescription("Model B description.");
  await user.click(model);
  expect(screen.getByLabelText("Thinking")).toHaveTextContent("Medium");
  await user.click(screen.getByLabelText("Thinking"));
  expect(
    screen.queryByRole("option", { name: "High" }),
  ).not.toBeInTheDocument();
  await userEvent.setup().keyboard("{Escape}");
  fireEvent.change(screen.getByLabelText("Workspace"), {
    target: { value: "relative" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Workspace"), {
    target: { value: "/tmp/codex" },
  });
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Custom instructions" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  try {
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        ...defaults,
        model: "model-b",
        effort: "medium",
        workspace: "/tmp/codex",
        instructions: "Custom instructions",
      }),
    );
    expect(screen.getByRole("button", { name: "Saving…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByLabelText("Workspace")).toBeDisabled();
  } finally {
    saving.resolve();
  }
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
  );
  expect(f.processes[0]?.end).toHaveBeenCalled();
});
it("renders provider, model, and thinking as direct settings inputs", async () => {
  const f = fixture();
  const save = vi.fn(async () => {});
  const saved = { ...defaults, model: "model-b", effort: "medium" };
  render(
    <f.tabs.SettingsTab
      {...f.props(saved, save)}
      settingsHost={{
        typeControl: () => <p>Type control</p>,
      }}
    />,
  );
  const user = userEvent.setup();
  const typeControl = screen.getByText("Type control");
  const modelControl = await screen.findByRole("combobox", { name: "Model" });
  const thinkingControl = screen.getByLabelText("Thinking");
  expect(
    typeControl.compareDocumentPosition(modelControl) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    modelControl.compareDocumentPosition(thinkingControl) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(modelControl).toHaveTextContent(/^Model B$/);
  expect(thinkingControl).toHaveTextContent(/^Medium$/);
  await user.click(modelControl);
  await user.click(
    await screen.findByRole("option", {
      name: "Model A · Default",
      description: "Model A description.",
    }),
  );
  expect(screen.getByLabelText("Thinking")).toHaveTextContent("Low · Default");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith({ ...saved, model: "", effort: "" });
});

it("keeps settings editable while a provider change waits for Save", async () => {
  const f = fixture();
  const save = vi.fn(async () => {});
  render(
    <f.tabs.SettingsTab
      {...f.props(defaults, save)}
      settingsHost={{
        pendingSave: async () => {},
      }}
    />,
  );
  const user = userEvent.setup();
  expect(await screen.findByRole("button", { name: "Save" })).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "Model" })).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Workspace" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith(defaults);
});
/** Holds the next spawn until `release`, returning its process, which the
 * view has not seen yet. */
async function holdSpawn(f: ReturnType<typeof fixture>) {
  const late = deferred<Awaited<ReturnType<typeof f.spawn>>>();
  const started = deferred<void>();
  const original = f.spawn.getMockImplementation();
  if (!original) throw new Error("Missing spawn fixture");
  let process!: Awaited<ReturnType<typeof f.spawn>>;
  let held = false;
  f.spawn.mockImplementation(async (id, options) => {
    if (id === "codex" || held) return original(id, options);
    held = true;
    process = await original(id, options);
    started.resolve();
    return late.promise;
  });
  return {
    started: started.promise,
    release: () => late.resolve(process),
    process: () => process,
  };
}
it("preserves unavailable saved choices and closes a late provider check on dispose", async () => {
  const f = fixture();
  const saved = {
    ...defaults,
    model: "retired-model",
    effort: "high",
    workspace: "/tmp/codex",
  };
  const view = render(<f.tabs.SettingsTab {...f.props(saved)} />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "retired-model",
    ),
  );
  await waitFor(() => expect(f.processes[0]?.end).toHaveBeenCalled());
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "High (unavailable)",
  );
  view.unmount();
  const held = await holdSpawn(f);
  const pending = f.provider.check();
  await held.started;
  expect(f.provider.snapshot()).toMatchObject({
    readiness: "ready",
    checking: true,
  });
  f.provider.dispose();
  held.release();
  await waitFor(() => expect(held.process().end).toHaveBeenCalled());
  await pending;
});

it("starts a new agent from a model and instructions, keeping the rest", async () => {
  const f = fixture();
  const config = {
    ...defaults,
    model: "model-a",
    effort: "high",
    workspace: "/work",
    scope: "channel" as const,
  };
  const onChange = vi.fn();
  render(
    <>
      <f.tabs.Create config={config} onChange={onChange} disabled={false} />
      <f.tabs.CreateModel
        config={config}
        onChange={onChange}
        disabled={false}
      />
    </>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("combobox", { name: "Model" }));
  await user.click(
    await screen.findByRole("option", {
      name: "Model B",
    }),
  );
  // The new model's own effort replaces the old one.
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    model: "model-b",
    effort: "medium",
  });
  fireEvent.change(screen.getByLabelText("Instructions Optional"), {
    target: { value: "Triage." },
  });
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    instructions: "Triage.",
  });
  await user.click(await screen.findByRole("combobox", { name: "Model" }));
  await user.click(
    await screen.findByRole("option", {
      name: "Model A · Default",
      description: "Model A description.",
    }),
  );
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    model: "",
    effort: "",
  });
});

it("uses Codex's supported efforts at creation and reopens the saved choice", async () => {
  const f = fixture();
  const Thinking = f.tabs.CreateThinking;
  if (!Thinking) throw new Error("Missing Thinking control");
  const config = { ...defaults, model: "model-a", effort: "" };
  const onChange = vi.fn();
  const view = render(
    <Thinking config={config} onChange={onChange} disabled={false} />,
  );
  const control = await screen.findByRole("combobox", { name: "Thinking" });
  await waitFor(() => expect(control).toBeEnabled());
  expect(control).toHaveTextContent("Low · Default");

  const held = await holdSpawn(f);
  const refresh = f.provider.check();
  try {
    await held.started;
    expect(f.provider.snapshot()).toMatchObject({ checking: true });
    expect(control).toBeDisabled();
  } finally {
    held.release();
    await refresh;
  }
  await waitFor(() => expect(control).toBeEnabled());

  const user = userEvent.setup();
  await user.click(control);
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["Low · Default", "Low", "High"]);
  await user.click(screen.getByRole("option", { name: "High" }));
  expect(onChange).toHaveBeenLastCalledWith({ ...config, effort: "high" });
  view.unmount();

  render(<f.tabs.SettingsTab {...f.props({ ...config, effort: "high" })} />);
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "High",
  );
});

it("returns an unsupported Codex effort to Default after a successful catalog refresh", async () => {
  const modelAReasoningEfforts = ["low", "high"];
  const f = fixture({ modelAReasoningEfforts });
  await f.provider.check();
  const registeredType = {
    key: "buzz.codex/codex",
    pluginId: "buzz.codex",
    revision: "r1",
    title: "Codex",
    defaults: () => ({ config: { ...defaults } }),
    CreateModel: f.tabs.CreateModel,
    CreateThinking: f.tabs.CreateThinking,
  } as unknown as RegisteredAgentType;
  let saved: Agent<Config> | undefined;
  const create = vi.fn(async (input: NewAgent) => {
    saved = {
      ...f.props({ ...defaults, ...(input.config as Config) }).agent,
      name: input.name,
      type: input.type,
    };
    return saved;
  });
  const view = render(
    <AgentCreateDialog
      agents={{ create } as unknown as Agents}
      types={[registeredType]}
      onCreate={create}
      onCreated={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  const user = userEvent.setup();
  await user.type(within(dialog).getByLabelText("Name"), "Nova");

  const thinking = within(dialog).getByRole("combobox", { name: "Thinking" });
  await waitFor(() => expect(thinking).toBeEnabled());
  expect(thinking).toHaveTextContent("Low · Default");
  await user.click(thinking);
  await user.click(await screen.findByRole("option", { name: "High" }));
  expect(thinking).toHaveTextContent("High");

  modelAReasoningEfforts.splice(0, modelAReasoningEfforts.length, "low");
  const held = await holdSpawn(f);
  const refresh = f.provider.check();
  try {
    await held.started;
    expect(thinking).toBeDisabled();
    expect(thinking).toHaveTextContent("High");
  } finally {
    held.release();
    await refresh;
  }
  await waitFor(() => expect(thinking).toHaveTextContent("Low · Default"));
  await user.click(
    within(dialog).getByRole("button", { name: "Create agent" }),
  );

  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "buzz.codex/codex",
      config: expect.objectContaining({ model: "", effort: "" }),
    }),
  );
  expect(saved?.config).toMatchObject({ model: "", effort: "" });

  if (!saved) throw new Error("Agent was not saved");
  view.unmount();
  render(<f.tabs.SettingsTab {...f.props(saved.config as Config)} />);
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "Low · Default",
  );
});

it.each([
  {
    catalog: ["medium"],
    scenario: "the effort is unsupported",
    expectedEffort: "",
  },
  {
    catalog: ["medium", "high"],
    scenario: "the effort is still supported",
    expectedEffort: "medium",
  },
])(
  "resets create-time Codex effort to the new model default when $scenario",
  async ({ catalog, expectedEffort }) => {
    const f = fixture({ modelBReasoningEfforts: catalog });
    const Thinking = f.tabs.CreateThinking;
    if (!Thinking) throw new Error("Missing Thinking control");
    const changes: Config[] = [];
    function CreateSettings() {
      const [config, setConfig] = useState({ ...defaults, model: "model-a" });
      const onChange = (next: Config) => {
        changes.push(next);
        setConfig(next);
      };
      return (
        <>
          <f.tabs.CreateModel
            config={config}
            onChange={onChange}
            disabled={false}
          />
          <Thinking config={config} onChange={onChange} disabled={false} />
        </>
      );
    }
    render(<CreateSettings />);
    const thinking = await screen.findByRole("combobox", { name: "Thinking" });
    await waitFor(() => expect(thinking).toBeEnabled());

    const user = userEvent.setup();
    await user.click(thinking);
    await user.click(await screen.findByRole("option", { name: "High" }));
    await waitFor(() => expect(thinking).toHaveTextContent("High"));
    await user.click(await screen.findByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: "Model B" }));

    await waitFor(() =>
      expect(changes.at(-1)).toEqual({
        ...defaults,
        model: "model-b",
        effort: expectedEffort,
      }),
    );
    expect(thinking).toHaveTextContent(
      expectedEffort ? "Medium" : "Medium · Default",
    );
  },
);

it("keeps a new agent on the default when the catalog fails", async () => {
  const f = fixture();
  f.spawn.mockRejectedValueOnce(new Error("no codex"));
  const onChange = vi.fn();
  const Thinking = f.tabs.CreateThinking;
  if (!Thinking) throw new Error("Missing Thinking control");
  render(
    <>
      <f.tabs.CreateModel
        config={defaults}
        onChange={onChange}
        disabled={false}
      />
      <Thinking config={defaults} onChange={onChange} disabled={false} />
    </>,
  );
  await screen.findByRole("alert");
  expect(
    screen.queryByRole("option", { name: /Custom model/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
  expect(onChange).not.toHaveBeenCalled();
});

it("preserves an explicit Codex effort when the catalog fails", async () => {
  const f = fixture();
  f.spawn.mockRejectedValueOnce(new Error("no codex"));
  const config = { ...defaults, model: "model-a", effort: "high" };
  const onChange = vi.fn();
  const Thinking = f.tabs.CreateThinking;
  if (!Thinking) throw new Error("Missing Thinking control");
  render(
    <>
      <f.tabs.CreateModel
        config={config}
        onChange={onChange}
        disabled={false}
      />
      <Thinking config={config} onChange={onChange} disabled={false} />
    </>,
  );
  const thinking = await screen.findByRole("combobox", { name: "Thinking" });
  await screen.findByRole("alert");
  expect(thinking).toBeDisabled();
  expect(thinking).toHaveTextContent("High");
  expect(thinking).not.toHaveTextContent("High (unavailable)");
  expect(onChange).not.toHaveBeenCalled();
});

it("shows the default workspace and restores it when the field is cleared", async () => {
  const f = fixture();
  const save = vi.fn(async () => {});
  render(<f.tabs.SettingsTab {...f.props(defaults, save)} />);
  expect(screen.getByLabelText("Workspace")).toHaveValue("~/.buzz");
  await waitFor(() => expect(f.processes[0]?.end).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Test instructions" },
  });
  const expected = { ...defaults, instructions: "Test instructions" };
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expected));
  await waitFor(() => expect(screen.getByLabelText("Workspace")).toBeEnabled());
  save.mockClear();
  fireEvent.change(screen.getByLabelText("Workspace"), {
    target: { value: "   " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expected));
});

it("shares discovery across cards, strict effects, workspace changes and remounts", async () => {
  const f = fixture();
  const cards = (workspace: string) => (
    <StrictMode>
      {[1, 2, 3].map((id) => (
        <f.tabs.CreateModel
          key={id}
          config={{ ...defaults, workspace }}
          onChange={vi.fn()}
          disabled={false}
        />
      ))}
    </StrictMode>
  );
  const view = render(cards("/first"));
  await waitFor(() =>
    expect(screen.getAllByRole("combobox", { name: "Model" })).toHaveLength(3),
  );
  await waitFor(() => expect(f.processes[0]?.end).toHaveBeenCalled());
  expect(f.processes).toHaveLength(1);
  view.rerender(cards("/second"));
  view.unmount();
  render(cards("/third"));
  await screen.findAllByRole("combobox", { name: "Model" });
  expect(f.processes).toHaveLength(1);
});

it("keeps discovery alive for remaining cards and shares a retry after failure", async () => {
  const f = fixture();
  const held = await holdSpawn(f);
  const cards = (count: number) =>
    ["first", "second"]
      .slice(0, count)
      .map((key) => (
        <f.tabs.CreateModel
          key={key}
          config={defaults}
          disabled={false}
          onChange={vi.fn()}
        />
      ));
  const view = render(cards(2));
  await held.started;
  view.rerender(cards(1));
  held.release();
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "Model A",
    ),
  );
  expect(f.processes).toHaveLength(1);
  view.unmount();
  const retry = fixture();
  retry.spawn.mockRejectedValueOnce(new Error("offline"));
  render(
    [1, 2].map((key) => (
      <retry.tabs.CreateModel
        key={key}
        config={defaults}
        disabled={false}
        onChange={vi.fn()}
      />
    )),
  );
  await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
  const button = screen.getAllByRole("button", { name: "Try again" })[0];
  if (!button) throw new Error("Missing retry");
  fireEvent.click(button);
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(retry.processes).toHaveLength(1);
});

it("replaces sign-in with available models after Codex login succeeds", async () => {
  const f = fixture({ signedIn: false });
  render(
    <>
      <f.tabs.CreateModel
        config={defaults}
        disabled={false}
        onChange={vi.fn()}
      />
      <f.tabs.CreateModel
        config={defaults}
        disabled={false}
        onChange={vi.fn()}
      />
    </>,
  );
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(2),
  );
  const buttons = screen.getAllByRole("button", { name: "Sign in" });
  if (!buttons[0]) throw new Error("Missing sign-in");
  fireEvent.click(buttons[0]);
  if (!buttons[1]) throw new Error("Missing second sign-in");
  fireEvent.click(buttons[1]);
  expect(
    f.spawn.mock.calls.filter(
      ([id, options]) => id === "codex" && options?.args?.join(" ") === "login",
    ),
  ).toHaveLength(1);
  expect(
    screen.queryByRole("combobox", { name: "Model" }),
  ).not.toBeInTheDocument();
  // One dialog: the other card waits rather than opening a competing one.
  const [dialog, ...others] = screen.getAllByRole("dialog", {
    name: "Sign in to Codex",
  });
  if (!dialog) throw new Error("Missing sign-in dialog");
  expect(others).toHaveLength(0);
  expect(buttons[1]).toHaveAttribute("aria-disabled", "true");
  expect(
    await within(dialog).findByRole("button", { name: "Cancel" }),
  ).toBeVisible();
  f.disk.signedIn = true;
  f.logins[0]?.resolve(0);
  await waitFor(() => {
    const models = screen.getAllByRole("combobox", { name: "Model" });
    expect(models).toHaveLength(2);
    for (const model of models) expect(model).toHaveTextContent("Model A");
  });
  expect(
    screen.queryByRole("button", { name: "Sign in" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  // The first check asked whether sign-in is needed; both cards then shared one discovery.
  expect(f.processes).toHaveLength(2);
});

it("keeps sign-in available after a failed Codex login without showing models", async () => {
  const f = fixture({ signedIn: false });
  render(
    <f.tabs.CreateModel
      config={defaults}
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Sign in to Codex",
  });
  await within(dialog).findByRole("button", { name: "Cancel" });
  f.logins[0]?.resolve(1);
  // The failure stays in the open dialog, under its setup details.
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Setup details" }),
  );
  expect(await within(dialog).findByRole("log")).toHaveTextContent(
    "Sign-in ended (1)",
  );
  expect(within(dialog).getByRole("button", { name: "Sign in" })).toBeEnabled();
  expect(
    screen.queryByRole("combobox", { name: "Model" }),
  ).not.toBeInTheDocument();
});

it("lists models without a sign-in when the model provider needs no OpenAI account", async () => {
  const f = fixture({ signedIn: false, requiresOpenaiAuth: false });
  render(
    <f.tabs.CreateModel
      config={defaults}
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  expect(
    await screen.findByRole("combobox", { name: "Model" }),
  ).toHaveTextContent("Model A");
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  expect(f.provider.snapshot().readiness).toBe("ready");
});

it("offers to install Codex from its card when Buzz has no copy", async () => {
  const f = fixture({ installed: false });
  render(
    <f.tabs.CreateModel
      config={defaults}
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Install Codex" }));
  const dialog = await screen.findByRole("dialog", { name: "Set up Codex" });
  expect(within(dialog).getByText(/about 130 MB/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  // A failed download leaves the offer in place, with what went wrong.
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Setup details" }),
  );
  expect(
    await within(dialog).findByRole("log", { name: "Setup output" }),
  ).toHaveTextContent("Codex downloads need the desktop app");
  expect(
    await within(dialog).findByRole("button", { name: "Install Codex" }),
  ).toBeEnabled();

  f.disk.installed = true;
  await act(() => f.provider.check());
  expect(
    await screen.findByRole("combobox", { name: "Model" }),
  ).toHaveTextContent("Model A");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("moves the card from Install Codex to Sign in once the install succeeds", async () => {
  const f = fixture({ installed: false, signedIn: false });
  // Stands in for the download, which setup.test.ts covers.
  const download = deferred<void>();
  vi.spyOn(
    f.setup as unknown as { install(): Promise<void> },
    "install",
  ).mockImplementation(async () => {
    await download.promise;
    f.disk.installed = true;
  });
  render(
    <f.tabs.CreateModel
      config={defaults}
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Install Codex" }));
  const dialog = await screen.findByRole("dialog", { name: "Set up Codex" });
  const install = within(dialog).getByRole("button", { name: "Install Codex" });
  install.focus();
  expect(
    await within(dialog).findByRole("button", { name: "Cancel" }),
  ).toBeVisible();
  // Holds the provider's check that follows the install.
  const held = deferred<void>();
  const check = f.setup.check.bind(f.setup);
  vi.spyOn(f.setup, "check").mockImplementationOnce(async () => {
    await held.promise;
    return check();
  });
  download.resolve();
  // The same dialog and button, so keyboard focus stays on it.
  await screen.findByRole("dialog", { name: "Sign in to Codex" });
  const signIn = await within(dialog).findByRole("button", { name: "Sign in" });
  expect(signIn).toBe(install);
  expect(signIn).toHaveFocus();
  // Until the check answers, Sign in starts nothing.
  expect(signIn).toHaveAttribute("aria-busy", "true");
  fireEvent.click(signIn);
  expect(f.logins).toHaveLength(0);
  held.resolve();
  await waitFor(() => expect(signIn).not.toHaveAttribute("aria-busy"));
  expect(signIn).toHaveFocus();
  fireEvent.click(signIn);
  await waitFor(() => expect(f.logins).toHaveLength(1));
  // Holds the provider's check after sign-in, so Codex reads as ready while
  // its models still load, as in the app.
  const loading = deferred<void>();
  vi.spyOn(f.setup, "check").mockImplementationOnce(async () => {
    await loading.promise;
    return check();
  });
  f.disk.signedIn = true;
  f.logins[0]?.resolve(0);
  const model = await screen.findByRole("combobox", { name: "Model" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  // A browser cannot focus the field while it is disabled.
  expect(model).toBeDisabled();
  expect(model).not.toHaveFocus();
  loading.resolve();
  await waitFor(() => expect(model).toHaveTextContent("Model A"));
  // The dialog left with setup; its focus moves to the model field once it
  // can take it.
  await waitFor(() => expect(model).toHaveFocus());
});

it("installs and signs in Buzz's copy of Codex from its provider settings", async () => {
  const f = fixture({ installed: false, signedIn: false });
  const provider = new CodexProvider(f.spawn, localStore(), f.setup);
  const { ProviderDialogBody } = createTabs(
    provider,
    f.runtime,
    f.spawn,
    f.setup,
  );
  render(<ProviderDialogBody onClose={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Codex is not installed.",
  );
  expect(provider.snapshot()).toMatchObject({
    readiness: "attention",
    attentionLabel: "Install Codex",
  });
  expect(screen.getByText(/about 130 MB/)).toBeVisible();
  // A failed download leaves the offer in place, with what went wrong.
  fireEvent.click(screen.getByRole("button", { name: "Install Codex" }));
  expect(
    await screen.findByRole("log", { name: "Setup output" }),
  ).toHaveTextContent("Codex downloads need the desktop app");
  expect(
    await screen.findByRole("button", { name: "Install Codex" }),
  ).toBeVisible();

  f.disk.installed = true;
  await provider.check();
  expect(provider.snapshot()).toMatchObject({
    readiness: "attention",
    attentionLabel: "Log in to Codex",
  });
  fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("Waiting for Codex sign-in…")).toBeVisible();
  expect(provider.snapshot().blocking).toBe(true);

  f.disk.signedIn = true;
  f.logins[0]?.resolve(0);
  expect(
    await screen.findByRole("combobox", { name: "Default thinking" }),
  ).toBeVisible();
  expect(provider.snapshot()).toMatchObject({ readiness: "ready" });
  expect(provider.snapshot()).not.toHaveProperty("blocking");
  provider.dispose();
});

it("separates identity fields from runtime settings without changing the stored config", () => {
  const f = fixture();
  const Settings = f.tabs.SettingsTab;
  const props = f.props();
  const view = render(<Settings {...props} settingsSection="identity" />);
  const instructions = screen.getByLabelText("Instructions");
  const model = screen.getByLabelText("Model");
  expect(
    model.compareDocumentPosition(instructions) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.queryByLabelText("Workspace")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Sessions")).not.toBeInTheDocument();
  expect(screen.queryByText("Runtime diagnostics")).not.toBeInTheDocument();
  view.rerender(<Settings {...props} settingsSection="runtime" />);
  expect(screen.getByLabelText("Workspace")).toBeInTheDocument();
  expect(screen.getByLabelText("Sessions")).toBeInTheDocument();
  expect(screen.queryByText("Runtime diagnostics")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Instructions")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
  expect(props.save).not.toHaveBeenCalled();
});

it("cancels a Codex login from its card and kills the process", async () => {
  const f = fixture({ signedIn: false });
  render(
    <f.tabs.CreateModel
      config={defaults}
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  const cancel = await screen.findByRole("button", { name: "Cancel" });
  const index = f.spawn.mock.calls.findIndex(
    ([id, options]) => id === "codex" && options?.args?.join(" ") === "login",
  );
  const process = await f.spawn.mock.results[index]?.value;
  fireEvent.click(cancel);
  await waitFor(() => expect(process.kill).toHaveBeenCalledOnce());
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeEnabled();
});

it("cancels a Codex login when its setup dialog closes", async () => {
  const f = fixture({ signedIn: false });
  render(
    <f.tabs.CreateModel
      config={defaults}
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Sign in to Codex",
  });
  const index = f.spawn.mock.calls.findIndex(
    ([id, options]) => id === "codex" && options?.args?.join(" ") === "login",
  );
  const process = await f.spawn.mock.results[index]?.value;
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(process.kill).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeEnabled();
});

it.each(["Identity", "Settings"])(
  "keeps editing after cancelling a tab switch and retries a failed save from %s",
  async (saveFrom) => {
    const f = fixture();
    const Settings = f.tabs.SettingsTab;
    const source = f.props().agent;
    const user = userEvent.setup();
    const savedAgent = { ...source, place: "here" as const };
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("Save failed"))
      .mockResolvedValue(undefined);
    const agents = {
      save,
      configHistory: () => undefined,
      addedTabs: () => [],
      registerTab: () => {},
      controlAttention: () => {},
      memberships: () => [],
      subscribe: () => () => {},
    } as unknown as Agents;
    const type = {
      tabs: [
        {
          id: "settings",
          title: "Settings",
          role: "settings",
          splitSettings: true,
          component: Settings,
        },
      ],
    } as unknown as RegisteredAgentType;
    render(
      <AgentTabs
        agents={agents}
        agent={savedAgent}
        type={type}
        settingsHost={{}}
        channels={[]}
        memories={undefined}
        settingsContent={<p>Agent details</p>}
      />,
    );
    if (saveFrom === "Settings")
      await user.click(screen.getByRole("tab", { name: "Settings" }));
    const label = saveFrom === "Identity" ? "Instructions" : "Workspace";
    const value =
      saveFrom === "Identity" ? "Keep this identity draft." : "/tmp/kept-draft";
    await user.clear(screen.getByLabelText(label));
    await user.type(screen.getByLabelText(label), value);
    await user.click(screen.getByRole("tab", { name: "Memory" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "unsaved changes will be lost",
    );
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText(label)).toHaveValue(value);
    expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenLastCalledWith(savedAgent.pubkey, {
      config: expect.objectContaining({
        [saveFrom === "Identity" ? "instructions" : "workspace"]: value,
      }),
    });
  },
);

it("keeps the recommended model inherited when only effort changes", async () => {
  const f = fixture();
  await f.provider.check();
  render(<f.tabs.DefaultControl onConfigure={vi.fn()} />);
  const control = screen.getByRole("button", { name: /^Codex default model:/ });
  expect(control).toHaveTextContent("Model A · Default");
  fireEvent.click(control);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Other" }));
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Model A" }),
  );
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "High" }));
  await waitFor(() =>
    expect(f.provider.snapshot().defaults).toMatchObject({
      model: "",
      effort: "high",
    }),
  );
});

it("keeps same-channel recent threads visibly distinguishable", () => {
  const saved = Object.fromEntries(
    ["e", "f"].map((char) => [
      JSON.stringify(["channel", char.repeat(64)]),
      { threadId: char, workspace: "/w", at: 1 },
    ]),
  );
  const f = fixture({ saved });
  render(<f.tabs.ActivityTab {...f.props()} />);
  const rows = screen.getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.textContent)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Thread eeeeeeee"),
      expect.stringContaining("Thread ffffffff"),
    ]),
  );
});

it.each(["Needs attention", "Session could not be saved"])(
  "keeps %s diagnostics visible and multiline",
  (status) => {
    const f = fixture();
    vi.spyOn(f.runtime, "sessions").mockReturnValue([
      { key: "unbound", status, detail: "First line\nSecond line" },
    ]);
    render(<f.tabs.ActivityTab {...f.props()} />);
    const diagnostic = screen.getByText("First line Second line");
    expect(diagnostic.closest("details")).toBeNull();
    expect(diagnostic.textContent).toBe("First line\nSecond line");
    expect(diagnostic).toHaveClass("whitespace-pre-wrap");
  },
);

it("collapses Working command details", () => {
  const f = fixture();
  vi.spyOn(f.runtime, "sessions").mockReturnValue([
    { key: "unbound", status: "Working", detail: "git status" },
  ]);
  render(<f.tabs.ActivityTab {...f.props()} />);
  expect(screen.getByText("git status").closest("details")).not.toHaveAttribute(
    "open",
  );
  expect(screen.getByText("Latest activity")).toBeVisible();
});

it("shows the recent empty state when only the current runtime session exists", () => {
  const key = JSON.stringify(["channel", "channel"]);
  const f = fixture({
    saved: { [key]: { threadId: "current", workspace: "/w", at: 1 } },
  });
  vi.spyOn(f.runtime, "sessions").mockReturnValue([
    { key, status: "Working", detail: "git status" },
  ]);
  render(
    <f.tabs.ActivityTab
      {...f.props()}
      conversation={{ channelId: "channel" }}
    />,
  );
  expect(
    screen.getByText("No other conversations saved in this app yet."),
  ).toBeVisible();
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});
