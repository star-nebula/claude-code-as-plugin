"use strict";

const { EventEmitter } = require("node:events");
const { appendFileSync } = require("node:fs");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

childProcess.spawn = function mockSpawn(command, args = []) {
  const logPath = process.env.CLAUDE_CODE_MCP_SPAWN_LOG;
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ command, args })}\n`);

  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;

  if (command === process.env.CLAUDE_CODE_MCP_MOCK_MISSING_COMMAND) {
    const error = new Error(`spawn ${command} ENOENT`);
    error.code = "ENOENT";
    process.nextTick(() => child.emit("error", error));
    return child;
  }

  const stdout = args.includes("--version")
    ? "mock-claude 1.0.0\n"
    : `${JSON.stringify({ args })}\n`;
  process.nextTick(() => {
    child.stdout.emit("data", stdout);
    child.emit("close", 0, null);
  });
  return child;
};

syncBuiltinESMExports();
