import { tool as makeTool } from "@opencode-ai/plugin";
import type { buildClient } from "./client.ts";

/**
 * Create the AgentMemory tools bound to a single AgentMemory client.
 *
 * The client owns the team/agent scope and auth headers, so every tool and
 * the session-idle hook use exactly the same configured ids.
 */
export function createTools(client: ReturnType<typeof buildClient>) {
  return {
    agentmemory_recall: makeTool({
      description:
        "Search long-term memory for the configured team + agent: facts, preferences, past decisions, personas, and learned context. Returns memory items matched by the query.",
      args: {
        query: makeTool.schema.string().describe("what to look for"),
        maxResults: makeTool.schema.number().describe("max items to return (default 8)").default(8),
        strategy: makeTool.schema.string().describe("recall strategy: bm25, vector, or hybrid (default hybrid)").default("hybrid"),
      },
      async execute(args) {
        try {
          const data = await client.recall(args.query ?? "", args.maxResults ?? 8, args.strategy);
          if (!data || typeof data !== "object") {
            return "recall failed: unexpected response";
          }
          const d = data as {
            memories?: Array<{ id: string; type: string; content: string; score: number }>;
          };
          if (!Array.isArray(d.memories)) {
            return "recall failed: response did not contain a memories array";
          }
          const items = d.memories;
          if (items.length === 0) {
            return "No matching memories found.";
          }
          const lines: string[] = [];
          for (let i = 0; i < items.length; i += 1) {
            const it = items[i];
            lines.push(`[${i + 1}] (score ${it.score.toFixed(3)}) ${it.content}`);
          }
          return `Found ${items.length} memory item(s):\n\n${lines.join("\n")}`;
        } catch (err) {
          return `recall failed: ${String(err)}`;
        }
      },
    }),

    agentmemory_add: makeTool({
      description:
        "Add one conversation turn to AgentMemory L0 for the configured team + agent. role=user for user messages, role=assistant for assistant messages (optionally with tool calls/results).",
      args: {
        role: makeTool.schema.enum(["user", "assistant"]),
        content: makeTool.schema.string().describe("message content"),
        toolCalls: makeTool.schema
          .array(
            makeTool.schema.object({
              name: makeTool.schema.string().describe("tool name"),
              arguments: makeTool.schema.string().describe("tool input json"),
              id: makeTool.schema.string().describe("tool call id"),
            })
          )
          .optional(),
        toolResults: makeTool.schema
          .array(
            makeTool.schema.object({
              name: makeTool.schema.string().describe("tool name"),
              result: makeTool.schema.string().describe("tool output json"),
              id: makeTool.schema.string().describe("tool call id this result belongs to"),
            })
          )
          .optional(),
      },
      async execute(args, context) {
        const role = (args.role ?? "user") as "user" | "assistant";
        const content = buildContentText(args);
        const messages = [{ role, content }];

        const pairs: Array<{ role: "user" | "assistant"; content: string }> = [];
        if (args.toolCalls && args.toolCalls.length) {
          for (const tc of args.toolCalls) {
            pairs.push({ role: "assistant", content: `${tc.name}(${tc.arguments})` });
            if (args.toolResults && args.toolResults.find((r) => r.id === tc.id)) {
              pairs.push({ role: "user", content: "[tool result pending]" });
            }
          }
        } else {
          pairs.push({ role, content });
        }

        try {
          const data = (await client.addConversation(
            extractSession(context),
            pairs.map((p) => ({ role: p.role, content: p.content }))
          )) as { total_count?: number } | null;
          const accepted = typeof data?.total_count === "number" ? data.total_count : pairs.length;
          if (accepted !== pairs.length) {
            return `capture failed: server accepted ${accepted} of ${pairs.length} turn(s)`;
          }
          const { teamId, agentId } = client.scope();
          return `Captured ${accepted} turn(s) to AgentMemory L0 for ${teamId}/${agentId}.`;
        } catch (err) {
          return `capture failed: ${String(err)}`;
        }
      },
    }),

    agentmemory_conversations: makeTool({
      description:
        "List stored memory conversations for the configured team + agent. Returns session ids and message counts.",
      args: {
        query: makeTool.schema.string().describe("optional substring to filter session ids").optional(),
        limit: makeTool.schema.number().describe("max results (default 20)").default(20).optional(),
      },
      async execute(args) {
        try {
          const data = await client.listConversations(args.query, args.limit ?? 20);
          if (data.sessions.length === 0) {
            return "No conversations found.";
          }
          const { teamId, agentId } = client.scope();
          const scanned =
            data.scannedMessages < data.totalMessages
              ? ` (scanned the latest ${data.scannedMessages} of ${data.totalMessages} L0 messages)`
              : "";
          return [
            `Found ${data.sessions.length} conversation(s) for ${teamId}/${agentId}${scanned}:`,
            ...data.sessions.map((s) => `${s.id} (${s.count} messages)`),
          ].join("\n");
        } catch (err) {
          return `list failed: ${String(err)}`;
        }
      },
    }),

    agentmemory_stats: makeTool({
      description:
        "Get AgentMemory layer sizes for the configured team + agent (L0-L3 and skills). Generation logs are instance-wide.",
      args: {},
      async execute() {
        let scoped;
        try {
          scoped = await client.scopedStats();
        } catch (err) {
          return `stats failed: ${String(err)}`;
        }

        let generationLogs: number | null = null;
        let generationLogsError: string | null = null;
        try {
          const overview = await client.statsOverview();
          generationLogs =
            typeof overview.generation_logs === "number" ? overview.generation_logs : null;
        } catch (err) {
          generationLogsError = String(err);
        }

        const { teamId, agentId } = client.scope();
        const lines = [
          `Scope: ${teamId}/${agentId}`,
          `L0: ${scoped.l0.toLocaleString()}`,
          `L1: ${scoped.l1.toLocaleString()}`,
          `L2: ${scoped.l2.toLocaleString()}`,
          `L3: ${scoped.l3.toLocaleString()}`,
          `Skills: ${scoped.skills.toLocaleString()}`,
        ];
        if (generationLogs !== null) {
          lines.push(`Gen logs (instance-wide): ${generationLogs.toLocaleString()}`);
        } else if (generationLogsError !== null) {
          lines.push(`Gen logs: unavailable (${generationLogsError})`);
        }
        return lines.join("\n");
      },
    }),
  };
}

function buildContentText(args: { content?: string; toolCalls?: Array<{ name: string; arguments: string; id: string }>; toolResults?: Array<{ name: string; result: string; id: string }> }): string {
  const parts: string[] = [];
  if (args.content) parts.push(args.content);
  if (args.toolCalls && args.toolCalls.length) {
    parts.push("--- tool calls ---");
    for (const t of args.toolCalls) parts.push(`${t.name}: ${t.arguments}`);
  }
  if (args.toolResults && args.toolResults.length) {
    parts.push("--- tool results ---");
    for (const r of args.toolResults) parts.push(`${r.name}: ${r.result}`);
  }
  return parts.join("\n");
}

function extractSession(context: { sessionID?: string }): string {
  return context.sessionID ?? "";
}
