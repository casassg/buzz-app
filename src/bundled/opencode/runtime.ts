// Turns Agents deliveries into opencode turns. Every agent of this type shares
// one `opencode acp` process; a delivery becomes a prompt in the harness format,
// sent to the agent's ACP session for its conversation; a watch or timer wake
// runs as a one-off turn in a new session, in its Interest's lane. The run
// returns once the turn is handed over, so one agent works in several
// conversations at once.
// opencode acts in Buzz with the in-process Buzz tools over loopback HTTP MCP,
// signed by the agent's native-held key; the runtime only reports a turn that
// fails.
import type { Context } from "../../buzz-mcp/client";
import {
  MemoryReads,
  READ_TIMEOUT_MS,
} from "../../features/agent-harness/core-memory";
import { RESUMED_PROMPT } from "../../buzz-mcp/prompt";
import { respond } from "../../buzz-mcp/rpc";
import { appClient } from "../../buzz-mcp/app-client";
import {
  type AddedTool,
  addedKey,
  turnNote,
} from "../../buzz-mcp/session-tools";
import {
  fromOwner,
  type Agent,
  type AgentHandle,
  type Agents,
  type Delivery,
  type StandaloneTurn,
  type TurnResult,
} from "../../features/agents/service";
import { ownerReads } from "../../features/agents/reads";
import { soloChat } from "../../features/agents/solo-chat";
import { SessionControls } from "../../features/agent-harness/session-control";
import type {
  SessionPlace,
  SessionControlAction,
  SessionState,
} from "../../features/agents/service";
import { type AgentKey, pubkeyOf } from "../../features/agents/membership";
import { sessionPrompts } from "../../features/agents/session-prompts";
import { localStore, type AgentStore } from "../../features/agents/store";
import type { Host } from "../../features/host/service";
import type { EventData } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { threadReference } from "../../features/relay/thread-reference";
import {
  wakeAnchor,
  wakeLands,
} from "../../features/agent-harness/plugin-wake";
import {
  CONTEXT_LIMIT,
  type Scope,
  steerPrompt,
  systemPrompt,
  turnPrompt,
} from "../claude-code/prompt";
import { ownerCanvas, readProject } from "../../features/agent-harness/project";
import {
  OpenCodeProcess,
  type OpenCodeHost,
  type ServeMcp,
  type ToolServer,
} from "./opencode";
import { AgentSessions as AcpAgentSessions } from "../../features/agent-harness/acp/agent-sessions";
import type { AcpProcess } from "../../features/agent-harness/acp/process";
import { validWorkspace } from "../codex/config";
import { localSessions } from "../goose/sessions";

class AgentSessions extends AcpAgentSessions {
  constructor(
    options: Omit<ConstructorParameters<typeof AcpAgentSessions>[0], "label">,
  ) {
    super({ ...options, label: "opencode" });
  }
}

/** The one `opencode acp` every OpenCode agent's sessions open in, started in
 * the home folder when a session first needs it, and again after it exits. */
class SharedProcess {
  private ready: Promise<AcpProcess> | undefined;
  constructor(
    private readonly host: OpenCodeHost,
    private readonly serve: ServeMcp,
  ) {}
  get(): Promise<AcpProcess> {
    if (this.ready) return this.ready;
    const ready = (async () =>
      OpenCodeProcess.start(this.host.spawn, {
        cwd: await this.host.resolveDirectory("~"),
        serve: this.serve,
      }))();
    const forget = () => {
      if (this.ready === ready) this.ready = undefined;
    };
    void ready.then((process) => process.exited.then(forget), forget);
    this.ready = ready;
    return ready;
  }
  stop() {
    const ready = this.ready;
    this.ready = undefined;
    void ready?.then((process) => process.kill()).catch(() => undefined);
  }
}

export type Config = Readonly<{
  /** An opencode agent (its ACP `mode`), such as `build`; empty uses
   * opencode's `default_agent`. */
  mode: string;
  /** A model opencode offers; empty uses opencode's own. */
  model: string;
  /** A thinking level opencode offers for the model; empty uses opencode's. */
  effort: string;
  instructions: string;
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  /** Whether each thread is its own session, or the whole channel is one. */
  scope: Scope;
}>;
export const DEFAULT_CONFIG: Config = Object.freeze({
  mode: "",
  model: "",
  effort: "",
  instructions: "",
  workspace: "~/.buzz",
  scope: "thread",
});
export const config = (value: unknown): Config => {
  const merged: Config = {
    ...DEFAULT_CONFIG,
    ...(value && typeof value === "object" ? (value as Partial<Config>) : {}),
  };
  // New agent can't refuse a typed path, so a blank or relative one runs in
  // the default workspace rather than wherever opencode was started.
  const workspace =
    typeof merged.workspace === "string" ? merged.workspace.trim() : "";
  return validWorkspace(workspace)
    ? { ...merged, workspace }
    : { ...merged, workspace: DEFAULT_CONFIG.workspace };
};

const CONVERSATION_READ_TIMEOUT_MS = 4_000;
const CHAT = [9, 40002];
const TITLE_LIMIT = 80;

/** A watch's or timer's prompt, after a context naming the agent as a
 * conversation's first prompt does, so its session is listed as the agent's. */
export function standalonePrompt(agent: string, text: string) {
  return `<context>\nScope: standalone\nAgent: ${agent}\n</context>\n\n${text}`;
}

/** A session's title in opencode, as harness agents name theirs:
 * `Agent · #channel`, and the thread's root when each thread is a session. */
export function sessionTitle(
  agent: string | undefined,
  place: string,
  root?: string,
) {
  const suffix = root ? ` · ${root.slice(0, 8)}` : "";
  const title = `${agent?.trim() || "Buzz agent"} · ${place}`
    .replace(/\s+/g, " ")
    .slice(0, TITLE_LIMIT - suffix.length)
    .trim();
  return `${title}${suffix}`;
}

type Entry = {
  sessions: AgentSessions;
  config: Config;
  /** The team sections of the latest run; a change reopens idle sessions. */
  team: string;
  /** The agent's name, for its prompt; a rename reopens idle sessions. */
  name?: string;
  /** The agent's handle from its latest delivery, for the tools to act with. */
  handle?: AgentHandle;
  /** Where each conversation's tools default to: its latest turn's thread. */
  contexts: Map<string, Context>;
  policies: Map<
    string,
    {
      topLevel: boolean;
      handed: Promise<unknown>;
      settled: Promise<unknown>;
      cancel(): void;
    }
  >;
};

export class OpenCodeRuntime {
  private readonly agents = new Map<string, Entry>();
  /** The opencode every agent's sessions open in. */
  private readonly opencode = new SharedProcess(
    {
      spawn: (id, options) => this.desktop.spawn(id, options),
      resolveDirectory: (path) => this.desktop.resolveDirectory(path),
    },
    (handler) => this.serve(handler),
  );
  private readonly memoryReads = new MemoryReads();
  private readonly listeners = new Set<() => void>();
  private readonly views = new Map<
    AgentKey,
    ReturnType<AgentSessions["snapshot"]>
  >();

  constructor(
    private readonly host: Host,
    /** The owner's connection to each agent's own community. */
    private readonly relay: (key: AgentKey) => RelayData | undefined,
    /** The agent's `core` memory as the host keeps it (`Agents.core`). */
    private readonly core: Agents["core"],
    private readonly storage: Storage = globalThis.localStorage,
    /** The tools plugins add to every session now. */
    private readonly added: () => readonly AddedTool[] = () => [],
    /** Desktop-local repository instructions; standalone hosts keep their own layout. */
    private readonly repositories: (scope: string | undefined) => string = () =>
      "",
    /** Agent storage, where what each session started with is kept. */
    private readonly agentStore: AgentStore = localStore(),
  ) {}

  /** What each of the agent's sessions started with. */
  prompts(agent: AgentKey) {
    return sessionPrompts(this.agentStore, "opencode", agent);
  }

  /** The desktop host's methods opencode agents run with. */
  private get desktop() {
    const { host } = this;
    if (!host.spawn || !host.resolveDirectory || !host.readFile)
      throw new Error("opencode agents run only in the desktop app");
    return {
      spawn: host.spawn.bind(host),
      resolveDirectory: host.resolveDirectory.bind(host),
      readFile: host.readFile.bind(host),
    };
  }
  private get serve(): ServeMcp {
    const serve = this.host.serveMcp?.bind(this.host);
    if (!serve) throw new Error("opencode agents run only in the desktop app");
    return serve;
  }

  /** Brings the runtime in line with this type's agents: changed settings
   * reopen idle sessions, and removed agents stop. opencode stops with the
   * last. */
  sync(agents: readonly Agent[]) {
    const current = new Set(agents.map((agent) => agent.key));
    for (const [key, entry] of this.agents)
      if (!current.has(key)) {
        entry.sessions.dispose();
        this.agents.delete(key);
      }
    if (!this.agents.size) this.opencode.stop();
    for (const agent of agents) {
      const next = config(agent.config);
      const entry = this.agents.get(agent.key);
      if (!entry) this.entry(agent.key, next).name = agent.name;
      else if (
        JSON.stringify(entry.config) !== JSON.stringify(next) ||
        entry.name !== agent.name
      ) {
        entry.config = next;
        entry.name = agent.name;
        entry.sessions.reconfigure();
      }
    }
    this.notify();
  }

  /** Conversations each agent has a session for, for its status view. */
  sessions(agent: AgentKey) {
    let view = this.views.get(agent);
    if (!view) {
      view = this.agents.get(agent)?.sessions.snapshot() ?? [];
      this.views.set(agent, view);
    }
    return view;
  }
  /** The agent's saved conversations, most recently used first. Removing an
   * agent keeps them. */
  conversations(agent: AgentKey) {
    return localSessions(this.storage, agent, "buzz.opencode.sessions.v1")
      .list()
      .map(([key, { at }]) => ({ key, at }));
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    this.views.clear();
    for (const listener of this.listeners) listener();
  }
  private readonly controls = new SessionControls(() => this.notify());
  private controlKey(agent: Agent, place: SessionPlace) {
    return config(agent.config).scope === "channel" || !place.root
      ? place.channelId
      : `${place.channelId}/${place.root}`;
  }
  sessionState(agent: Agent, place: SessionPlace): SessionState {
    const key = this.controlKey(agent, place);
    if (this.controls.compacting(`${agent.key}/${key}`)) return "compacting";
    return this.controls.active(`${agent.key}/${key}`) ||
      this.agents.get(agent.key)?.policies.has(key) ||
      this.agents.get(agent.key)?.sessions.active(key)
      ? "active"
      : "idle";
  }
  async session(
    agent: Agent,
    place: SessionPlace,
    action: SessionControlAction,
  ) {
    const key = this.controlKey(agent, place);
    const control = `${agent.key}/${key}`;
    const entry = this.entry(agent.key, config(agent.config));
    if (action === "interrupt") {
      this.controls.interrupt(control);
      entry.policies.get(key)?.cancel();
      await entry.sessions.interrupt(key);
      return;
    }
    if (this.sessionState(agent, place) !== "idle")
      throw new Error("Wait for the active turn to finish first.");
    return this.controls.run(control, action, async (signal) => {
      signal.throwIfAborted();
      const result = await entry.sessions.reset(key, action);
      signal.throwIfAborted();
      if (!result.ok) throw new Error(result.error);
    });
  }

  dispose() {
    for (const entry of this.agents.values()) entry.sessions.dispose();
    this.agents.clear();
    this.opencode.stop();
  }

  async run({
    trigger,
    agent,
    config: raw,
    channelId,
    team,
    model,
    effort,
    synced,
    workingUntil,
    current,
    wakeText,
    ignored,
    signal,
    step,
    acknowledged,
    superseded,
    interruptible,
  }: Delivery) {
    const settings = config(raw);
    // Unaddressed watches and timers come as standalone turns (`runOnce`).
    if (
      trigger.type !== "mention" &&
      trigger.type !== "attention" &&
      trigger.type !== "plugin"
    )
      return ignored?.();
    // A wake is not a message to check: a plugin's is the owner's installed
    // code, and the agent's own handoff comes from a turn already acting
    // for the owner.
    const wake = trigger.type !== "mention" ? trigger : undefined;
    const resumed = trigger.type === "mention" && !!trigger.resumed;
    // opencode runs commands as you; mentions need owner or delegated authority.
    if (trigger.type === "mention") {
      const snapshot = this.relay(agent.key)?.snapshot();
      if (
        !(await fromOwner(trigger.event, agent.owner, {
          agent: agent.pubkey,
          authority:
            snapshot?.status === "ready"
              ? snapshot.session.workflowAuthority
              : undefined,
          profiles:
            snapshot?.status === "ready"
              ? snapshot.session.profiles
              : undefined,
        }))
      ) {
        ignored?.();
        return;
      }
      signal.throwIfAborted();
    }
    const entry = this.entry(agent.key, settings);
    entry.handle = agent;
    entry.team = team ?? "";
    const event =
      trigger.type !== "mention" ? wakeAnchor(trigger) : trigger.event;
    const channel =
      channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1] ?? undefined;
    if (!channel) return;
    // Frozen for the turn: its key, prompt, tools and posts all follow it.
    const solo = await soloChat(
      () => this.relay(agent.key),
      agent.owner,
      channel,
      signal,
    );
    const topLevel = solo || wake?.topLevel === true;
    if (wake && !wakeLands(wake, topLevel)) return ignored?.();
    // `fresh` is for a session that has been shown nothing yet.
    const prompt = async (fresh: boolean, admitted?: string) => {
      const turn = await this.turn(
        entry,
        agent,
        event,
        channel,
        topLevel,
        fresh,
        resumed,
        solo,
        admitted,
      );
      const { channel: where } = turn;
      const text = turnPrompt({
        ...turn,
        agent: agent.key,
        channelLevel: topLevel && !solo,
        ...(wake
          ? { wake: { ...wake, text: (await wakeText?.()) ?? wake.text } }
          : {}),
      });
      return {
        key: turn.key,
        shown: turn.shown,
        place: where.name
          ? `#${where.name}`
          : where.dm
            ? "DM"
            : where.id.slice(0, 8),
        text: resumed ? `${text}\n\n${RESUMED_PROMPT}` : text,
      };
    };
    const { key, text: prepared, place, shown } = await prompt(false);
    signal.throwIfAborted();
    const handoff = this.controls.deliver(
      `${agent.key}/${key}`,
      async (deferred) => {
        // Accepted deferred work belongs to the captured agent lifetime, not
        // the short deadline for handing a message to the harness.
        if (this.agents.get(agent.key) !== entry) return;
        if (!deferred) signal.throwIfAborted();
        let noteRoot: string | undefined;
        let notes: ReturnType<NonNullable<AgentHandle["notes"]>> = [];
        const prior = entry.policies.get(key);
        const same = prior?.topLevel === topLevel;
        const wait = prior && (same ? prior.handed : prior.settled);
        let delivered!: ReturnType<AgentSessions["deliver"]>;
        let interrupted = false;
        const handed = (async () => {
          await wait;
          if (interrupted || this.agents.get(agent.key) !== entry) {
            delivered = Promise.resolve({ ok: true, undelivered: true });
            return;
          }
          // Plugins' notes wait until the turn is handed over, so one that
          // fails or is cancelled before then leaves them for the next.
          noteRoot =
            key === channel
              ? undefined
              : (threadReference(event)?.rootId ?? event.id);
          notes = agent.notes?.(channel, noteRoot) ?? [];
          const text = this.review(
            entry,
            wait ? (await prompt(false, key)).text : prepared,
            notes,
          );
          if (interrupted || this.agents.get(agent.key) !== entry) {
            delivered = Promise.resolve({ ok: true, undelivered: true });
            return;
          }
          entry.contexts.set(
            key,
            topLevel
              ? { channel, ...(solo ? { topLevel } : {}) }
              : key === channel
                ? { channel }
                : { channel, root: threadReference(event)?.rootId ?? event.id },
          );
          delivered = entry.sessions.deliver(key, text, shown, {
            ...(wake
              ? {
                  current,
                  refresh: async (fresh = false) => {
                    const text = this.review(
                      entry,
                      (await prompt(fresh, key)).text,
                      notes,
                    );
                    return text;
                  },
                }
              : {}),
            steer: steerPrompt(text),
            fresh: async () =>
              this.review(entry, (await prompt(true, key)).text, notes),
            title: sessionTitle(entry.name, place, key.split("/")[1]),
            ...(!deferred && !wait ? { signal } : {}),
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            // A pick runs on its own level; a synced one is checked.
            ...(synced?.effort && !model && !effort
              ? { kept: synced.effort }
              : {}),
            activityScope: topLevel
              ? channel
              : (threadReference(event)?.rootId ?? event.id),
            ...(step ? { step } : {}),
            ...(acknowledged ? { acknowledged } : {}),
            ...(superseded ? { superseded } : {}),
          });
        })();
        const done = handed.then(() => delivered);
        const policy = {
          topLevel,
          handed,
          settled: Promise.all([same ? prior.settled : undefined, done]).then(
            () => entry.sessions.idle(key),
          ),
          cancel() {
            interrupted = true;
            prior?.cancel();
          },
        };
        entry.policies.set(key, policy);
        void policy.settled.then(() => {
          if (entry.policies.get(key) !== policy) return;
          entry.policies.delete(key);
          this.notify();
        });
        if (!wait) await handed;
        workingUntil(done);
        interruptible?.(() => {
          policy.cancel();
          return entry.sessions.interrupt(key);
        });
        this.notify();
        void done
          .then((result) => {
            if (result.undelivered)
              agent.restoreNotes?.(channel, notes, noteRoot);
            // Of the messages one turn answered, only one has its error. An
            // answer opencode wrote without `send` stays in local activity.
            if (result.error !== undefined)
              return this.report(agent, channel, event, result.error, topLevel);
          })
          .catch((error) => console.warn("opencode turn failed", error))
          .finally(() => this.notify());
      },
    );
    if (!handoff.deferred) return handoff.done;
    workingUntil(handoff.done);
    void handoff.done
      .catch((error) =>
        this.report(agent, channel, event, String(error), topLevel),
      )
      .catch((error) => console.warn("opencode handover failed", error));
  }

  /** Runs a standalone turn, such as a watch's or a timer's, in a one-off
   * session that joins no conversation. */
  async runOnce({
    delivery,
    key,
    signal,
    prompt,
  }: StandaloneTurn): Promise<TurnResult> {
    const { agent, team } = delivery;
    const entry = this.entry(agent.key, config(delivery.config));
    entry.handle = agent;
    entry.team = team ?? "";
    const done = entry.sessions.runOnce(
      key,
      async () => {
        const text = await prompt();
        return text === undefined
          ? undefined
          : standalonePrompt(agent.key, text);
      },
      {
        signal,
        title: sessionTitle(entry.name, key),
        current: delivery.current,
        ...(delivery.synced?.effort ? { kept: delivery.synced.effort } : {}),
      },
    );
    this.notify();
    return done.finally(() => this.notify());
  }

  /** `text` with the notes plugins left for the turn and the Buzz tools'
   * end-of-turn note, when there are any. */
  private review(entry: Entry, text: string, notes: readonly string[] = []) {
    return [text, ...notes, turnNote(entry.handle)]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Says in the thread that a turn failed, so nobody waits on it. */
  private report(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    error: string,
    topLevel: boolean,
  ) {
    return this.post(
      agent,
      channel,
      event,
      `⚠️ I couldn't finish that: ${error.slice(0, 500)}`,
      topLevel,
      [["p", agent.owner]],
    );
  }

  /** Replies as the agent in the event's thread, or at a Solo chat's top
   * level. */
  private post(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    content: string,
    topLevel: boolean,
    tags: string[][] = [],
  ) {
    return agent
      .publish({
        kind: 9,
        content,
        tags: [
          ["h", channel],
          ...(topLevel
            ? []
            : [["e", threadReference(event)?.rootId ?? event.id, "", "reply"]]),
          ...tags,
        ],
      })
      .catch((failure) => console.warn("opencode could not post", failure));
  }

  /** Where the event's turn goes, and what its prompt needs. */
  private async turn(
    entry: Entry,
    agent: Pick<Agent, "key" | "pubkey">,
    event: EventData,
    channelId: string,
    topLevel: boolean,
    fresh = false,
    /** Given again after a reload stopped it: it is shown what came after it,
     * its own replies included, as its new session cannot know them. */
    resumed = false,
    solo = topLevel,
    admitted?: string,
  ) {
    const snapshot = this.relay(agent.key)?.snapshot();
    const session = snapshot?.status === "ready" ? snapshot.session : undefined;
    const summary =
      session?.channels.list().channels.find((item) => item.id === channelId) ??
      session?.channels.get?.(channelId);
    const dm = summary?.channelType === "dm";
    const thread = threadReference(event);
    const rootId = thread?.rootId ?? event.id;
    // A Solo chat is one conversation, as a DM is.
    const key =
      admitted ??
      (topLevel || dm || entry.config.scope === "channel"
        ? channelId
        : `${channelId}/${rootId}`);

    // The conversation it was admitted to, not the scope as it is now.
    const scope: Scope = key === channelId ? "channel" : "thread";
    // A resumed turn's session never saw its thread, its own replies included,
    // even when another resumed turn already opened it in a channel session.
    const seen = fresh || resumed ? 0 : entry.sessions.seen(key);
    // Read alongside the conversation: only a Solo chat's Canvas is handed over.
    const owner = entry.handle?.owner;
    const reading = solo
      ? readProject(
          session && owner
            ? () =>
                ownerCanvas(
                  session.canvas,
                  owner,
                  channelId,
                  session.channelWrites.startingCanvas(channelId),
                )
            : undefined,
        )
      : Promise.resolve(undefined);
    const threadRead = (thread || (resumed && !dm)) && !topLevel;
    let earlier: readonly EventData[] = [];
    if (session && (thread || dm || topLevel || resumed))
      try {
        const events = await session.read(
          threadRead
            ? [
                { ids: [rootId], "#h": [channelId], limit: 1 },
                { kinds: CHAT, "#h": [channelId], "#e": [rootId], limit: 200 },
              ]
            : [{ kinds: CHAT, "#h": [channelId], limit: CONTEXT_LIMIT + 1 }],
          { signal: AbortSignal.timeout(CONVERSATION_READ_TIMEOUT_MS) },
        );
        earlier = events
          .filter(
            (item) =>
              CHAT.includes(item.kind) &&
              item.tags.some(
                ([key, value]) => key === "h" && value === channelId,
              ) &&
              item.id !== event.id &&
              (resumed || item.created_at <= event.created_at),
          )
          .sort((a, b) => a.created_at - b.created_at);
      } catch (error) {
        console.warn("opencode could not read the conversation", error);
      }
    // A session already has its own replies; a new one is shown them too.
    const unseen = earlier.filter(
      (item) =>
        item.created_at > seen && (!seen || item.pubkey !== agent.pubkey),
    );
    const project = (await reading)?.section;
    return {
      key,
      event,
      scope,
      topLevel,
      channel: {
        id: channelId,
        ...(summary?.name ? { name: summary.name } : {}),
        dm,
      },
      ...(thread ? { thread } : {}),
      context: unseen,
      /** created_at of the newest event the turn is shown. A thread read in a
       * channel session stops at the event: the other threads were not read. */
      shown:
        threadRead && key === channelId
          ? event.created_at
          : Math.max(
              event.created_at,
              ...unseen.map((item) => item.created_at),
            ),
      total: earlier.length + 1,
      ...(project ? { project } : {}),
    };
  }

  private entry(agent: AgentKey, initial: Config): Entry {
    const existing = this.agents.get(agent);
    if (existing) return existing;
    const entry: Entry = {
      config: initial,
      team: "",
      sessions: undefined as unknown as AgentSessions,
      contexts: new Map(),
      policies: new Map(),
    };
    // Every session of the agent shares them, so they read the settings, the
    // handle and the conversation's place as they are when called.
    const tools: ToolServer = async (conversation, message) => {
      const handle = entry.handle;
      const client =
        handle &&
        appClient(handle, {
          relayAuthor: this.relay(agent)?.snapshot().session.relayAuthor,
          signingAuthority:
            this.relay(agent)?.snapshot().session.workflowAuthority,
          read: async (path) =>
            this.desktop.readFile(path, { cwd: entry.config.workspace }),
          memories: (slug) => this.memories(agent, slug),
          remembered: () => this.forget(agent),
        });
      const context = (conversation && entry.contexts.get(conversation)) || {};
      return respond(client, context, message, this.added());
    };
    entry.sessions = new AgentSessions({
      resolveDirectory: (path) => this.desktop.resolveDirectory(path),
      tools,
      process: this.opencode,
      store: localSessions(this.storage, agent, "buzz.opencode.sessions.v1"),
      started: (session, text) =>
        void this.prompts(agent).save(session, [{ label: "", text }]),
      onChange: () => this.notify(),
      // Read as each turn starts, so a change needs no restart.
      choice: () => ({
        provider: "",
        model: entry.config.model.trim(),
        effort: entry.config.effort,
        mode: entry.config.mode,
      }),
      fingerprint: () =>
        JSON.stringify([
          entry.config.workspace,
          entry.config.instructions,
          entry.config.scope,
          entry.team,
          entry.name,
          addedKey(this.added()),
        ]),
      launch: async () => {
        const { workspace, instructions, scope } = entry.config;
        const memory = await this.core(agent);
        return {
          workspace,
          systemPrompt: systemPrompt({
            scope,
            cwd: workspace,
            repositories: this.repositories(
              this.relay(agent)?.snapshot().scope,
            ),
            ...(entry.name
              ? { agent: { name: entry.name, pubkey: pubkeyOf(agent) } }
              : {}),
            instructions,
            team: entry.team,
            ...(memory === undefined ? {} : { memory }),
          }),
        };
      },
    });
    this.agents.set(agent, entry);
    return entry;
  }

  /** The agent's memory, or only entry `slug`, as the owner's reads of its
   * community give it: it is encrypted to the owner, so no agent key is
   * needed. */
  private memories(agent: AgentKey, slug?: string) {
    const pubkey = pubkeyOf(agent);
    const reads = ownerReads(this.relay(agent), pubkey);
    if (!reads) return Promise.reject(new Error("Buzz is not connected"));
    return this.memoryReads.read(
      reads,
      pubkey,
      AbortSignal.timeout(READ_TIMEOUT_MS),
      slug,
    );
  }
  private forget(agent: AgentKey) {
    const pubkey = pubkeyOf(agent);
    const reads = ownerReads(this.relay(agent), pubkey);
    if (reads) this.memoryReads.forget(reads.connection, pubkey);
  }
}
