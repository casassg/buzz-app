// The agent settings that sync across devices (NIP-AP `buzz.agent.settings`):
// every per-agent setting except instructions, which have their own artifact.
// No credentials or env vars live in this config; the allowlist keeps it so.
import {
  pickSettings,
  type SettingsSchema,
  withSynced,
} from "../../features/agents/agent-config";
import type { Carry } from "../../features/agents/native";
import { type Config, config, DEFAULT_CONFIG } from "./runtime";

export const syncedSettingsSchema = {
  model: "string",
  effort: "string",
  scope: ["thread", "channel"],
} as const satisfies SettingsSchema;

export const syncedSettings = (config: Config) =>
  pickSettings(syncedSettingsSchema, config);

/** Synced fields come only from `settings`, a left-out one from the default;
 * everything else stays this device's. */
export const withSyncedSettings = (
  config: Config,
  settings: Readonly<Record<string, string>>,
): Config => withSynced(syncedSettingsSchema, DEFAULT_CONFIG, config, settings);

/** What another harness may take over when the agent changes type: its
 * instructions and a workspace other than the default. */
export const carry = (saved: unknown): Carry => {
  const { instructions, workspace } = config(saved);
  return {
    ...(instructions.trim() && { instructions }),
    ...(workspace !== DEFAULT_CONFIG.workspace && { workspace }),
  };
};

/** A brought-over agent keeps the instructions and workspace it carries. */
export const adopt = (brought: Carry, saved: Config): Config => ({
  ...saved,
  instructions: brought.instructions ?? saved.instructions,
  workspace: brought.workspace ?? saved.workspace,
});
