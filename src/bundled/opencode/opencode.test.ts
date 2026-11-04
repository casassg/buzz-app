import { expect, it } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import { bundledPlugins } from "..";
import { OpenCodeModels, picks } from "./models";
import { ENV, OPENCODE, OpenCodeProcess } from "./opencode";
import { config, DEFAULT_CONFIG } from "./runtime";

const CONFIG_OPTIONS = [
  {
    id: "model",
    category: "model",
    currentValue: "anthropic/sonnet",
    options: [
      { value: "anthropic/sonnet", name: "Sonnet" },
      { value: "openai/gpt", name: "GPT" },
    ],
  },
  {
    id: "effort",
    category: "thought_level",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
    ],
  },
  { id: "mode", category: "mode", currentValue: "build", options: [] },
];

/** A stand-in for `opencode acp` over stdio. */
const fake = (failure?: string) => {
  const spawned: { id: string; options: HostProcessOptions }[] = [];
  const received: { method: string; params: Record<string, unknown> }[] = [];
  let killed = 0;
  const spawn = async (id: string, options: HostProcessOptions = {}) => {
    if (failure) throw new Error(failure);
    spawned.push({ id, options });
    return {
      write: async (data: string) => {
        const { id: rpc, method, params } = JSON.parse(data);
        received.push({ method, params });
        const result =
          method === "initialize"
            ? { agentCapabilities: { mcpCapabilities: { http: true } } }
            : method === "session/new"
              ? { sessionId: "s1", configOptions: CONFIG_OPTIONS }
              : { configOptions: CONFIG_OPTIONS };
        queueMicrotask(() =>
          options.onStdout?.(
            `${JSON.stringify({ jsonrpc: "2.0", id: rpc, result })}\n`,
          ),
        );
      },
      end: async () => undefined,
      kill: async () => {
        killed++;
      },
      exited: new Promise<number | null>(() => undefined),
    };
  };
  return { spawn, spawned, received, killed: () => killed };
};

it("registers disabled by default, running opencode acp from PATH with Buzz tools", () => {
  const plugin = bundledPlugins.find(
    ({ manifest }) => manifest.id === "buzz.opencode",
  );
  expect(plugin?.enabledByDefault).toBe(false);
  expect(plugin?.manifest.name).toBe("OpenCode");
  expect(plugin?.manifest.host).toMatchObject({
    processes: [{ id: "opencode", program: "opencode", args: ["acp"] }],
    mcp: true,
    files: true,
  });
  expect(plugin?.manifest.host?.processes?.[0]).not.toHaveProperty("bundled");
});

it("reports a missing opencode binary", async () => {
  const { spawn } = fake("No such file or directory (os error 2)");
  await expect(OpenCodeProcess.start(spawn, { cwd: "/w" })).rejects.toThrow(
    OPENCODE.missing,
  );
  const other = fake("permission denied");
  await expect(
    OpenCodeProcess.start(other.spawn, { cwd: "/w" }),
  ).rejects.toThrow("permission denied");
});

it("starts without the Buzz identity", async () => {
  const opencode = fake();
  await OpenCodeProcess.start(opencode.spawn, { cwd: "/w" });
  expect(opencode.spawned[0]?.id).toBe("opencode");
  expect(opencode.spawned[0]?.options.env).toMatchObject(ENV);
  for (const name of ["BUZZ_PRIVATE_KEY", "BUZZ_AUTH_TAG", "BUZZ_RELAY_URL"])
    expect(ENV[name]).toBeNull();
});

it("puts a session on the picked model and level, and skips what is already set", async () => {
  const opencode = fake();
  const process = await OpenCodeProcess.start(opencode.spawn, { cwd: "/w" });
  const offered: unknown[] = [];
  const session = {
    id: "s1",
    chosen: { provider: "", model: "", effort: "" },
    offer: (options: unknown) => offered.push(options),
  };
  const configured = () =>
    opencode.received
      .filter(({ method }) => method === "session/set_config_option")
      .map(({ params }) => `${params.configId}=${params.value}`);

  await OPENCODE.select?.(process, session, {
    provider: "",
    model: "",
    effort: "",
  });
  expect(configured()).toEqual([]);

  await OPENCODE.select?.(process, session, {
    provider: "",
    model: "openai/gpt",
    effort: "low",
  });
  expect(configured()).toEqual(["model=openai/gpt", "effort=low"]);
  expect(offered).toHaveLength(2);
  expect(session.chosen).toMatchObject({ model: "openai/gpt", effort: "low" });

  await OPENCODE.select?.(process, session, {
    provider: "",
    model: "openai/gpt",
    effort: "low",
  });
  expect(configured()).toHaveLength(2);
});

it("lists the models and levels opencode offers, and kills the probe", async () => {
  expect(picks([])).toEqual({ current: "", models: [] });
  const opencode = fake();
  const models = await new OpenCodeModels({
    spawn: opencode.spawn,
    resolveDirectory: async (path) => path,
  }).read();
  expect(models.current).toBe("anthropic/sonnet");
  expect(models.models.map(({ id }) => id)).toEqual([
    "anthropic/sonnet",
    "openai/gpt",
  ]);
  expect(models.models[0]).toMatchObject({
    effort: "medium",
    efforts: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
    ],
  });
  expect(models.models[1]?.efforts).toEqual([]);
  expect(opencode.killed()).toBe(1);
});

it("does not cache a failed model read", async () => {
  let fail = true;
  const ok = fake();
  const reader = new OpenCodeModels({
    spawn: (id, options) =>
      fail ? Promise.reject(new Error("os error 2")) : ok.spawn(id, options),
    resolveDirectory: async (path) => path,
  });
  await expect(reader.read()).rejects.toThrow(OPENCODE.missing);
  fail = false;
  expect((await reader.read()).models).toHaveLength(2);
});

it("fills a saved config with defaults", () => {
  expect(config(undefined)).toEqual(DEFAULT_CONFIG);
  expect(config({ model: "m" })).toEqual({ ...DEFAULT_CONFIG, model: "m" });
});
