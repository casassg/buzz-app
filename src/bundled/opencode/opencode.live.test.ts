// @vitest-environment node
// Drives a real `opencode acp`: run with OPENCODE_LIVE=1 (OPENCODE_BIN to pick
// the binary, OPENCODE_MODEL for the model). The Buzz tools are served from a
// loopback HTTP MCP server and their calls recorded, not sent to a relay.
import { spawn as spawnChild } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { respond } from "../../buzz-mcp/rpc";
import {
  answerMcp,
  type HostProcessOptions,
} from "../../features/host/service";
import { systemPrompt } from "../claude-code/prompt";
import { OpenCodeModels } from "./models";
import type { Spawn } from "../../features/agent-harness/acp/types";
import { OpenCodeProcess, type ServeMcp, type ToolServer } from "./opencode";

const LIVE = process.env.OPENCODE_LIVE === "1";
const MODEL = process.env.OPENCODE_MODEL ?? "anthropic/claude-haiku-4-5";

const spawn: Spawn = async (_id, options: HostProcessOptions = {}) => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(options.env ?? {}))
    if (value === null) delete env[key];
    else env[key] = value;
  const child = spawnChild(process.env.OPENCODE_BIN ?? "opencode", ["acp"], {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8").on("data", (d) => options.onStdout?.(d));
  child.stderr.setEncoding("utf8").on("data", (d) => options.onStderr?.(d));
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  return {
    write: (data) =>
      new Promise<void>((resolve, reject) =>
        child.stdin.write(data, (error) => (error ? reject(error) : resolve())),
      ),
    end: async (data) => {
      child.stdin.end(data);
    },
    kill: async () => {
      child.kill();
    },
    exited,
  };
};

const serve: ServeMcp = async (handler) => {
  const token = randomBytes(32).toString("base64url");
  const server = createServer((request, response) => {
    if (
      request.url?.split("?")[0] !== "/mcp" ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8").on("data", (data) => (body += data));
    request.on("end", async () => {
      const reply = await answerMcp(handler, body);
      response.writeHead(
        reply === undefined ? 202 : 200,
        reply === undefined ? {} : { "Content-Type": "application/json" },
      );
      response.end(reply === undefined ? undefined : JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const closed = new Promise<void>((resolve) =>
    server.on("close", () => resolve()),
  );
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    close: async () => {
      server.closeAllConnections();
      server.close();
    },
    closed,
  };
};

type Send = { name?: string; arguments?: { text?: string } };

async function live() {
  const calls: { method: string; params: unknown }[] = [];
  const tools: ToolServer = async (_conversation, message) => {
    calls.push({ method: message.method, params: message.params });
    if (message.method === "tools/call")
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "Sent." }] },
      };
    return respond(undefined, {}, message);
  };
  const cwd = mkdtempSync(join(tmpdir(), "buzz-opencode-"));
  const opencode = await OpenCodeProcess.start(spawn, { cwd, serve });
  const sends = () =>
    calls
      .filter((call) => call.method === "tools/call")
      .map((call) => call.params as Send)
      .filter((call) => call.name === "send");
  return { opencode, cwd, tools, calls, sends };
}

describe.skipIf(!LIVE)("opencode acp", () => {
  it("lists models with the current one's effort levels", {
    timeout: 60_000,
  }, async () => {
    const { models, current } = await new OpenCodeModels({
      spawn,
      resolveDirectory: async (path) =>
        path.replace(/^~/, process.env.HOME ?? ""),
    }).read();
    expect(models.length).toBeGreaterThan(0);
    const now = models.find((model) => model.id === current);
    expect(now).toBeDefined();
    expect(now?.efforts?.length).toBeGreaterThan(0);
  });

  it("answers a mention without treating it as a file, and sees the Buzz tools", {
    timeout: 180_000,
  }, async () => {
    const { opencode, cwd, tools, calls, sends } = await live();
    try {
      const session = await opencode.open({
        cwd,
        tools,
        choice: () => ({ provider: "", model: MODEL }),
        systemPrompt: systemPrompt({
          scope: "thread",
          cwd,
          agent: { name: "Ada", pubkey: "a".repeat(64) },
        }),
      });
      session.conversation = "channel/root";
      const plain = await session.send(
        "<context>\nScope: thread\nAgent: Ada\n</context>\n\n@Someone: what is 2+2? Answer with just the number.",
      );
      expect(plain.ok).toBe(true);
      expect(plain.text ?? "").toContain("4");
      expect(plain.text ?? "").not.toMatch(
        /(no|not|couldn't|can't|cannot|unable).{0,60}(agent|file|find).{0,40}@?Someone/i,
      );
      const settled = await session.send(
        "Call the Buzz send tool once with the text `pong` and final true.",
      );
      expect(settled.ok).toBe(true);
      expect(calls.some((call) => call.method === "tools/list")).toBe(true);
      expect(sends().at(-1)?.arguments?.text).toContain("pong");
    } finally {
      await opencode.kill();
    }
  });

  it("switches model and effort with set_config_option", {
    timeout: 120_000,
  }, async () => {
    const { opencode, cwd } = await live();
    try {
      type Options = {
        configOptions: {
          category?: string;
          currentValue?: string;
          options?: { value: string }[];
        }[];
      };
      const scratch = (await opencode.request("session/new", {
        cwd,
        mcpServers: [],
      })) as Options & { sessionId: string };
      const levels = (
        (await opencode.request("session/set_config_option", {
          sessionId: scratch.sessionId,
          configId: "model",
          value: MODEL,
        })) as Options
      ).configOptions.find((item) => item.category === "thought_level");
      const effort = levels?.options?.find(
        (item) => item.value !== levels.currentValue,
      )?.value;
      if (!effort) throw new Error(`${MODEL} lists no other effort`);
      const session = await opencode.open({
        cwd,
        systemPrompt: "",
        choice: () => ({ provider: "", model: MODEL, effort }),
      });
      const settled = await session.send("Reply with exactly: OK");
      expect(settled.ok).toBe(true);
      expect(session.chosen.model).toBe(MODEL);
      expect(session.chosen.effort).toBe(effort);
    } finally {
      await opencode.kill();
    }
  });
});
