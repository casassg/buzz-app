// OpenCode agents: an agent type whose agents are OpenCode on this computer,
// all in one `opencode acp` process. Each conversation an agent is in is one
// ACP session in it; OpenCode answers with the in-process Buzz tools, served
// to it over loopback HTTP MCP.
import { isTauri } from "@tauri-apps/api/core";
import { repositoriesContext } from "../../features/communities/repositories";
import type { PluginModule } from "../../plugins/api";
import { OpenCodeModels } from "./models";
import {
  type Config,
  config,
  DEFAULT_CONFIG,
  OpenCodeRuntime,
} from "./runtime";
import {
  adopt,
  carry,
  syncedSettingsSchema,
  withSyncedSettings,
} from "./settings";

export const TYPE_ID = "opencode";
const HANDOVER_MS = 2 * 60_000;

export const inject = ["agents", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  if (!isTauri()) return;
  const { agents, host } = ctx;
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.opencode"}/${TYPE_ID}`;
  const runtime = new OpenCodeRuntime(
    host,
    agents.relay,
    (key, signal) => agents.core(key, signal),
    localStorage,
    () => agents.tools(),
    repositoriesContext,
    agents.storage,
  );
  const models =
    host.spawn && host.resolveDirectory
      ? new OpenCodeModels({
          spawn: host.spawn.bind(host),
          resolveDirectory: host.resolveDirectory.bind(host),
        })
      : undefined;
  const sync = () => {
    const snapshot = agents.snapshot();
    if (snapshot.status === "loading") return;
    runtime.sync(snapshot.running.filter((agent) => agent.type === typeKey));
  };
  if (host.spawn) {
    const unsubscribe = agents.subscribe(sync);
    sync();
    ctx.effect(() => () => {
      unsubscribe();
      runtime.dispose();
    });
  }

  agents.register<Config>({
    id: TYPE_ID,
    title: "OpenCode",
    description:
      "OpenCode on this computer, with any provider it supports. Each thread it is mentioned in is one continuing session.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    adopt,
    carry,
    summary: (agent) => config(agent.config).model || "OpenCode",
    sessions: {
      list: (key) =>
        runtime.conversations(key).map(({ key, at }) => {
          const [channelId = key, root] = key.split("/");
          return { channelId, ...(root && { root }), at };
        }),
      subscribe: (listener) => runtime.subscribe(listener),
    },
    models: async () => models?.read() ?? { current: "", models: [] },
    sessionControls: {
      scope: (agent) => config(agent.config).scope,
      state: (agent, place) => runtime.sessionState(agent, place),
      run: (agent, place, action) => runtime.session(agent, place, action),
      subscribe: (listener) => runtime.subscribe(listener),
    },
    run: (delivery) => runtime.run(delivery),
    runOnce: (turn) => runtime.runOnce(turn),
    timeoutMs: HANDOVER_MS,
    syncedSettings: {
      schema: syncedSettingsSchema,
      withSynced: withSyncedSettings,
    },
    resumes: true,
  });
};
