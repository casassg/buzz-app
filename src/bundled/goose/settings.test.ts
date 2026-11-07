import { expect, it } from "vitest";
import {
  settingsProblem,
  syncedSettings,
} from "../../features/agents/agent-config";
import {
  syncedSettings as claude,
  syncedSettingsSchema as claudeSchema,
} from "../claude-code/settings";
import {
  syncedSettings as codex,
  syncedSettingsSchema as codexSchema,
} from "../codex/settings";
import { DEFAULT_CONFIG as opencodeDefaults } from "../opencode/runtime";
import {
  adopt as opencodeAdopt,
  carry as opencodeCarry,
  syncedSettings as opencode,
  syncedSettingsSchema as opencodeSchema,
} from "../opencode/settings";
import { DEFAULT_CONFIG as gooseDefaults } from "./runtime";
import {
  syncedSettings as goose,
  syncedSettingsSchema as gooseSchema,
  withSyncedSettings,
} from "./settings";

it("syncs every agent setting except instructions and the device-local folder", () => {
  const base = {
    model: "m",
    effort: "high",
    instructions: "secret plan",
    workspace: "~/w",
    scope: "thread" as const,
  };
  expect(claude(base)).toEqual({
    model: "m",
    effort: "high",
    scope: "thread",
  });
  expect(codex(base)).toEqual({
    model: "m",
    effort: "high",
    scope: "thread",
  });
  expect(opencode(base)).toEqual({
    model: "m",
    effort: "high",
    scope: "thread",
  });
  expect(goose({ ...gooseDefaults, provider: "p", instructions: "x" })).toEqual(
    {
      model: "",
      provider: "p",
      effort: "",
      scope: "thread",
    },
  );
  for (const [schema, settings] of [
    [claudeSchema, claude(base)],
    [codexSchema, codex(base)],
    [opencodeSchema, opencode(base)],
    [gooseSchema, goose(gooseDefaults)],
  ] as const)
    expect(settingsProblem(schema, settings)).toBeUndefined();
});

it("applies only allowlisted synced fields over local config", () => {
  const local = { ...gooseDefaults, instructions: "mine" };
  expect(
    withSyncedSettings(local, {
      model: "m2",
      instructions: "theirs",
      workspace: "/srv",
    }),
  ).toEqual({ ...local, model: "m2" });
});

it("carries opencode instructions and workspace across a type change, not its model", () => {
  const saved = {
    ...opencodeDefaults,
    model: "m",
    effort: "high",
    instructions: "plan",
    workspace: "~/w",
  };
  expect(opencodeCarry(saved)).toEqual({
    instructions: "plan",
    workspace: "~/w",
  });
  expect(opencodeCarry(opencodeDefaults)).toEqual({});
  expect(
    opencodeAdopt({ instructions: "plan", workspace: "~/w" }, opencodeDefaults),
  ).toEqual({ ...opencodeDefaults, instructions: "plan", workspace: "~/w" });
  expect(opencodeAdopt({}, saved)).toEqual(saved);
});

it("rejects a remote workspace setting as an unknown key for every agent type", () => {
  for (const [agentType, schema] of [
    ["claude-code", claudeSchema],
    ["codex", codexSchema],
    ["opencode", opencodeSchema],
    ["goose", gooseSchema],
  ] as const) {
    const content = JSON.stringify({
      version: 1,
      agentType,
      settings: { workspace: "~/w" },
    });
    expect(syncedSettings(content, agentType, schema)).toEqual({
      problem: 'Unknown setting "workspace"',
    });
  }
});
