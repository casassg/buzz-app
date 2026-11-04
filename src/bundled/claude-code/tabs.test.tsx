import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentTabs } from "../agents/AgentTabs";
import type {
  Agents,
  NewAgent,
  RegisteredAgentType,
} from "../../features/agents/service";
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
import { StrictMode, useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent, AgentType } from "../../features/agents/service";
import {
  fileStore,
  localStore,
  type AgentStore,
} from "../../features/agents/state";
import type { HostProcessOptions } from "../../features/host/service";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import { ClaudeLogoIcon } from "../../shared/design-system/icons";
import { AgentCreateDialog } from "../agents/AgentCreateDialog";
import { manifestProcesses } from "./claude-testing";
import { apply, inject } from "./index";
import { type Config, DEFAULT_CONFIG } from "./runtime";
import { ClaudeSetup } from "./setup";
import { ClaudeDefaults } from "./defaults";

const desktop = vi.hoisted(() => ({ tauri: true }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => desktop.tauri }));
const dialogMotion = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (actual) => ({
  ...(await actual<typeof import("motion/react")>()),
  useReducedMotion: () => dialogMotion.reduced,
}));

beforeEach(() => {
  desktop.tauri = true;
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  // jsdom has no layout observers; the model picker sizes itself with one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.restoreAllMocks();
});

const agent = (config: Config = DEFAULT_CONFIG) =>
  ({
    key: "c".repeat(64),
    pubkey: "c".repeat(64),
    name: "Claude",
    type: "buzz.claude-code/claude-code",
    owner: "a".repeat(64),
    config,
  }) as Agent<Config>;

// jsdom leaves focus on a button that becomes natively disabled, where a
// browser drops it, so the focus tests also check for no `disabled`.

/** The models Claude lists in its answer to `initialize`. */
const CATALOG = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    description: "Opus 5.5 · Best for everyday, complex tasks",
  },
  {
    value: "opus",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus",
    description: "Opus 5.5 · Best for everyday, complex tasks",
  },
  {
    value: "claude-fable-5-1[1m]",
    resolvedModel: "claude-fable-5-1",
    displayName: "Fable",
    description: "Fable 5.1 · Most capable for your hardest tasks",
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet",
    description: "Sonnet 5.5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
  },
];

/** Applies the plugin to a stand-in context; setup steps run until killed. */
function applied({
  loggedIn = true,
  available = true,
  version = "2.1.292",
  latest = version,
  files = {},
  catalog = { listed: true },
  storage,
  channels,
}: {
  /** Agent storage; this page's localStorage without it. */
  storage?: AgentStore;
  /** The community's channels; no community connection without them. */
  channels?: readonly ChannelSummary[];
  loggedIn?: boolean;
  available?: boolean;
  version?: string;
  latest?: string;
  files?: Record<string, string>;
  /** Whether Claude lists its models when asked. */
  catalog?: { listed: boolean; ready?: Promise<void> };
} = {}) {
  let type: AgentType<Config> | undefined;
  const home = mkdtempSync(join(tmpdir(), "claude-tabs-"));
  homes.push(home);
  for (const [path, content] of Object.entries(files)) {
    const copy = join(home, ".claude/projects", path);
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, content);
    // Written an hour ago, so a later listing finds it unchanged.
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(copy, hourAgo, hourAgo);
  }
  const listed = manifestProcesses(home);
  const spawn = vi.fn(async (id: string, options: HostProcessOptions = {}) => {
    // Claude and its install steps run as steps of claude.sh: its script, $0
    // and step come first.
    const step = id === "claude-sh" ? options.args?.[2] : undefined;
    const name = step === "run" ? "claude" : (step ?? id);
    const args = (options.args ?? []).slice(step ? 3 : 0).join(" ");
    // The manifest's listing and search run for real on a copy of `files`.
    if (name === "list" || name === "starts") return listed(name, options);
    if (name === "workspace" || name === "read") {
      const file = files[args];
      queueMicrotask(() =>
        name === "workspace"
          ? options.onStdout?.("/Users/me/.buzz\n")
          : file === undefined
            ? options.onStderr?.(`base64: ${args}: No such file or directory`)
            : options.onStdout?.(btoa(file)),
      );
      return {
        write: async () => undefined,
        end: async () => undefined,
        kill: async () => undefined,
        exited: new Promise<number>((resolve) =>
          setTimeout(
            () => resolve(name === "read" && file === undefined ? 1 : 0),
            0,
          ),
        ),
      };
    }
    // Buzz's launcher answers 127 when it has no copy.
    const missing = name === "claude" && args === "--version" && !available;
    const streaming = args.includes("--input-format stream-json");
    let kill: () => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => {
      if (name === "install" || args === "auth login" || streaming)
        kill = () => resolve(null);
      else setTimeout(() => resolve(missing ? 127 : 0), 0);
    });
    queueMicrotask(() =>
      options.onStdout?.(
        missing
          ? ""
          : name === "install"
            ? "Setting up Claude Code...\n"
            : name === "platform"
              ? "Darwin arm64\n"
              : args === "--version"
                ? `${version} (Claude Code)\n`
                : args === "auth status --json"
                  ? JSON.stringify({ loggedIn, email: "me@example.com" })
                  : "",
      ),
    );
    return {
      write: async (text: string) => {
        if (!streaming) return;
        const message = JSON.parse(text) as {
          request_id?: string;
          request?: { subtype?: string };
        };
        if (message.request?.subtype !== "initialize") return;
        await catalog.ready;
        queueMicrotask(() =>
          options.onStdout?.(
            `${JSON.stringify({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: message.request_id,
                response: {
                  models: catalog.listed ? CATALOG : [],
                },
              },
            })}\n`,
          ),
        );
      },
      end: async () => undefined,
      kill: async () => kill(),
      exited,
    };
  });
  const ctx = {
    pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    host: {
      spawn,
      // Offer the installed release unless the test requests an update.
      request: vi.fn(async ({ url }: { url: string }) => ({
        status: 200,
        headers: {},
        body: url.endsWith("/latest")
          ? latest
          : JSON.stringify({
              platforms: { "darwin-arm64": { checksum: "a".repeat(64) } },
            }),
      })),
    },
    agents: {
      storage,
      register: (registered: AgentType<Config>) => {
        type = registered;
      },
      snapshot: () => ({ status: "ready", agents: [], running: [] }),
      relay: () =>
        channels &&
        ({
          snapshot: () => ({
            status: "ready",
            session: { channels: { list: () => ({ channels }) } },
          }),
        } as unknown as RelayData),
      subscribe: () => () => undefined,
    },
    effect: vi.fn(),
  };
  apply(ctx as never);
  return { type, spawn, home };
}
function installed(options?: Parameters<typeof applied>[0]) {
  const { type, spawn, home } = applied(options);
  if (!type) throw new Error("no type registered");
  return { type, spawn, home };
}
function tab(type: AgentType<Config>, index: number) {
  const component = type.tabs?.[index]?.component;
  if (!component) throw new Error("no tab");
  return component;
}
function providerSetup(type: AgentType<Config>) {
  if (!type.provider) throw new Error("no provider contribution");
  return type.provider.DialogBody;
}
async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

it("shows each saved conversation's channel with the sidebar's icon", () => {
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().key]: {
        public: { id: "s1", seen: 0, at: 4 },
        private: { id: "s2", seen: 0, at: 3 },
        dm: { id: "s3", seen: 0, at: 2 },
        solo: { id: "s4", seen: 0, at: 1 },
      },
    }),
  );
  const Activity = tab(
    installed({
      channels: [
        { id: "public", name: "general", channelType: "stream" },
        { id: "private", name: "plans", channelType: "stream", private: true },
        { id: "dm", name: "Pinky", channelType: "dm", hidden: true },
        { id: "solo", name: "Notes", channelType: "solo", private: true },
      ],
    }).type,
    1,
  );
  render(<Activity agent={agent()} save={vi.fn()} />);
  const shown = (row: HTMLElement) => {
    const name = within(row).getByTitle(/ · channel$/);
    const icon = name.querySelector("svg")?.getAttribute("class");
    return `${icon?.match(/tabler-icon-[\w-]+/)?.[0]} ${name.textContent}`;
  };
  expect(
    screen.getAllByRole("listitem").map((row) => shown(row as HTMLElement)),
  ).toEqual([
    "tabler-icon-hash general",
    "tabler-icon-lock plans",
    "tabler-icon-message-circle Pinky",
    "tabler-icon-message-circle Notes",
  ]);
  expect(
    screen.getByRole("button", { name: "View transcript: plans · channel" }),
  ).toBeVisible();
});

it("lists saved conversations and shows one's transcript, or that it is gone", async () => {
  const thread = `channel/${"e".repeat(64)}`;
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().key]: {
        channel: { id: "deleted", seen: 0, at: 1 },
        [thread]: { id: "kept", seen: 0, at: 2 },
      },
    }),
  );
  const transcript = [
    JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-10-09T10:00:00Z",
      message: {
        content:
          "<buzz-event>\nEvent ID: e\nContent: what changed?\nTags: []\n</buzz-event>",
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "u2",
      timestamp: "2026-10-09T10:00:05Z",
      message: { content: [{ type: "text", text: "Two files." }] },
    }),
  ].join("\n");
  const Activity = tab(
    installed({ files: { "./-Users-me--buzz/kept.jsonl": transcript } }).type,
    1,
  );
  const save = vi.fn();
  render(<Activity agent={agent()} save={save} />);
  const user = userEvent.setup();
  const rows = screen.getAllByRole("listitem");
  expect(
    within(rows[0] as HTMLElement).getByRole("button", {
      name: "View transcript: channel · thread eeeeeeee",
    }),
  ).toBeVisible();
  expect(
    within(rows[1] as HTMLElement).getByRole("button", {
      name: "View transcript: channel · channel",
    }),
  ).toBeVisible();
  const viewButton = (index: number) =>
    screen.getAllByRole("button", { name: /^View transcript/ })[
      index
    ] as HTMLElement;
  await user.click(viewButton(0));
  expect(await screen.findByText("what changed?")).toBeVisible();
  expect(screen.getByText("Two files.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Refresh transcript" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh transcript" }),
    ).not.toHaveAttribute("data-loading"),
  );
  expect(screen.getByText("Two files.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back to profile" }));
  await user.click(viewButton(1));
  expect(
    await screen.findByText(/no transcript for this conversation/),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("opens the conversation's transcript when opened from its activity, once", async () => {
  const root = "e".repeat(64);
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().key]: { [`channel/${root}`]: { id: "kept", seen: 0, at: 2 } },
    }),
  );
  const transcript = JSON.stringify({
    type: "assistant",
    uuid: "u1",
    timestamp: "2026-10-09T10:00:05Z",
    message: { content: [{ type: "text", text: "Two files." }] },
  });
  const Activity = tab(
    installed({ files: { "./-Users-me--buzz/kept.jsonl": transcript } }).type,
    1,
  );
  const conversation = { channelId: "channel", rootId: root };
  const { unmount } = render(
    <Activity
      agent={agent()}
      save={vi.fn()}
      conversation={conversation}
      initialTranscript={{ opening: 1, done: () => undefined }}
    />,
  );
  const user = userEvent.setup();
  expect(await screen.findByText("Two files.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back to profile" }));
  expect(
    screen.getByRole("button", {
      name: "View transcript: channel",
    }),
  ).toBeVisible();
  expect(screen.queryByText("Two files.")).toBeNull();
  unmount();
  // Opened from the profile itself, it lists conversations instead.
  render(
    <Activity agent={agent()} save={vi.fn()} conversation={conversation} />,
  );
  expect(
    screen.getByRole("button", {
      name: "View transcript: channel",
    }),
  ).toBeVisible();
  expect(screen.queryByText("Two files.")).toBeNull();
});

it("opens a channel's session transcript when opened from one of its threads' activity", async () => {
  // A Solo chat, DM or channel-scoped agent keeps one session per channel, so
  // the thread's own lookup finds it only after the profile is shown.
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().key]: { channel: { id: "kept", seen: 0, at: 2 } },
    }),
  );
  const transcript = JSON.stringify({
    type: "assistant",
    uuid: "u1",
    timestamp: "2026-10-09T10:00:05Z",
    message: { content: [{ type: "text", text: "Two files." }] },
  });
  const Activity = tab(
    installed({ files: { "./-Users-me--buzz/kept.jsonl": transcript } }).type,
    1,
  );
  const done = vi.fn();
  render(
    <Activity
      agent={agent()}
      save={vi.fn()}
      conversation={{ channelId: "channel", rootId: "e".repeat(64) }}
      initialTranscript={{ opening: 1, done }}
    />,
  );
  expect(await screen.findByText("Two files.")).toBeVisible();
  expect(done).toHaveBeenCalledTimes(1);
});

it("shows the transcript and that sessions may be missing when some history cannot be read", async () => {
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().key]: {
        [`channel/${"e".repeat(64)}`]: { id: "kept", seen: 0, at: 2 },
      },
    }),
  );
  const transcript = [
    JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-10-09T10:00:00Z",
      message: {
        content:
          "<buzz-event>\nEvent ID: e\nContent: what changed?\nTags: []\n</buzz-event>",
      },
    }),
  ].join("\n");
  const { type, home } = installed({
    files: {
      "./-Users-me--buzz/kept.jsonl": transcript,
      "./-Users-me--buzz/unreadable.jsonl": transcript,
    },
  });
  chmodSync(join(home, ".claude/projects/-Users-me--buzz/unreadable.jsonl"), 0);
  const Activity = tab(type, 1);
  render(<Activity agent={agent()} save={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(
    screen.getAllByRole("button", {
      name: /^View transcript/,
    })[0] as HTMLElement,
  );
  expect(await screen.findByText("what changed?")).toBeVisible();
  expect(
    screen.getByText(/sessions may be missing\. Refresh to try again\./),
  ).toHaveTextContent(/unreadable\.jsonl/);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("sets the conversation the profile was opened from apart from recent conversations", () => {
  const root = "e".repeat(64);
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().key]: {
        channel: { id: "channel-session", seen: 0, at: 1 },
        [`channel/${root}`]: { id: "thread-session", seen: 0, at: 2 },
      },
    }),
  );
  const Activity = tab(installed().type, 1);
  render(
    <Activity
      agent={agent()}
      save={vi.fn()}
      conversation={{ channelId: "channel", rootId: root }}
    />,
  );
  const opened = screen.getByRole("region", { name: "This thread" });
  expect(
    within(opened).getByRole("button", { name: /^View transcript/ }),
  ).toBeVisible();
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "View transcript: channel · channel" }),
  ).toBeVisible();
  // Unlisted by the community, their kind is unknown: no icon claims one.
  expect(within(opened).getByTitle("channel").querySelector("svg")).toBeNull();
  expect(
    screen.getByTitle("channel · channel").querySelector("svg"),
  ).toBeNull();
});

it("finds the thread's Claude session another build started", async () => {
  const root = "f".repeat(64);
  const started = JSON.stringify({
    type: "user",
    uuid: "u1",
    timestamp: "2026-10-09T10:00:00Z",
    message: {
      content: `<context>\nScope: thread\nSession scope: thread\nChannel: dev (#channel)\nThread root: ${root}\nAgent: ${agent().key}\n</context>\n\n<buzz-event>\nEvent ID: e\nContent: what changed?\nTags: []\n</buzz-event>`,
    },
  });
  const { type, spawn } = installed({
    files: { "./-Users-me--buzz/elsewhere.jsonl": started },
  });
  const Activity = tab(type, 1);
  const open = async () => {
    const view = render(
      <Activity
        agent={agent()}
        save={vi.fn()}
        conversation={{ channelId: "channel", rootId: root }}
      />,
    );
    const opened = screen.getByRole("region", { name: "This thread" });
    fireEvent.click(
      await within(opened).findByRole("button", { name: /^View transcript/ }),
    );
    expect(await screen.findByText("what changed?")).toBeVisible();
    view.unmount();
  };
  const searches = () =>
    spawn.mock.calls.filter(([id]) => id === "starts").length;
  await open();
  const searched = searches();
  // Opened again, it searches no file it already searched.
  await open();
  expect(searched).toBeGreaterThan(0);
  expect(searches()).toBe(searched);
});

it("shows the channel's current kind for a session another build started", async () => {
  const root = "f".repeat(64);
  const started = JSON.stringify({
    type: "user",
    uuid: "u1",
    timestamp: "2026-10-09T10:00:00Z",
    message: {
      content: `<context>\nScope: thread\nSession scope: thread\nChannel: dev (#channel)\nThread root: ${root}\nAgent: ${agent().key}\n</context>\n\n<buzz-event>\nEvent ID: e\nContent: what changed?\nTags: []\n</buzz-event>`,
    },
  });
  const channels: ChannelSummary[] = [
    { id: "channel", name: "dev", channelType: "stream" },
  ];
  const { type, spawn } = installed({
    files: { "./-Users-me--buzz/elsewhere.jsonl": started },
    channels,
  });
  const Activity = tab(type, 1);
  // A new element each time, so that rerendering renders the tab again.
  const shown = () => (
    <Activity
      agent={agent()}
      save={vi.fn()}
      conversation={{ channelId: "channel", rootId: root }}
    />
  );
  const view = render(shown());
  const here = screen.getByRole("region", { name: "This thread" });
  await within(here).findByRole("button", { name: /^View transcript/ });
  expect(within(here).getByTitle("dev").querySelector("svg")).toHaveClass(
    "tabler-icon-hash",
  );
  const searched = spawn.mock.calls.filter(([id]) => id === "starts").length;

  channels[0] = {
    id: "channel",
    name: "plans",
    channelType: "stream",
    private: true,
  };
  view.rerender(shown());
  expect(within(here).getByTitle("plans").querySelector("svg")).toHaveClass(
    "tabler-icon-lock",
  );
  expect(spawn.mock.calls.filter(([id]) => id === "starts").length).toBe(
    searched,
  );
});

it("is an agent type on the desktop app", () => {
  expect(inject).toEqual(["agents", "host"]);
  const { type } = installed();
  expect(type).toMatchObject({
    id: "claude-code",
    title: "Claude",
    icon: ClaudeLogoIcon,
  });
  expect(type.defaults()).toEqual({ config: DEFAULT_CONFIG });
  expect(
    type.adopt?.(
      { instructions: "Triage.", workspace: "~/code" },
      DEFAULT_CONFIG,
    ),
  ).toEqual({
    ...DEFAULT_CONFIG,
    instructions: "Triage.",
    workspace: "~/code",
  });
  expect(type.adopt?.({}, DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  expect(type.carry?.(DEFAULT_CONFIG)).toEqual({});
  expect(
    type.carry?.({
      model: "opus",
      effort: "high",
      instructions: "Triage.",
      workspace: "~/code",
      scope: "channel",
    }),
  ).toEqual({ instructions: "Triage.", workspace: "~/code" });
  expect(type.describeMigration?.(DEFAULT_CONFIG)).toEqual([
    { id: "model", label: "Model", isOverride: false },
    { id: "thinking", label: "Thinking", isOverride: false },
    {
      id: "sessions",
      label: "Sessions",
      isOverride: false,
      unchangedKey: "thread",
    },
  ]);
  expect(
    type.describeMigration?.({
      ...DEFAULT_CONFIG,
      model: "opus",
      effort: "high",
      scope: "channel",
    }),
  ).toEqual([
    { id: "model", label: "Model", isOverride: true },
    { id: "thinking", label: "Thinking", isOverride: true },
    {
      id: "sessions",
      label: "Sessions",
      isOverride: true,
      unchangedKey: "channel",
    },
  ]);
  expect(type.summary?.(agent({ ...DEFAULT_CONFIG, model: "opus" }))).toBe(
    "opus",
  );
  expect(type.provider).toBeDefined();
  expect(type.tabs?.map(({ title, role }) => [title, role])).toEqual([
    ["Settings", "settings"],
    ["Activity", "activity"],
  ]);
});

it("registers only where setup's bash and base64 exist", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  expect(applied().type).toBeDefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  expect(applied().type).toBeUndefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  desktop.tauri = false;
  expect(applied().type).toBeUndefined();
});

it("keeps provider readiness quiet and agent sessions out of Settings", async () => {
  const installedType = installed().type;
  const Setup = providerSetup(installedType);
  render(<Setup onClose={vi.fn()} />);
  expect(await screen.findByText("Claude is signed in.")).toBeVisible();
  expect(screen.queryByLabelText("Default model")).not.toBeInTheDocument();
  expect(screen.queryByText("Connection")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  cleanup();
  const Settings = tab(installedType, 0);
  render(<Settings agent={agent()} save={vi.fn()} />);
  expect(screen.getByLabelText("Workspace")).toBeInTheDocument();
  expect(screen.queryByText("Recent conversations")).not.toBeInTheDocument();
  cleanup();
  const Activity = tab(installedType, 1);
  render(<Activity agent={agent()} save={vi.fn()} />);
  expect(
    screen.getByText("No other conversations saved in this app yet."),
  ).toBeInTheDocument();
});

it("edits the model through the Settings dropdown and preserves agent inheritance", async () => {
  const installedType = installed().type;
  const Control = installedType.provider?.DefaultControl;
  if (!Control) throw new Error("Missing default control");
  render(<Control onConfigure={vi.fn()} />);
  const user = userEvent.setup();
  const control = await screen.findByRole("button", {
    name: /^Claude default model:/,
  });
  await waitFor(() => expect(control).toHaveTextContent("Opus 5.5"));
  await user.click(control);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Claude" }));
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Fable 5.1" }),
  );
  cleanup();
  const Settings = tab(installedType, 0);
  const save = vi.fn(async () => undefined);
  render(<Settings agent={agent()} save={save} />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "Fable 5.1",
    ),
  );
  expect(save).not.toHaveBeenCalled();
});

it("keeps the saved default and shows the error while a default could not be saved", async () => {
  let failing = true;
  const storage = fileStore(new Map(), async () => {
    if (failing) throw new Error("disk full");
  });
  const Control = installed({ storage }).type.provider?.DefaultControl;
  if (!Control) throw new Error("Missing default control");
  render(<Control onConfigure={vi.fn()} />);
  const control = await screen.findByRole("button", {
    name: /^Claude default model:/,
  });
  await waitFor(() => expect(control).toHaveTextContent("Opus 5.5"));
  const pick = async () => {
    fireEvent.click(control);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Claude" }));
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Fable 5.1" }),
    );
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await pick();
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  error.mockRestore();
  expect(control).toHaveTextContent("Opus 5.5");
  expect(storage.get("buzz.claude-code.provider-defaults.v1")).toBeNull();
  // The same choice can be saved again.
  failing = false;
  await pick();
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(control).toHaveTextContent("Fable 5.1");
  expect(storage.get("buzz.claude-code.provider-defaults.v1")).toContain(
    "fable",
  );
});

it("preserves native behavior for invalid defaults and keeps explicit agent models", async () => {
  localStorage.setItem("buzz.claude-code.provider-defaults.v1", "not json");
  const defaults = new ClaudeDefaults(localStore());
  expect(defaults.resolve(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  await defaults.save({ model: "sonnet" });
  const inherited = { ...DEFAULT_CONFIG };
  expect(defaults.resolve(inherited).model).toBe("sonnet");
  expect(inherited).toEqual(DEFAULT_CONFIG);
  expect(defaults.resolve({ ...DEFAULT_CONFIG, model: "opus" }).model).toBe(
    "opus",
  );
});

it("can cancel sign-in and try again", async () => {
  const installedType = installed({ loggedIn: false }).type;
  const Setup = providerSetup(installedType);
  render(<Setup onClose={vi.fn()} />);
  const user = userEvent.setup();
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Claude 2.1.292 needs you to sign in.",
    ),
  );
  expect(screen.queryByText("Connection")).not.toBeInTheDocument();
  expect(installedType.provider?.snapshot()).toMatchObject({
    readiness: "attention",
    attentionLabel: "Log in to Claude Code",
  });
  const signIn = await screen.findByRole("button", { name: "Sign in" });
  await user.click(signIn);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for Claude Code sign-in…",
    ),
  );
  expect(screen.getByLabelText("Sign-in code")).toHaveAccessibleDescription(
    "If the browser shows a code to paste, enter it here.",
  );
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(installedType.provider?.snapshot()).toHaveProperty("blocking", true);
  await user.click(cancel);
  const retry = await screen.findByRole("button", { name: "Sign in" });
  expect(installedType.provider?.snapshot()).not.toHaveProperty("blocking");
  expect(retry).toHaveFocus();
  await user.click(retry);
  expect(await screen.findByRole("button", { name: "Cancel" })).toBeVisible();
});

it("replaces generic installation copy with the latest installer state", async () => {
  const installedType = installed({ available: false }).type;
  const Setup = providerSetup(installedType);
  render(<Setup onClose={vi.fn()} />);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Claude is not installed.",
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Install Claude" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Setting up Claude Code...",
    ),
  );
  expect(screen.queryByText("Installing Claude Code…")).toBeNull();
  expect(screen.queryByLabelText("Setup output")).toBeNull();
});

it("starts viable provider recovery directly from its attention action", async () => {
  const { type, spawn } = installed({ loggedIn: false });
  const Setup = providerSetup(type);
  render(<Setup onClose={vi.fn()} />);
  await waitFor(() =>
    expect(type.provider?.snapshot()).toMatchObject({
      readiness: "attention",
      attentionLabel: "Log in to Claude Code",
    }),
  );
  // Offered once the update check on load has finished.
  await waitFor(() =>
    expect(type.provider?.attentionAction).toBeTypeOf("function"),
  );
  const action = type.provider?.attentionAction;
  act(() => action?.());
  await waitFor(() =>
    expect(spawn).toHaveBeenCalledWith(
      "claude-sh",
      expect.objectContaining({
        args: [expect.any(String), "claude.sh", "run", "auth", "login"],
      }),
    ),
  );
  expect(type.provider?.attentionAction).toBeUndefined();
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for Claude Code sign-in…",
    ),
  );
  expect(type.provider?.snapshot()).toHaveProperty("blocking", true);
});

it("saves settings as one config", async () => {
  const Settings = tab(installed().type, 0);
  const save = vi.fn(async () => undefined);
  render(<Settings agent={agent()} save={save} />);
  const user = userEvent.setup();
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  const sonnet = await screen.findByRole("option", { name: "Sonnet 5.5" });
  expect(sonnet).toHaveAccessibleDescription("Efficient for routine tasks");
  await user.click(sonnet);
  expect(screen.getByLabelText("Workspace")).toHaveAccessibleDescription(
    "The folder Claude works in. Use ~/ for your home folder.",
  );
  await user.clear(screen.getByLabelText("Workspace"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith({
    ...DEFAULT_CONFIG,
    model: "sonnet",
    workspace: "~/.buzz",
  });
});

it("offers the model's thinking levels, dropping one the next model lacks", async () => {
  const Settings = tab(installed().type, 0);
  const save = vi.fn(async () => undefined);
  render(<Settings agent={agent()} save={save} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(await screen.findByRole("option", { name: "Sonnet 5.5" }));
  await user.click(screen.getByRole("combobox", { name: "Thinking" }));
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["Automatic · Default", "Low", "Medium", "High", "Extra high"]);
  await user.click(screen.getByRole("option", { name: "Extra high" }));
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(await screen.findByRole("option", { name: "Haiku 4.5" }));
  const thinking = screen.getByRole("combobox", { name: "Thinking" });
  expect(thinking).toHaveTextContent("Automatic · Default");
  await user.click(thinking);
  await user.click(await screen.findByRole("option", { name: "High" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith({
    ...DEFAULT_CONFIG,
    model: "haiku",
    effort: "high",
  });
});

it("keeps a saved thinking level changeable without Claude's model list", async () => {
  const Settings = tab(installed({ catalog: { listed: false } }).type, 0);
  const save = vi.fn(async () => undefined);
  render(
    <Settings
      agent={agent({ ...DEFAULT_CONFIG, effort: "high" })}
      save={save}
    />,
  );
  const user = userEvent.setup();
  const thinking = screen.getByRole("combobox", { name: "Thinking" });
  expect(thinking).toHaveTextContent("High");
  expect(thinking).not.toHaveTextContent("unavailable");
  await user.click(thinking);
  await user.click(
    await screen.findByRole("option", { name: "Automatic · Default" }),
  );
  expect(thinking).toHaveTextContent("Automatic · Default");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith(DEFAULT_CONFIG);
});

it("disables create-time Thinking when Claude model discovery fails", async () => {
  const { type, spawn } = installed();
  const Model = type.CreateModel;
  const Thinking = type.CreateThinking;
  if (!Model || !Thinking) throw new Error("Missing create controls");
  const original = spawn.getMockImplementation();
  if (!original) throw new Error("Missing process fixture");
  spawn.mockImplementation(async (id, options = {}) => {
    if (options.args?.includes("--input-format"))
      throw new Error("model catalog unavailable");
    return original(id, options);
  });
  const config = { ...DEFAULT_CONFIG, model: "sonnet", effort: "high" };
  const onChange = vi.fn();
  render(
    <>
      <Model config={config} onChange={onChange} disabled={false} />
      <Thinking config={config} onChange={onChange} disabled={false} />
    </>,
  );
  const thinking = await screen.findByRole("combobox", { name: "Thinking" });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "model catalog unavailable",
  );
  expect(thinking).toBeDisabled();
  expect(thinking).toHaveTextContent("High");
  expect(thinking).not.toHaveTextContent("High (unavailable)");
  expect(onChange).not.toHaveBeenCalled();
});

it("keeps Save focused while saving, and lets a failed save be retried", async () => {
  const Settings = tab(installed().type, 0);
  let fail: (error: Error) => void = () => undefined;
  const save = vi
    .fn<(config: Config) => Promise<void>>()
    .mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = reject)),
    )
    .mockResolvedValueOnce(undefined);
  render(<Settings agent={agent()} save={save} />);
  const user = userEvent.setup();
  await choose("Model", "Haiku 4.5");
  const saveButton = screen.getByRole("button", { name: "Save" });
  await user.click(saveButton);
  expect(saveButton).toHaveAttribute("aria-busy", "true");
  expect(saveButton).toHaveFocus();
  expect(saveButton).not.toHaveAttribute("disabled");
  fail(new Error("Relay rejected the change"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Relay rejected the change",
  );
  expect(screen.getByRole("alert")).toHaveFocus();
  await user.click(saveButton);
  expect(save).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("starts a new agent with finite model choices and preserves its other settings", async () => {
  const { type } = installed();
  const Create = type.Create;
  const Model = type.CreateModel;
  if (!Create || !Model) throw new Error("Missing creation controls");
  const config = {
    ...DEFAULT_CONFIG,
    workspace: "~/code",
    scope: "channel" as const,
    instructions: "Triage.",
  };
  const onChange = vi.fn();
  render(
    <>
      <Create config={config} onChange={onChange} disabled={false} />
      <Model config={config} onChange={onChange} disabled={false} />
    </>,
  );
  const picker = await screen.findByRole("combobox", { name: "Model" });
  await waitFor(() => expect(picker).toBeEnabled());
  const user = userEvent.setup();
  await user.click(picker);
  expect(
    screen.queryByRole("option", { name: "Custom model" }),
  ).not.toBeInTheDocument();
  await user.click(
    await screen.findByRole("option", {
      name: "Opus 5.5 · Default",
      description: "Best for everyday, complex tasks",
    }),
  );
  expect(onChange).toHaveBeenLastCalledWith({ ...config, model: "" });
  expect(screen.getByLabelText("Instructions Optional")).toHaveValue("Triage.");
  fireEvent.change(screen.getByLabelText("Instructions Optional"), {
    target: { value: "Plan." },
  });
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    instructions: "Plan.",
  });
});

it("uses Claude's effort catalog at creation and reopens the saved choice", async () => {
  let releaseCatalog!: () => void;
  const catalogReady = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  const loads = vi.spyOn(ClaudeSetup.prototype, "loadModels");
  const { type } = installed({
    catalog: { listed: true, ready: catalogReady },
  });
  const Thinking = type.CreateThinking;
  const Model = type.CreateModel;
  const Settings = tab(type, 0);
  if (!Thinking || !Model) throw new Error("Missing create controls");
  const config = { ...DEFAULT_CONFIG, model: "sonnet" };
  const onChange = vi.fn();
  const view = render(
    <>
      <Model config={config} onChange={onChange} disabled={false} />
      <Thinking config={config} onChange={onChange} disabled={false} />
    </>,
  );
  const control = await screen.findByRole("combobox", { name: "Thinking" });
  try {
    await waitFor(() => expect(loads).toHaveBeenCalled());
    const model = await screen.findByRole("combobox", { name: "Model" });
    await waitFor(() => expect(model).toBeDisabled());
    expect(control).toBeDisabled();
  } finally {
    releaseCatalog();
  }
  await waitFor(() => expect(control).toBeEnabled());
  expect(control).toHaveTextContent("Automatic · Default");

  const user = userEvent.setup();
  await user.click(control);
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["Automatic · Default", "Low", "Medium", "High", "Extra high"]);
  await user.click(screen.getByRole("option", { name: "Extra high" }));
  expect(onChange).toHaveBeenLastCalledWith({ ...config, effort: "xhigh" });
  view.unmount();

  render(
    <Settings
      agent={agent({ ...config, effort: "xhigh" })}
      save={vi.fn(async () => undefined)}
    />,
  );
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "Extra high",
  );
});

it("passes the real Claude Thinking choice through Create agent", async () => {
  const { type } = installed();
  if (!type) throw new Error("no type registered");
  const registeredType = {
    ...type,
    key: "buzz.claude-code/claude-code",
    pluginId: "buzz.claude-code",
    revision: "r1",
  } as unknown as RegisteredAgentType;
  let saved: Agent<Config> | undefined;
  const create = vi.fn(async (input: NewAgent) => {
    saved = {
      ...agent({ ...DEFAULT_CONFIG, ...(input.config as Config) }),
      name: input.name,
      type: input.type,
    };
    return saved;
  });
  const agents = { create } as unknown as Agents;
  const view = render(
    <AgentCreateDialog
      agents={agents}
      types={[registeredType]}
      onCreated={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  const user = userEvent.setup();
  await user.type(within(dialog).getByLabelText("Name"), "Nova");

  const model = within(dialog).getByRole("combobox", { name: "Model" });
  await waitFor(() => expect(model).toBeEnabled());
  await user.click(model);
  await user.click(await screen.findByRole("option", { name: "Sonnet 5.5" }));

  const thinking = within(dialog).getByRole("combobox", { name: "Thinking" });
  await waitFor(() => expect(thinking).toBeEnabled());
  await user.click(thinking);
  await user.click(await screen.findByRole("option", { name: "High" }));
  await user.click(
    within(dialog).getByRole("button", { name: "Create agent" }),
  );

  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "buzz.claude-code/claude-code",
      config: expect.objectContaining({ model: "sonnet", effort: "high" }),
    }),
  );
  expect(saved?.config).toMatchObject({ model: "sonnet", effort: "high" });

  view.unmount();
  const Settings = tab(type, 0);
  if (!saved) throw new Error("agent was not saved");
  render(<Settings agent={saved} save={vi.fn(async () => undefined)} />);
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "High",
  );
});

it("returns Claude create-time effort to Default when the inherited model changes", async () => {
  const { type } = installed();
  function Controls() {
    const DefaultControl = type.provider?.DefaultControl;
    const Thinking = type.CreateThinking;
    if (!DefaultControl || !Thinking)
      throw new Error("Missing provider or create-time Thinking control");
    const [config, setConfig] = useState({ ...DEFAULT_CONFIG });
    return (
      <>
        <DefaultControl onConfigure={vi.fn()} />
        <Thinking config={config} onChange={setConfig} disabled={false} />
        <output data-testid="create-config">{JSON.stringify(config)}</output>
      </>
    );
  }
  render(<Controls />);
  const user = userEvent.setup();
  const providerModel = await screen.findByRole("button", {
    name: /^Claude default model:/,
  });
  await waitFor(() => {
    expect(providerModel).toHaveTextContent("Opus 5.5");
    expect(providerModel).toBeEnabled();
  });
  fireEvent.click(providerModel);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Claude" }));
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Sonnet 5.5" }),
  );
  const sonnetEfforts = await screen.findByRole("menu", {
    name: "Sonnet 5.5 thinking effort",
  });
  fireEvent.click(
    within(sonnetEfforts).getByRole("menuitemradio", { name: "High" }),
  );
  await waitFor(() => expect(providerModel).toHaveTextContent("Sonnet 5.5"));

  const thinking = screen.getByRole("combobox", { name: "Thinking" });
  await waitFor(() => expect(thinking).toBeEnabled());
  await user.click(thinking);
  await user.click(await screen.findByRole("option", { name: "Extra high" }));
  expect(thinking).toHaveTextContent("Extra high");

  await waitFor(() => expect(providerModel).toBeEnabled());
  fireEvent.click(providerModel);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Claude" }));
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Haiku 4.5" }),
  );
  const haikuEfforts = await screen.findByRole("menu", {
    name: "Haiku 4.5 thinking effort",
  });
  fireEvent.click(
    within(haikuEfforts).getByRole("menuitemradio", { name: "High" }),
  );
  await waitFor(() => expect(providerModel).toHaveTextContent("Haiku 4.5"));
  await waitFor(() =>
    expect(thinking).toHaveTextContent("Automatic · Default"),
  );
  expect(screen.getByTestId("create-config")).toHaveTextContent(
    '"model":"","effort":""',
  );
});

it("clears a create-time Claude effort the newly selected model does not support", async () => {
  const Model = installed().type.CreateModel;
  if (!Model) throw new Error("Missing model control");
  const config = { ...DEFAULT_CONFIG, model: "sonnet", effort: "xhigh" };
  const onChange = vi.fn();
  render(<Model config={config} onChange={onChange} disabled={false} />);
  const control = await screen.findByRole("combobox", { name: "Model" });
  await waitFor(() => expect(control).toBeEnabled());

  const user = userEvent.setup();
  await user.click(control);
  await user.click(await screen.findByRole("option", { name: "Haiku 4.5" }));
  expect(onChange).toHaveBeenCalledWith({
    ...config,
    model: "haiku",
    effort: "",
  });
});

it("retains a create-time Claude effort supported by the selected model", async () => {
  const Model = installed().type.CreateModel;
  if (!Model) throw new Error("Missing model control");
  const config = { ...DEFAULT_CONFIG, model: "sonnet", effort: "high" };
  const onChange = vi.fn();
  render(<Model config={config} onChange={onChange} disabled={false} />);
  const control = await screen.findByRole("combobox", { name: "Model" });
  await waitFor(() => expect(control).toBeEnabled());

  const user = userEvent.setup();
  await user.click(control);
  await user.click(await screen.findByRole("option", { name: "Haiku 4.5" }));
  expect(onChange).toHaveBeenCalledWith({
    ...config,
    model: "haiku",
    effort: "high",
  });
});

it("disables a new agent's controls while it is being created", () => {
  const Create = installed().type.Create;
  if (!Create) throw new Error("no create choices");
  render(<Create config={DEFAULT_CONFIG} onChange={vi.fn()} disabled />);
  expect(screen.getByLabelText("Instructions Optional")).toBeDisabled();
});

it("edits a custom model and instructions in settings", async () => {
  const Settings = tab(installed().type, 0);
  const save = vi.fn(async () => undefined);
  render(
    <Settings
      agent={agent({ ...DEFAULT_CONFIG, model: "claude-opus-4-1" })}
      save={save}
      settingsHost={{ typeControl: () => <p>Provider control</p> }}
    />,
  );
  const user = userEvent.setup();
  const providerControl = screen.getByText("Provider control");
  const modelControl = screen.getByRole("combobox", { name: "Model" });
  expect(
    providerControl.compareDocumentPosition(modelControl) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(modelControl).toHaveTextContent("claude-opus-4-1");
  expect(
    screen.getByLabelText("Instructions"),
  ).not.toHaveAccessibleDescription();
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(await screen.findByRole("option", { name: "Custom model" }));
  const modelId = await screen.findByRole("textbox", { name: "Model ID" });
  expect(modelId).toHaveValue("claude-opus-4-1");
  await user.clear(modelId);
  await user.type(modelId, "claude-sonnet-custom");
  await user.click(screen.getByRole("button", { name: "Use model" }));
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Triage." },
  });
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith({
    ...DEFAULT_CONFIG,
    model: "claude-sonnet-custom",
    instructions: "Triage.",
  });
});

it("keeps settings editable while a provider change waits for Save", async () => {
  const Settings = tab(installed().type, 0);
  const save = vi.fn(async () => undefined);
  render(
    <Settings
      agent={agent()}
      save={save}
      settingsHost={{
        pendingSave: async () => {},
      }}
    />,
  );
  const user = userEvent.setup();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "Model" })).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Workspace" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith(DEFAULT_CONFIG);
});

it("shares one customization-free discovery across cards and workspace changes", async () => {
  const { type, spawn } = installed();
  const Model = type.CreateModel;
  if (!Model) throw new Error("Missing model field");
  const cards = (workspace: string) => (
    <StrictMode>
      {[1, 2, 3].map((id) => (
        <Model
          key={id}
          config={{ ...DEFAULT_CONFIG, workspace }}
          disabled={false}
          onChange={vi.fn()}
        />
      ))}
    </StrictMode>
  );
  const view = render(cards("/project-with-hooks"));
  await waitFor(() =>
    expect(screen.getAllByRole("combobox", { name: "Model" })).toHaveLength(3),
  );
  view.rerender(cards("/other-project"));
  view.unmount();
  render(cards("/third-project"));
  await screen.findAllByRole("combobox", { name: "Model" });
  const probes = spawn.mock.calls.filter(([, options]) =>
    options?.args?.includes("--input-format"),
  );
  expect(probes).toHaveLength(1);
  expect(probes[0]?.[1]).toMatchObject({
    cwd: "~",
    args: expect.arrayContaining([
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
    ]),
  });
  expect(probes[0]?.[1]?.args).not.toContain("bypassPermissions");
});

it("does not open a competing Claude sign-in or let it cancel the owner", async () => {
  const { type, spawn } = installed({ loggedIn: false });
  const Model = type.CreateModel;
  if (!Model) throw new Error("Missing model field");
  render(
    [1, 2].map((id) => (
      <Model
        key={id}
        config={DEFAULT_CONFIG}
        disabled={false}
        onChange={vi.fn()}
      />
    )),
  );
  await waitFor(() => {
    const buttons = screen.getAllByRole("button", { name: "Sign in" });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toBeEnabled();
  });
  const buttons = screen.getAllByRole("button", { name: "Sign in" });
  if (!buttons[0] || !buttons[1]) throw new Error("Missing sign-in");
  fireEvent.click(buttons[0]);
  fireEvent.click(buttons[1]);
  expect(
    spawn.mock.calls.filter(
      ([, options]) => options?.args?.slice(-2).join(" ") === "auth login",
    ),
  ).toHaveLength(1);
  expect(
    screen.getAllByRole("dialog", { name: "Sign in to Claude" }),
  ).toHaveLength(1);
  expect(buttons[1]).toBeDisabled();
});

it("offers an update before discovering models on a pre-safe-mode Claude copy", async () => {
  const { type, spawn } = installed({ version: "2.1.168" });
  const Model = type.CreateModel;
  if (!Model) throw new Error("Missing model field");
  render(<Model config={DEFAULT_CONFIG} disabled={false} onChange={vi.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Update Claude" })).toBeEnabled(),
  );
  expect(
    screen.queryByRole("button", { name: "Sign in" }),
  ).not.toBeInTheDocument();
  expect(
    spawn.mock.calls.filter(([, options]) =>
      options?.args?.includes("--safe-mode"),
    ),
  ).toHaveLength(0);
});

it("separates identity fields from runtime settings without changing the stored config", () => {
  const Settings = tab(installed().type, 0);
  const props = { agent: agent(), save: vi.fn(async () => undefined) };
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

it.each([
  { available: true, action: "Sign in", title: "Sign in to Claude" },
  { available: false, action: "Install Claude", title: "Set up Claude" },
])(
  "keeps failed Claude $action output in its open dialog",
  async ({ available, action, title }) => {
    const { type, spawn } = installed({ loggedIn: false, available });
    const Model = type.CreateModel;
    if (!Model) throw new Error("Missing model field");
    render(
      <Model config={DEFAULT_CONFIG} disabled={false} onChange={vi.fn()} />,
    );
    const signIn = await screen.findByRole("button", { name: action });
    await waitFor(() => expect(signIn).toBeEnabled());
    const original = spawn.getMockImplementation();
    if (!original) throw new Error("Missing spawn implementation");
    spawn.mockImplementation(async (id, options = {}) => {
      if (
        options.args?.includes("install") ||
        options.args?.slice(-2).join(" ") === "auth login"
      )
        throw new Error("Setup could not start");
      return original(id, options);
    });
    fireEvent.click(signIn);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: action })).toBeEnabled(),
    );
    const dialog = await screen.findByRole("dialog", { name: title });
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Setup details" }),
    );
    expect(await within(dialog).findByRole("log")).toHaveTextContent(
      "Setup could not start",
    );
  },
);

it("keeps the shared Claude catalog across repeated provider checks", async () => {
  const { type, spawn } = installed();
  const Model = type.CreateModel;
  if (!Model || !type.provider) throw new Error("Missing provider");
  render(
    <>
      <Model config={DEFAULT_CONFIG} disabled={false} onChange={vi.fn()} />
      <Model config={DEFAULT_CONFIG} disabled={false} onChange={vi.fn()} />
    </>,
  );
  await screen.findAllByRole("combobox", { name: "Model" });
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await type.provider?.check();
    });
  expect(
    spawn.mock.calls.filter(([, options]) =>
      options?.args?.includes("--input-format"),
    ),
  ).toHaveLength(1);
  expect(screen.getAllByRole("combobox", { name: "Model" })).toHaveLength(2);
});

it.each(["Identity", "Settings"])(
  "keeps editing after cancelling a tab switch and retries a failed save from %s",
  async (saveFrom) => {
    const f = installed();
    const Settings = tab(f.type, 0);
    const source = agent();
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

it("saves model-specific default effort from the nested menu and inherits it", async () => {
  const installedType = installed().type;
  const Control = installedType.provider?.DefaultControl;
  if (!Control) throw new Error("Missing default control");
  render(<Control onConfigure={vi.fn()} />);
  const control = await screen.findByRole("button", {
    name: /^Claude default model:/,
  });
  await waitFor(() => expect(control).toHaveTextContent("Opus 5.5"));
  expect(control).toHaveTextContent("Automatic");
  fireEvent.click(control);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Claude" }));
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Sonnet 5.5" }),
  );
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "High" }));
  await waitFor(() =>
    expect(control).toHaveAccessibleName(
      "Claude default model: Sonnet 5.5, High",
    ),
  );

  const reopened = new ClaudeDefaults(localStore());
  expect(reopened.resolve(DEFAULT_CONFIG)).toMatchObject({
    model: "sonnet",
    effort: "high",
  });
  expect(reopened.resolve({ ...DEFAULT_CONFIG, effort: "low" }).effort).toBe(
    "low",
  );
  expect(reopened.resolve({ ...DEFAULT_CONFIG, model: "haiku" }).effort).toBe(
    "",
  );
  fireEvent.click(control);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Use Claude default" }),
  );
  expect(new ClaudeDefaults(localStore()).snapshot().model).toBe("");
});

it("retries failed model discovery from the defaults row", async () => {
  const catalog = { listed: false };
  const Control = installed({ catalog }).type.provider?.DefaultControl;
  if (!Control) throw new Error("Missing default control");
  render(<Control onConfigure={vi.fn()} />);
  await screen.findByRole("alert");
  catalog.listed = true;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Claude default model:/ }),
    ).toHaveTextContent("Opus 5.5"),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps the model inherited when changing the default model's effort", async () => {
  const Control = installed().type.provider?.DefaultControl;
  if (!Control) throw new Error("Missing default control");
  render(<Control onConfigure={vi.fn()} />);
  const control = await screen.findByRole("button", {
    name: /^Claude default model:/,
  });
  await waitFor(() => expect(control).toHaveTextContent("Opus 5.5 · Default"));
  fireEvent.click(control);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Claude" }));
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Opus 5.5" }),
  );
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "High" }));
  expect(new ClaudeDefaults(localStore()).snapshot()).toMatchObject({
    model: "",
    effort: "high",
  });
  expect(control).toHaveTextContent("· Default");
});

it("keeps keyboard focus through Claude defaults discovery retries", async () => {
  const startup = vi.spyOn(ClaudeSetup.prototype, "update");
  const calls = vi.spyOn(ClaudeSetup.prototype, "loadModels");
  const catalog: { listed: boolean; ready?: Promise<void> } = { listed: false };
  const Control = installed({ catalog }).type.provider?.DefaultControl;
  if (!Control) throw new Error("Missing default control");
  // Plugin activation checks/updates Claude before the recovery flow begins.
  // Its final readiness check otherwise races the keyboard retry.
  expect(startup).toHaveBeenCalledOnce();
  await startup.mock.results[0]?.value;
  render(<Control onConfigure={vi.fn()} />);
  await screen.findByRole("alert");
  const retry = screen.getByRole("button", { name: "Try again" });
  await act(async () => {
    await Promise.all(calls.mock.results.map((result) => result.value));
  });
  const user = userEvent.setup();
  for (const succeeds of [false, true]) {
    let release!: () => void;
    catalog.ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    catalog.listed = succeeds;
    await waitFor(() =>
      expect(retry).not.toHaveAttribute("aria-disabled", "true"),
    );
    retry.focus();
    const previousCalls = calls.mock.calls.length;
    try {
      await user.keyboard("{Enter}");
      await waitFor(() => {
        expect(calls.mock.calls.length).toBeGreaterThan(previousCalls);
        expect(retry).toHaveAttribute("aria-disabled", "true");
      });
      expect(retry).toHaveFocus();
      expect(retry).not.toHaveAttribute("disabled");
    } finally {
      await act(async () => release());
    }
    if (!succeeds) {
      await screen.findByRole("alert");
      expect(retry).toHaveFocus();
    }
  }
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(
    screen.getByRole("button", { name: /^Claude default model:/ }),
  ).toHaveFocus();
});

it("keeps same-channel recent threads visibly distinguishable", () => {
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().key]: Object.fromEntries(
        ["e", "f"].map((char) => [
          `channel/${char.repeat(64)}`,
          { id: char, seen: 0, at: 1 },
        ]),
      ),
    }),
  );
  const Activity = tab(installed().type, 1);
  render(<Activity agent={agent()} save={vi.fn()} />);
  const rows = screen.getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.textContent)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Thread eeeeeeee"),
      expect.stringContaining("Thread ffffffff"),
    ]),
  );
});

it("focuses the code only when its compact sign-in disclosure is expanded", async () => {
  const { type } = installed({ loggedIn: false });
  const Model = type.CreateModel;
  if (!Model) throw new Error("Missing model controls");
  const user = userEvent.setup();
  render(<Model config={DEFAULT_CONFIG} onChange={vi.fn()} disabled={false} />);
  await user.click(await screen.findByRole("button", { name: "Sign in" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Sign in to Claude",
  });
  await user.click(within(dialog).getByRole("button", { name: "Sign in" }));
  const expand = await screen.findByRole("button", { name: "Enter a code" });
  expect(screen.queryByLabelText("Sign-in code")).toBeNull();
  await user.click(expand);
  const code = await screen.findByLabelText("Sign-in code");
  await waitFor(() => expect(code).toHaveFocus());
  await user.type(code, "retained-code");
  await user.click(expand);
  expect(screen.queryByLabelText("Sign-in code")).toBeNull();
  await user.click(expand);
  await waitFor(() =>
    expect(screen.getByLabelText("Sign-in code")).toHaveFocus(),
  );
  expect(screen.getByLabelText("Sign-in code")).toHaveValue("retained-code");
});
