# AgentMemory OpenCode plugin

A plugin for [OpenCode](https://opencode.ai) that gives the agent direct access to
a self-hosted [AgentMemory](https://github.com/hsuanshao/AgentMemory) server
(rust `memory-core`, port **8420**).

It provides four tools and an automatic turn-capture hook:

| Tool | What it does |
| --- | --- |
| `agentmemory_recall` | Search long-term memory (facts, past decisions, preferences, persona). |
| `agentmemory_add` | Add one conversation turn to AgentMemory L0. |
| `agentmemory_conversations` | List stored memory conversations for the team + agent. |
| `agentmemory_stats` | Instance layer sizes (L0–L3, skills). |

On every `session.idle` the plugin automatically reads the finished turn and
writes it to AgentMemory L0 (including tool calls/results), so the agent's
work accumulates in long-term memory with no manual steps.

## Prerequisites

1. The AgentMemory server is **running** (`http://localhost:8420` by default).
2. You have a **user key** for AgentMemory (`sk-mem-…`). You can get it from the
   AgentMemory Panel admin page (`/v3/internal/meta/user/init-admin`).
3. OpenCode **v2** is installed.

## Install

Pick one of the two methods.

### Method A — Load from the repo (development)

1. Copy `clients/opencode/agentmemory` anywhere you like (e.g. `~/agentmemory-opencode`).
2. Install its runtime dependencies (OpenCode does **not** provide
   `@opencode-ai/plugin`; skipping this makes the plugin fail to load):

   ```bash
   cd ~/agentmemory-opencode
   npm install
   ```

3. Add this to your global `~/.config/opencode/opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "~/agentmemory-opencode",
      {
        "baseUrl": "http://localhost:8420",
        "userKey": "sk-mem-…",
        "serviceId": "default",
        "teamId": "<TEAM_ID>",
        "agentId": "<AGENT_ID>",
        "apiKey": "<AGENT_MEMORY_API_KEY>"
      }
    ]
  ]
}
```

### Method B — Publish to npm

```bash
cd clients/opencode/agentmemory
npm pkg set name="@yourname/agentmemory-opencode"
npm publish
```

then in `~/.config/opencode/opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@yourname/agentmemory-opencode",
      {
        "baseUrl": "http://localhost:8420",
        "userKey": "sk-mem-…",
        "serviceId": "default",
        "teamId": "<TEAM_ID>",
        "agentId": "<AGENT_ID>",
        "apiKey": "<AGENT_MEMORY_API_KEY>"
      }
    ]
  ]
}
```

> `@opencode-ai/plugin` is a runtime dependency. It is installed automatically
> for npm-published plugins, but a plugin loaded from a local path needs
> `npm install` first. During development you can type-check and test with:
> `cd clients/opencode/agentmemory && npm install && npm run typecheck && bun test`.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl` | `http://localhost:8420` | AgentMemory server base URL |
| `userKey` | — | Personal user key (`sk-mem-…`). **Required** for data-plane calls. |
| `serviceId` | `default` | Instance id (matches the AgentMemory install). |
| `teamId` | — | Team id. **Required**; there is no `default` team. |
| `agentId` | — | Agent id. **Required**, and the agent must belong to `teamId`. |
| `apiKey` | `null` | Instance API key (`AGENT_MEMORY_API_KEY`). Needed for Bearer-scoped calls such as `v3/stats/overview`. |

Missing `teamId`, `agentId` or `userKey` fails plugin load with an explicit
error instead of silently using a `default` scope.

## Usage

Once loaded, the four tools are available to any agent:

- `agentmemory_recall` — search memory: `{ "query": "..." }`
- `agentmemory_add` — add a turn: `{ "role": "user", "content": "..." }` or
  with `toolCalls`/`toolResults` to record tool use.
- `agentmemory_conversations` — list sessions: `{ "query": "..." }`
- `agentmemory_stats` — scoped L0–L3 and skill counts: `{}`. Generation logs
  come from the instance-wide `v3/stats/overview` endpoint and are labelled
  as such.

The plugin also auto-captures every completed turn to L0, so the agent can
recall it later via `agentmemory_recall`.
