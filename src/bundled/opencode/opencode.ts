// OpenCode on the shared ACP client: one `opencode acp` process, with model and
// thinking-level picks set as config options. Each session's Buzz tools reach
// OpenCode over HTTP MCP, never a Buzz key.
import { AcpProcess } from "../../features/agent-harness/acp/process";
import { errorMessage } from "../../features/agent-harness/acp/steps";
import type {
  AcpHooks,
  ServeMcp,
  Spawn,
} from "../../features/agent-harness/acp/types";

export type {
  ServeMcp,
  ToolServer,
} from "../../features/agent-harness/acp/types";

/** The desktop host's `spawn` and `resolveDirectory`, which OpenCode starts with. */
export type OpenCodeHost = Readonly<{
  spawn: Spawn;
  resolveDirectory(path: string): Promise<string>;
}>;

/** No Buzz identity reaches `opencode acp` from the app's environment. */
export const ENV: Readonly<Record<string, string | null>> = {
  BUZZ_PRIVATE_KEY: null,
  BUZZ_AUTH_TAG: null,
  BUZZ_RELAY_URL: null,
};

export const OPENCODE: AcpHooks = {
  label: "opencode",
  program: "opencode",
  missing:
    "opencode is not installed or not on your PATH. Install it, then run `opencode auth login`.",
  env: ENV,
  select: async (opencode, session, want) => {
    let levels:
      | { id: string | undefined; values: string[] | undefined }
      | undefined;
    const configure = async (configId: string, value: string) => {
      try {
        const answer = (await opencode.request("session/set_config_option", {
          sessionId: session.id,
          configId,
          value,
        })) as {
          configOptions?: {
            id?: string;
            category?: string | null;
            options?: { value: string }[];
          }[];
        };
        session.offer(answer);
        const option = answer.configOptions?.find(
          (item) => item.category === "thought_level",
        );
        levels = option && {
          id: option.id,
          values: option.options?.map(({ value }) => value),
        };
      } catch (error) {
        throw new Error(
          `opencode could not switch its ${configId} to ${value}: ${errorMessage(error)}`,
        );
      }
    };
    if (want.model && want.model !== session.chosen.model) {
      await configure("model", want.model);
      session.chosen = { ...session.chosen, model: want.model };
    }
    if (want.effort && want.effort !== session.chosen.effort) {
      if (levels?.values && !levels.values.includes(want.effort)) return;
      await configure(levels?.id ?? "effort", want.effort);
      session.chosen = { ...session.chosen, effort: want.effort };
    }
  },
};

/** Starts `opencode acp` and checks it can reach the Buzz tools. */
export const OpenCodeProcess = {
  start: (
    spawn: Spawn,
    launch: Readonly<{
      cwd: string;
      env?: Readonly<Record<string, string | null>>;
      serve?: ServeMcp;
    }>,
  ) => AcpProcess.start(spawn, OPENCODE, launch),
};
