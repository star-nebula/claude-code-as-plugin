# Claude Code Plugin for Any Agent

Use an already-installed and authenticated [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) from Codex or any other MCP-compatible harness.

This is an MCP server, not a host-specific plugin: it communicates over standard input/output and starts the local `claude` executable. That makes its tool interface portable across MCP clients while preserving your existing CLI authentication and default model configuration.

## What it provides

| Tool | Purpose |
| --- | --- |
| `claude_run` | Run a task synchronously or as a managed background job. |
| `claude_review` | Run a read-only review in a working directory. |
| `claude_status` | Check local CLI availability and background-job status. |
| `claude_result` | Retrieve a completed background job's stored output. |
| `claude_cancel` | Cancel a running background job. |

Every task and review accepts optional `model` and `effort` fields. If `model` is omitted, the server does not send `--model`, so the local CLI uses its normally configured default. `effort` maps directly to Claude Code's `--effort` option (`low`, `medium`, `high`, `xhigh`, or `max`).

## Prerequisites

- Node.js 18 or newer
- Claude Code already installed and authenticated
- Codex CLI, if you are using the Codex installation path below

Check the local prerequisites:

```sh
node --version
claude --version
codex --version
```

## Choose the Claude executable

The server runs `claude` from `PATH` by default. Set `CLAUDE_CODE_MCP_CLAUDE_BIN` to the absolute path of an executable to override it for tasks, reviews, and `claude_status` checks:

- Codex: add `--env CLAUDE_CODE_MCP_CLAUDE_BIN=/absolute/path/to/claude` to `codex mcp add`.
- JSON-based clients: add `"CLAUDE_CODE_MCP_CLAUDE_BIN": "/absolute/path/to/claude"` to the server's `env`.

On Windows, use the native `claude.exe` (the target of the npm `claude.cmd` shim, typically `...\node_modules\@anthropic-ai\claude-code\bin\claude.exe`). The server spawns processes without a shell, so point this variable at the `.exe` itself; a `.cmd` shim cannot be executed in this mode. For example: `--env "CLAUDE_CODE_MCP_CLAUDE_BIN=C:\path\to\node_modules\@anthropic-ai\claude-code\bin\claude.exe"`.

## Install in Codex

Clone the repository, or use your existing clone:

```sh
git clone https://github.com/sarthchawla/claude-code-as-plugin.git
cd claude-code-as-plugin
```

Register the server. Run this from the cloned repository. The command records absolute paths for both Node and the local CLI, so it also works when Codex is launched from a desktop app with a minimal `PATH`:

```sh
MCP_SERVER_PATH="$(pwd)/bin/claude-code-mcp.mjs"
MCP_NODE_BIN="$(command -v node)"
MCP_CLAUDE_BIN="$(dirname "$(command -v claude)")"
MCP_PATH="$MCP_CLAUDE_BIN:$(dirname "$MCP_NODE_BIN"):$PATH"

codex mcp add claude-code \
  --env CLAUDE_CODE_MCP_REVIEW_AFTER_RUN=false \
  --env "PATH=$MCP_PATH" \
  -- "$MCP_NODE_BIN" "$MCP_SERVER_PATH"
```

Verify registration:

```sh
codex mcp list
```

Fully restart Codex. The five tools listed above should then be available.

### Enable the post-task review hook

The hook is disabled by default. To enable it, replace the registration:

```sh
codex mcp remove claude-code

MCP_SERVER_PATH="$(pwd)/bin/claude-code-mcp.mjs"
MCP_NODE_BIN="$(command -v node)"
MCP_CLAUDE_BIN="$(dirname "$(command -v claude)")"
MCP_PATH="$MCP_CLAUDE_BIN:$(dirname "$MCP_NODE_BIN"):$PATH"

codex mcp add claude-code \
  --env CLAUDE_CODE_MCP_REVIEW_AFTER_RUN=true \
  --env "PATH=$MCP_PATH" \
  -- "$MCP_NODE_BIN" "$MCP_SERVER_PATH"
```

The hook runs only after a successful `claude_run`. It uses a restricted, read-only tool set and returns its findings under `review` in the same tool response. It adds latency and usage, and does not attempt automatic fixes or feedback loops.

For a customized hook, add either optional environment variable during `codex mcp add`:

```sh
--env 'CLAUDE_CODE_MCP_REVIEW_MODEL=sonnet'
--env 'CLAUDE_CODE_MCP_REVIEW_PROMPT=Review for correctness, security, and missing tests. Do not modify files.'
```

## Use from Codex

Ask Codex to use a tool directly. Typical calls look like these:

```json
{
  "prompt": "Investigate the failing tests and make the smallest safe fix.",
  "cwd": "/absolute/path/to/project",
  "model": "sonnet",
  "effort": "high"
}
```

Omit `model` to use the local CLI default:

```json
{
  "prompt": "Review the current changes for regressions.",
  "cwd": "/absolute/path/to/project"
}
```

The default permission mode is `manual`. `claude_run` also supports `permission_mode`, `allowed_tools`, `max_budget_usd`, `timeout_ms`, and `review_after_run` for a single-call hook override. Use `claude_review` with `model: "opus"` and an `effort` value when you want a higher-effort read-only review.

### Background jobs

Set `background` to `true` to receive a `jobId` immediately:

```json
{
  "prompt": "Investigate the CI regression and prepare a minimal fix.",
  "cwd": "/absolute/path/to/project",
  "background": true
}
```

Then use:

1. `claude_status` with `job_id` while the task runs.
2. `claude_result` with `job_id` after status is `completed`.
3. `claude_cancel` with `job_id` to stop it.

Cancellation sends `SIGTERM` to the subprocess group, followed by `SIGKILL` after five seconds if needed. Job state and output are stored only in memory; restarting the MCP server loses prior job history.

## Configure another MCP harness

Use the standard `mcpServers` entry in [`examples/mcp-server.json`](examples/mcp-server.json), replacing the placeholder path with the absolute location of `bin/claude-code-mcp.mjs`:

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/claude-code-as-plugin/bin/claude-code-mcp.mjs"],
      "env": {
        "CLAUDE_CODE_MCP_REVIEW_AFTER_RUN": "false",
        "PATH": "/directory-containing-claude:/directory-containing-node:/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

## Troubleshooting

- **The tools do not appear:** fully quit and reopen Codex after registration. Existing tasks do not always reload MCP configuration.
- **The server is unavailable:** rerun the registration commands above. They pass absolute Node and CLI paths to Codex, avoiding desktop-app `PATH` differences.
- **The model is not what you expected:** omit `model` to use the CLI default, or supply the desired model alias/value only for that invocation.
- **A background job disappeared:** jobs are process-local. Re-run the task after restarting Codex or the MCP server.
- **Update or remove the server:** use `codex mcp remove claude-code`, then run the registration command again (or leave it removed).

## Security

Any MCP client that can call this server can ask the local CLI to operate in its supplied `cwd`. Register it only with trusted harnesses and repositories. Keep the default `manual` permission mode unless the calling environment provides a suitable sandbox.

## Development

```sh
npm test
```
