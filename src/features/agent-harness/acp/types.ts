// What the shared ACP client exchanges with the harness plugins built on it.
import type {
  HostMcpServer,
  HostProcess,
  HostProcessOptions,
  McpHandler,
} from "../../host/service";
import type { AcpProcess } from "./process";
import type { ConfigOptions } from "./session";

export type Spawn = (
  id: string,
  options?: HostProcessOptions,
) => Promise<HostProcess>;
export type ServeMcp = (handler: McpHandler) => Promise<HostMcpServer>;
/** The host's absolute path for a directory, resolving `~/…`. */
export type ResolveDirectory = (path: string) => Promise<string>;

/** How a burst of work ended: every message sent so far has been answered,
 * or the session or its process is gone. One message of the burst owns its
 * `error` and `text`, to post them once; the others get only `ok`. */
export type Settled = Readonly<{
  ok: boolean;
  error?: string;
  /** The JSON-RPC code of the harness's error answer behind `error`. */
  code?: number;
  /** What the harness wrote, when it answered nowhere in Buzz. Nobody saw it. */
  text?: string;
  /** The message gave up before any turn took it in. */
  undelivered?: true;
  /** The owner's interrupt ended the turn. */
  stopped?: true;
}>;

export type ActivityReceipt = Readonly<{
  current?: () => boolean;
  /** Rebuilds an Attention prompt after startup or queue waits. */
  refresh?: (fresh?: boolean) => Promise<string>;
  /** The prompt was handed to the harness, after cancellation and provider
   * checks. */
  delivered?: () => void;
  /** Steps show on the latest acknowledged message of each scope. */
  activityScope?: string;
  step?: (tool: string, target?: string) => void;
  acknowledged?: () => void;
  superseded?: () => void;
}>;

/** Answers one MCP message from a session serving `conversation` with its
 * JSON-RPC response. */
export type ToolServer = (
  conversation: string | undefined,
  message: Readonly<{ id: string | number; method: string; params?: unknown }>,
) => Promise<unknown>;

/** The provider, model and thinking level a session's turns run on; empty is
 * what the harness's own config picks. `mode` is the harness's own agent or
 * mode, for a harness that offers them; empty is its default. */
export type Choice = Readonly<{
  provider: string;
  model: string;
  effort?: string;
  mode?: string;
}>;

/** The HTTP MCP server a session declares in `session/new`. */
export type McpServer = Readonly<{
  type: "http";
  name: string;
  url: string;
  headers: HostMcpServer["headers"];
}>;

/** What a harness adds to, or does in place of, plain ACP. Each hook is
 * optional: without it the client uses plain ACP's way, or none. */
export type AcpHooks = Readonly<{
  /** Names the harness in errors. */
  label: string;
  /** The manifest process it runs as. */
  program: string;
  /** The error when that program cannot be found, or cannot run. */
  missing: string;
  /** Keeps stderr written before the host reports the spawn, and reads exit
   * 126 or 127 before `initialize` answers as `missing`: for a program the
   * owner launches through `env`. */
  diagnoseStartup?: boolean;
  /** Its environment, under the launch's own. The Buzz identity is always
   * removed, whatever either says. */
  env: Readonly<Record<string, string | null>>;
  /** Whether the harness names an untitled session itself, read once per
   * process. Without it, a session opened to be named keeps its title. */
  names?(process: AcpProcess): Promise<boolean>;
  /** `session/new`'s `_meta`. */
  newSessionMeta?(
    buzz: McpServer | undefined,
    open: Readonly<{ title?: string; provider: string }>,
  ): Record<string, unknown>;
  /** Appends `text` to a new session's system prompt; a throw closes it.
   * Without it, ACP's `systemPrompt` carries it when advertised, else it
   * leads the session's first prompt. */
  systemPrompt?(
    process: AcpProcess,
    sessionId: string,
    text: string,
  ): Promise<void>;
  /** Steers a message into the running turn. Without it, a message sent
   * mid-turn runs as the next turn. */
  steering?: Readonly<{
    /** The running turn's id from an update: undefined when none runs,
     * null when the update says nothing about it. */
    runId(update: Record<string, unknown>): string | undefined | null;
    steer(
      process: AcpProcess,
      sessionId: string,
      runId: string,
      text: string,
    ): Promise<void>;
  }>;
  /** Puts a session on `want` before a turn, keeping `session.chosen` to
   * what it now runs on, and handing `session.offer` each config answer.
   * Without it, the harness's own pick stands. */
  select?(
    process: AcpProcess,
    session: {
      readonly id: string;
      chosen: Choice;
      offer(options: ConfigOptions): void;
    },
    want: Choice,
  ): Promise<void>;
  /** Whether `session/close` is sent: always, or only when
   * `sessionCapabilities.close` is advertised (the default). */
  closeSession?: "always" | "advertised";
}>;
