#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

const SERVER_NAME = "claude-code-mcp";
const SERVER_VERSION = "0.3.0";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const KILL_GRACE_MS = 5_000;
const CLI_STATUS_TTL_MS = 5_000;
const CLAUDE_BIN = process.env.CLAUDE_CODE_MCP_CLAUDE_BIN || "claude";
const PERMISSION_MODES = new Set(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const reviewAfterRun = parseBoolean(process.env.CLAUDE_CODE_MCP_REVIEW_AFTER_RUN);
const reviewPrompt = process.env.CLAUDE_CODE_MCP_REVIEW_PROMPT || "Review the changes made for the preceding task. Inspect the working tree and report only actionable defects, regressions, security concerns, or missing tests. Do not make changes.";
const reviewModel = process.env.CLAUDE_CODE_MCP_REVIEW_MODEL;
const jobs = new Map();
let nextJobNumber = 1;
let latestJobId;
let cliStatusCache;

const tools = [
  tool("claude_run", "Run a Claude Code task. Set background to true to return a job ID immediately; use claude_status, claude_result, and claude_cancel to manage it.", {
    prompt: stringSchema("Task for Claude Code.", true), model: stringSchema("Optional per-invocation model override."), effort: effortSchema(), cwd: stringSchema("Working directory. Defaults to the server working directory."),
    permission_mode: { type: "string", enum: [...PERMISSION_MODES], description: "Defaults to manual." }, allowed_tools: { type: "array", items: { type: "string" } },
    max_budget_usd: { type: "number", minimum: 0 }, timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS }, background: { type: "boolean", description: "Run as a managed background job." },
    review_after_run: { type: "boolean", description: "Override the configured review hook for this invocation." }, review_model: stringSchema("Optional model override for the review only.")
  }, ["prompt"]),
  tool("claude_review", "Run a read-only Claude Code review. Omit model to use the configured default.", {
    cwd: stringSchema("Directory to review."), model: stringSchema("Optional per-invocation model override."), effort: effortSchema(), prompt: stringSchema("Optional review focus."), timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS }
  }),
  tool("claude_status", "Show Claude Code availability and managed background job status. Supply job_id to select one job.", { job_id: stringSchema("Optional background job ID.") }),
  tool("claude_result", "Return the stored result for a completed background job. Omit job_id to use the most recent job.", { job_id: stringSchema("Optional background job ID.") }),
  tool("claude_cancel", "Cancel a running background job and its subprocess group.", { job_id: stringSchema("Background job ID.", true) }, ["job_id"])
];

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    const result = await dispatch(request);
    if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    if (request?.id !== undefined) send({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error.message || "Internal error" } });
  }
});

async function dispatch(request) {
  if (request.method === "initialize") return { protocolVersion: request.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } };
  if (["notifications/initialized", "ping"].includes(request.method)) return {};
  if (request.method === "tools/list") return { tools };
  if (request.method === "tools/call") return callTool(request.params || {});
  throw new Error(`Method not found: ${request.method}`);
}

async function callTool({ name, arguments: args = {} }) {
  try {
    validateArguments(name, args);
    if (name === "claude_run") return toolJson(args.background ? startJob(args) : await runTask(args));
    if (name === "claude_review") return toolJson(await runReview(args));
    if (name === "claude_status") return toolJson(await getStatus(args.job_id));
    if (name === "claude_result") return toolJson(getResult(args.job_id));
    if (name === "claude_cancel") return toolJson(cancelJob(args.job_id));
    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return { content: [{ type: "text", text: error.message || String(error) }], isError: true };
  }
}

function startJob(args) {
  const id = `job-${nextJobNumber++}`;
  const job = { id, status: "running", startedAt: new Date().toISOString(), process: undefined, result: undefined, error: undefined, cancelRequested: false };
  jobs.set(id, job);
  latestJobId = id;
  job.promise = runTask(args, {
    isCancelled: () => job.cancelRequested,
    onProcess: (process) => {
      job.process = process;
      if (job.cancelRequested) process.cancel();
    }
  })
    .then((result) => {
      job.status = job.cancelRequested ? "cancelled" : "completed";
      if (!job.cancelRequested) job.result = result;
      job.endedAt = new Date().toISOString();
    })
    .catch((error) => { job.status = job.cancelRequested ? "cancelled" : "failed"; job.error = error.message || String(error); job.endedAt = new Date().toISOString(); });
  return jobSummary(job);
}

function getResult(id) {
  const job = getJob(id);
  if (job.status !== "completed") {
    if (job.status === "failed") throw new Error(`Job ${job.id} failed: ${job.error}`);
    if (job.status === "cancelled") throw new Error(`Job ${job.id} was cancelled.`);
    throw new Error(`Job ${job.id} is ${job.status}. Results are available only after completion.`);
  }
  return { ...jobSummary(job), output: job.result };
}

function cancelJob(id) {
  const job = getJob(id);
  if (job.status !== "running") return jobSummary(job);
  job.cancelRequested = true;
  job.status = "cancelling";
  job.process?.cancel();
  return jobSummary(job);
}

function getJob(id) {
  const job = jobs.get(id || latestJobId);
  if (!job) throw new Error(id ? `Unknown job: ${id}` : "No background jobs have been started.");
  return job;
}

function jobSummary(job) { return { jobId: job.id, status: job.status, startedAt: job.startedAt, endedAt: job.endedAt }; }

async function runTask(args, options = {}) {
  const cwd = resolveCwd(args.cwd);
  throwIfCancelled(options);
  const task = await executeClaude({ prompt: args.prompt, cwd, model: args.model, effort: args.effort, permissionMode: args.permission_mode || "manual", allowedTools: args.allowed_tools, maxBudgetUsd: args.max_budget_usd, timeoutMs: args.timeout_ms, onProcess: options.onProcess });
  const output = { task };
  const shouldReview = args.review_after_run ?? reviewAfterRun;
  if (shouldReview && task.exitCode === 0) output.review = await runReview({ cwd, model: args.review_model || reviewModel, timeout_ms: args.timeout_ms }, options);
  return output;
}

async function runReview(args, options = {}) {
  const cwd = resolveCwd(args.cwd);
  throwIfCancelled(options);
  const review = await executeClaude({ prompt: args.prompt || reviewPrompt, cwd, model: args.model, effort: args.effort, permissionMode: "plan", allowedTools: ["Read", "Glob", "Grep", "Bash(git *)"], timeoutMs: args.timeout_ms, onProcess: options.onProcess });
  return { review };
}

async function getStatus(jobId) {
  return { ...(await getCliStatus()), jobs: jobId ? [jobSummary(getJob(jobId))] : [...jobs.values()].map(jobSummary) };
}

async function getCliStatus() {
  if (cliStatusCache && Date.now() - cliStatusCache.checkedAt < CLI_STATUS_TTL_MS) return cliStatusCache.value;
  try {
    const cli = await execute(CLAUDE_BIN, ["--version"], { cwd: process.cwd(), timeoutMs: 10_000 }).promise;
    cliStatusCache = { checkedAt: Date.now(), value: { available: cli.exitCode === 0, version: cli.stdout.trim() || null, error: cli.stderr.trim() || null } };
  } catch (error) {
    cliStatusCache = { checkedAt: Date.now(), value: { available: false, version: null, error: error.message || String(error) } };
  }
  return cliStatusCache.value;
}

async function executeClaude({ prompt, cwd, model, effort, permissionMode, allowedTools, maxBudgetUsd, timeoutMs, onProcess }) {
  const args = ["--print", "--output-format", "json", "--permission-mode", permissionMode];
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (allowedTools?.length) args.push("--allowedTools", allowedTools.join(","));
  if (maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(maxBudgetUsd));
  // Terminate option parsing so variadic flags such as --allowedTools cannot consume the prompt.
  args.push("--", prompt);
  const process = execute(CLAUDE_BIN, args, { cwd, timeoutMs: boundedTimeout(timeoutMs) });
  onProcess?.(process);
  const result = await process.promise;
  return { exitCode: result.exitCode, result: parseJsonOrText(result.stdout), stderr: result.stderr.trim() || undefined };
}

function execute(command, args, { cwd, timeoutMs }) {
  const child = spawn(command, args, { cwd, env: process.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let terminated = false;
  let cancelled = false;
  let forceKillTimer;
  const terminate = (cancelledByCaller = false) => {
    if (terminated) return;
    terminated = true;
    cancelled = cancelledByCaller;
    killProcessTree(child, "SIGTERM");
    forceKillTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), KILL_GRACE_MS);
  };
  const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  const promise = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); clearTimeout(forceKillTimer); reject(new Error(`Unable to run ${command}: ${error.message}`)); });
    child.once("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(forceKillTimer);
      if (timedOut) return reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      if (cancelled) return reject(new Error(`${command} was cancelled`));
      resolve({ exitCode: code ?? 1, signal, stdout, stderr });
    });
  });
  return { promise, cancel: () => terminate(true) };
}

function killProcessTree(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { if (process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); } catch { child.kill(signal); }
}

function validateArguments(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("arguments must be an object");
  const definition = tools.find((entry) => entry.name === name);
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  const schema = definition.inputSchema;
  for (const key of Object.keys(args)) if (!(key in schema.properties)) throw new Error(`Unexpected argument for ${name}: ${key}`);
  for (const key of schema.required || []) requireString(args[key], key);
  validateOptionalString(args, "model"); validateOptionalString(args, "effort"); validateOptionalString(args, "cwd"); validateOptionalString(args, "prompt"); validateOptionalString(args, "review_model"); validateOptionalString(args, "job_id");
  if (args.effort !== undefined && !EFFORT_LEVELS.has(args.effort)) throw new Error(`effort must be one of: ${[...EFFORT_LEVELS].join(", ")}`);
  if (args.permission_mode !== undefined && !PERMISSION_MODES.has(args.permission_mode)) throw new Error(`permission_mode must be one of: ${[...PERMISSION_MODES].join(", ")}`);
  if (args.allowed_tools !== undefined && (!Array.isArray(args.allowed_tools) || args.allowed_tools.some((tool) => typeof tool !== "string"))) throw new Error("allowed_tools must be an array of strings");
  if (args.max_budget_usd !== undefined && (!Number.isFinite(args.max_budget_usd) || args.max_budget_usd < 0)) throw new Error("max_budget_usd must be a non-negative number");
  if (args.timeout_ms !== undefined && (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1 || args.timeout_ms > MAX_TIMEOUT_MS)) throw new Error(`timeout_ms must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  if (args.background !== undefined && typeof args.background !== "boolean") throw new Error("background must be a boolean");
  if (args.review_after_run !== undefined && typeof args.review_after_run !== "boolean") throw new Error("review_after_run must be a boolean");
}

function resolveCwd(input) {
  const cwd = path.resolve(input || process.cwd());
  try { accessSync(cwd, constants.R_OK | constants.X_OK); if (!statSync(cwd).isDirectory()) throw new Error("not a directory"); }
  catch { throw new Error(`cwd is not an accessible directory: ${cwd}`); }
  return cwd;
}

function tool(name, description, properties, required = []) { return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } }; }
function stringSchema(description, required = false) { return { type: "string", ...(required ? { minLength: 1 } : {}), description }; }
function effortSchema() { return { type: "string", enum: [...EFFORT_LEVELS], description: "Optional Claude CLI reasoning effort for this invocation." }; }
function validateOptionalString(args, key) { if (args[key] !== undefined && (typeof args[key] !== "string" || !args[key].trim())) throw new Error(`${key} must be a non-empty string`); }
function throwIfCancelled(options) { if (options.isCancelled?.()) throw new Error("Task was cancelled before process start"); }
function parseJsonOrText(value) { try { return JSON.parse(value); } catch { return value.trim(); } }
function boundedTimeout(value) { return Math.min(Math.max(value || DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS); }
function requireString(value, key) { if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`); }
function parseBoolean(value) { return /^(1|true|yes)$/i.test(value || ""); }
function toolJson(value) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }; }
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
