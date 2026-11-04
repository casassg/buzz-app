// The models and thinking levels `opencode acp` offers, read from a short-lived
// session in the home folder. Nothing is cached after a failure.
import { REQUEST_TIMEOUT_MS } from "../../features/agent-harness/acp/process";
import type { Models } from "../../features/agents/service";
import { OpenCodeProcess, type OpenCodeHost } from "./opencode";

type Option = {
  id?: string;
  category?: string | null;
  currentValue?: string;
  options?: { value: string; name?: string }[];
};

/** `model` and `effort` picks from a `session/new` answer. */
export function picks(configOptions: readonly Option[], current = ""): Models {
  const model = configOptions.find((item) => item.id === "model");
  const levels = (
    configOptions.find((item) => item.category === "thought_level")?.options ??
    []
  ).map(({ value, name }) => ({ id: value, label: name || value }));
  const resting = configOptions.find(
    (item) => item.category === "thought_level",
  )?.currentValue;
  const selected = current || model?.currentValue || "";
  return {
    current: selected,
    models: (model?.options ?? []).map(({ value, name }) => ({
      id: value,
      label: name || value,
      efforts: value === (model?.currentValue ?? "") ? levels : [],
      ...(resting && value === (model?.currentValue ?? "")
        ? { effort: resting }
        : {}),
    })),
  };
}

export class OpenCodeModels {
  private reading: Promise<Models> | undefined;
  constructor(private readonly host: OpenCodeHost) {}

  read(): Promise<Models> {
    if (this.reading) return this.reading;
    const reading = (async () => {
      const opencode = await OpenCodeProcess.start(this.host.spawn, {
        cwd: await this.host.resolveDirectory("~"),
      });
      try {
        const opened = (await opencode.request(
          "session/new",
          { cwd: await this.host.resolveDirectory("~"), mcpServers: [] },
          REQUEST_TIMEOUT_MS,
        )) as { configOptions?: Option[] };
        return picks(opened.configOptions ?? []);
      } finally {
        void opencode.kill();
      }
    })();
    this.reading = reading;
    reading.catch(() => {
      if (this.reading === reading) this.reading = undefined;
    });
    return reading;
  }
}
