import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../bin/claude-code-mcp.mjs", import.meta.url));
const preloadPath = fileURLToPath(new URL("../test-support/mock-claude-spawn.cjs", import.meta.url));

test("uses claude by default", async () => {
  const server = await startMockServer();
  try {
    const status = JSON.parse(await server.call("claude_status", {}));
    assert.equal(status.available, true);
    assert.equal(status.version, "mock-claude 1.0.0");
    assert.deepEqual(await server.invocations(), [{ command: "claude", args: ["--version"] }]);
  } finally {
    await server.close();
  }
});

test("uses CLAUDE_CODE_MCP_CLAUDE_BIN for status, tasks, and reviews", async () => {
  const cliPath = path.join(tmpdir(), "custom claude executable", "claude.exe");
  const server = await startMockServer({ CLAUDE_CODE_MCP_CLAUDE_BIN: cliPath });
  try {
    const status = JSON.parse(await server.call("claude_status", {}));
    assert.equal(status.available, true);
    await server.call("claude_run", { prompt: "inspect the repository", cwd: process.cwd() });
    await server.call("claude_review", { cwd: process.cwd() });
    const invocations = await server.invocations();
    assert.equal(invocations.length, 3);
    assert.deepEqual(invocations.map(({ command }) => command), [cliPath, cliPath, cliPath]);
    assert.equal(invocations[1].args.at(-1), "inspect the repository");
    assert.equal(invocations[2].args.at(-2), "--");
    assert.equal(invocations[2].args.at(-1).startsWith("Review the changes"), true);
  } finally {
    await server.close();
  }
});

test("reports unavailable and rejects tasks and reviews when the executable is missing", async () => {
  const missingCommand = "claude-code-mcp-missing-sentinel";
  const server = await startMockServer({
    CLAUDE_CODE_MCP_CLAUDE_BIN: missingCommand,
    CLAUDE_CODE_MCP_MOCK_MISSING_COMMAND: missingCommand
  });
  try {
    const status = JSON.parse(await server.call("claude_status", {}));
    assert.equal(status.available, false);
    assert.equal(status.version, null);
    assert.match(status.error, /ENOENT/);
    await assert.rejects(server.call("claude_run", { prompt: "inspect the repository", cwd: process.cwd() }), /Unable to run claude-code-mcp-missing-sentinel: spaw.*ENOENT/);
    await assert.rejects(server.call("claude_review", { cwd: process.cwd() }), /Unable to run claude-code-mcp-missing-sentinel: spaw.*ENOENT/);
  } finally {
    await server.close();
  }
});

test("keeps the prompt after variadic --allowedTools options", async () => {
  const prompt = "report the current changes";
  const server = await startMockServer({ CLAUDE_CODE_MCP_CLAUDE_BIN: path.join(tmpdir(), "custom-claude-executable") });
  try {
    await server.call("claude_run", { prompt, cwd: process.cwd(), allowed_tools: ["Read", "Glob"] });
    const invocations = await server.invocations();
    assert.equal(invocations.length, 1);
    assert.deepEqual(invocations[0].args.slice(-4), ["--allowedTools", "Read,Glob", "--", prompt]);
  } finally {
    await server.close();
  }
});

async function startMockServer(env = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-code-mcp-test-"));
  const spawnLog = path.join(dir, "spawns.jsonl");
  const childEnv = { ...process.env, ...env, CLAUDE_CODE_MCP_REVIEW_AFTER_RUN: "false", CLAUDE_CODE_MCP_SPAWN_LOG: spawnLog };
  if (!("CLAUDE_CODE_MCP_CLAUDE_BIN" in env)) delete childEnv.CLAUDE_CODE_MCP_CLAUDE_BIN;
  childEnv.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--require ${JSON.stringify(preloadPath.replaceAll("\\", "/"))}`].filter(Boolean).join(" ");

  const child = spawn(process.execPath, [serverPath], { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  const replies = new Map();
  let nextId = 0;
  let lineBuffer = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    lineBuffer += chunk;
    let newline;
    while ((newline = lineBuffer.indexOf("\n")) !== -1) {
      const line = lineBuffer.slice(0, newline).trim();
      lineBuffer = lineBuffer.slice(newline + 1);
      if (!line) continue;
      const reply = JSON.parse(line);
      const pending = replies.get(reply.id);
      if (!pending) continue;
      replies.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.error) pending.reject(new Error(reply.error.message));
      else if (reply.result?.isError) pending.reject(new Error(reply.result.content?.[0]?.text || "Tool call failed"));
      else pending.resolve(reply.result?.content?.[0]?.text);
    }
  });
  const rejectPending = (error) => {
    for (const pending of replies.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    replies.clear();
  };
  child.once("error", (error) => rejectPending(new Error(`Unable to start MCP server: ${error.message}`)));
  child.once("exit", (code, signal) => { if (replies.size) rejectPending(new Error(`MCP server exited before replying (${code ?? signal}): ${stderr}`)); });

  return {
    call(name, args) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          replies.delete(id);
          reject(new Error(`Timed out waiting for ${name}: ${stderr}`));
        }, 5_000);
        replies.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
      });
    },
    async invocations() {
      try {
        return (await readFile(spawnLog, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    },
    async close() {
      child.stdin.end();
      child.kill();
      if (child.exitCode === null) {
        let timer;
        try {
          await Promise.race([once(child, "exit"), new Promise((resolve) => { timer = setTimeout(resolve, 1_000); })]);
        } finally {
          clearTimeout(timer);
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  };
}
