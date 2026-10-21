import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const server = new URL("../bin/claude-code-mcp.mjs", import.meta.url).pathname;

test("advertises Claude tools and accepts initialize", async () => {
  const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => lines.push(...data.trim().split("\n").filter(Boolean).map(JSON.parse)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
  await waitFor(() => lines.length === 1);
  assert.equal(lines[0].result.serverInfo.name, "claude-code-mcp");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  await waitFor(() => lines.length === 2);
  assert.deepEqual(lines[1].result.tools.map((tool) => tool.name), ["claude_run", "claude_review", "claude_status", "claude_result", "claude_cancel"]);
  child.kill();
});

test("passes per-invocation model and effort options", async () => {
  const fakeBin = await mkdtemp(path.join(tmpdir(), "claude-code-mcp-"));
  const fakeClaude = path.join(fakeBin, "claude");
  await writeFile(fakeClaude, `#!${process.execPath}
const args = process.argv.slice(2);
const output = () => console.log(JSON.stringify({ args }));
if (args.at(-1) === "wait") setTimeout(output, 500); else if (args.at(-1) === "forever") setInterval(() => {}, 1_000); else output();
`);
  await chmod(fakeClaude, 0o755);
  const client = createClient({ PATH: `${fakeBin}:${process.env.PATH}` });
  const withoutModel = JSON.parse(await client.call("claude_run", { prompt: "first task", cwd: process.cwd() }));
  assert.equal(withoutModel.task.result.args.includes("--model"), false);
  const withModel = JSON.parse(await client.call("claude_run", { prompt: "second task", model: "sonnet", effort: "high", cwd: process.cwd() }));
  assert.deepEqual(withModel.task.result.args.slice(-6), ["--model", "sonnet", "--effort", "high", "--", "second task"]);
  const review = JSON.parse(await client.call("claude_review", { model: "opus", effort: "max", cwd: process.cwd() }));
  assert.equal(review.review.result.args[review.review.result.args.indexOf("--model") + 1], "opus");
  assert.equal(review.review.result.args[review.review.result.args.indexOf("--effort") + 1], "max");
  await assert.rejects(client.call("claude_review", { effort: "invalid" }), /effort must be one of/);
  client.close();
});

test("returns the review hook as a nested object", async () => {
  const fakeBin = await createFakeClaude();
  const client = createClient({ PATH: `${fakeBin}:${process.env.PATH}`, CLAUDE_CODE_MCP_REVIEW_AFTER_RUN: "true" });
  const output = JSON.parse(await client.call("claude_run", { prompt: "task", cwd: process.cwd() }));
  assert.equal(typeof output.review, "object");
  assert.equal(typeof output.review.review, "object");
  assert.equal(output.review.review.result.args.at(-1).startsWith("Review the changes"), true);
  client.close();
});

test("manages a background task and rejects invalid arguments", async () => {
  const fakeBin = await createFakeClaude();
  const client = createClient({ PATH: `${fakeBin}:${process.env.PATH}` });
  const started = JSON.parse(await client.call("claude_run", { prompt: "wait", cwd: process.cwd(), background: true }));
  assert.equal(started.status, "running");
  await waitForAsync(async () => (JSON.parse(await client.call("claude_status", { job_id: started.jobId }))).jobs[0].status === "completed");
  const result = JSON.parse(await client.call("claude_result", { job_id: started.jobId }));
  assert.equal(result.output.task.result.args.at(-1), "wait");
  await assert.rejects(client.call("claude_run", { prompt: "x", unsupported: true }), /Unexpected argument/);
  await assert.rejects(client.call("claude_run", { prompt: "x", permission_mode: "not-a-mode" }), /permission_mode must be one of/);
  await assert.rejects(client.call("claude_run", { prompt: "wait", cwd: process.cwd(), timeout_ms: 10 }), /timed out/);
  const cancellable = JSON.parse(await client.call("claude_run", { prompt: "slow-cancel", cwd: process.cwd(), background: true }));
  const cancelling = JSON.parse(await client.call("claude_cancel", { job_id: cancellable.jobId }));
  assert.equal(cancelling.status, "cancelling");
  await assert.rejects(client.call("claude_result", { job_id: cancellable.jobId }), /Results are available only after completion/);
  await waitForAsync(async () => (JSON.parse(await client.call("claude_status", { job_id: cancellable.jobId }))).jobs[0].status === "cancelled");
  client.close();
});

async function createFakeClaude() {
  const fakeBin = await mkdtemp(path.join(tmpdir(), "claude-code-mcp-"));
  const fakeClaude = path.join(fakeBin, "claude");
  await writeFile(fakeClaude, `#!${process.execPath}
const args = process.argv.slice(2);
const output = () => console.log(JSON.stringify({ args }));
if (args.at(-1) === "wait") setTimeout(output, 500);
else if (args.at(-1) === "forever") setInterval(() => {}, 1_000);
else if (args.at(-1) === "slow-cancel") { process.on("SIGTERM", () => setTimeout(() => process.exit(0), 100)); setInterval(() => {}, 1_000); }
else output();
`);
  await chmod(fakeClaude, 0o755);
  return fakeBin;
}

function createClient(env) {
  const child = spawn(process.execPath, [server], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const replies = new Map();
  const waiters = new Map();
  let id = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    for (const line of data.trim().split("\n").filter(Boolean)) {
      const reply = JSON.parse(line);
      replies.set(reply.id, reply);
      waiters.get(reply.id)?.();
    }
  });
  return {
    async call(name, args) {
      const requestId = ++id;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: args } })}\n`);
      await waitFor(() => replies.has(requestId), waiters, requestId);
      const reply = replies.get(requestId);
      if (reply.result.isError) throw new Error(reply.result.content[0].text);
      return reply.result.content[0].text;
    },
    close() { child.kill(); }
  };
}

async function waitFor(predicate, waiters, id) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for MCP response");
    if (!waiters) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    await new Promise((resolve) => {
      waiters.set(id, resolve);
    });
  }
}

async function waitForAsync(predicate) {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for asynchronous condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
