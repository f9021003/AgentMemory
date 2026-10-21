import type { PluginOptions } from "@opencode-ai/plugin";

export interface AgentMemoryOptions {
  /** AgentMemory server base URL. Default http://localhost:8420 */
  baseUrl?: string;
  /** Personal user key (sk-mem-...). Authenticates the user-scoped data plane. */
  userKey?: string | null;
  /** Service instance id. Default "default". */
  serviceId?: string;
  /** Team id for the memory context. Required. */
  teamId?: string | null;
  /** Agent id for the memory context. Required. */
  agentId?: string | null;
}

export interface AgentMemoryConfig extends AgentMemoryOptions {
  baseUrl: string;
  userKey: string | null;
  serviceId: string;
  teamId: string;
  agentId: string;
  apiKey: string | null;
}

export interface ConversationMessage {
  id: string;
  role: string;
  content: string;
  session_id: string;
  timestamp: string;
  recorded_at: string;
  team_id: string;
  agent_id: string;
}

export interface ConversationList {
  sessions: Array<{ id: string; count: number }>;
  totalMessages: number;
  scannedMessages: number;
}

export interface ScopedStats {
  l0: number;
  l1: number;
  l2: number;
  l3: number;
  skills: number;
}

export interface StatsOverview {
  l0?: number;
  l1?: { total: number; episodic: number; persona?: number; instruction?: number };
  l2?: number;
  l3?: number;
  skills?: number;
  generation_logs?: number;
}

interface Envelope {
  code?: number;
  message?: string;
  data?: unknown;
}

function unwrap(path: string, data: unknown): unknown {
  if (!data || typeof data !== "object") {
    return data;
  }
  const envelope = data as Envelope;
  if (typeof envelope.code === "number") {
    if (envelope.code !== 0) {
      throw new Error(
        `API code ${envelope.code} on ${path}: ${envelope.message ?? "unknown error"}`
      );
    }
    return envelope.data;
  }
  return data;
}

function numberField(path: string, data: unknown, field: string): number {
  if (!data || typeof data !== "object") {
    throw new Error(`unexpected response from ${path}: not an object`);
  }
  const value = (data as Record<string, unknown>)[field];
  if (typeof value !== "number") {
    throw new Error(`unexpected response from ${path}: missing numeric "${field}"`);
  }
  return value;
}

export function buildClient(config: AgentMemoryConfig) {
  const baseUrl = config.baseUrl.endsWith("/") ? config.baseUrl : config.baseUrl + "/";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-memory-service-id": config.serviceId,
  };
  if (config.userKey) {
    headers["x-memory-user-key"] = config.userKey;
  }
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const scope = () => ({ team_id: config.teamId, agent_id: config.agentId });

  async function request(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(baseUrl + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!res.ok) {
      const message =
        data && typeof data === "object" && "message" in data
          ? String((data as { message: string }).message)
          : text || `HTTP ${res.status}`;
      throw new Error(`HTTP ${res.status} on ${path}: ${message}`);
    }
    return unwrap(path, data);
  }

  async function total(path: string, extra: Record<string, unknown> = {}): Promise<number> {
    return numberField(path, await request(path, { ...scope(), ...extra }), "total");
  }

  async function conversationCount(sessionId?: string): Promise<number> {
    return total("v3/conversation/count", sessionId ? { session_id: sessionId } : {});
  }

  return {
    /** The team/agent this client is bound to. */
    scope(): { teamId: string; agentId: string } {
      return { teamId: config.teamId, agentId: config.agentId };
    },

    /** Recall long-term memory. Body: { query, max_results?, strategy?, team_id, agent_id } */
    async recall(query: string, maxResults = 8, strategy?: string) {
      return request("v3/recall", {
        query,
        max_results: maxResults,
        strategy,
        ...scope(),
      });
    },

    /** Add L0 conversation turns for the configured team/agent. */
    async addConversation(
      sessionId: string,
      messages: Array<{ role: string; content: string }>
    ) {
      return request("v3/conversation/add", {
        ...scope(),
        session_id: sessionId,
        messages,
      });
    },

    /** Store a session turn with user_id for the configured team/agent. */
    async addSession(
      userId: string,
      sessionId: string,
      messages: Array<{ role: string; content: string }>
    ) {
      return request("v3/session/add", {
        user_id: userId,
        ...scope(),
        session_id: sessionId,
        messages,
      });
    },

    /** Scoped L0 count. Body: { team_id, agent_id, session_id? } */
    conversationCount,

    /**
     * Scoped layer counts.
     *
     * v3/stats/overview is instance-wide, so the individual layer counts are
     * read from the scoped endpoints instead. L1 is per user (resolved by the
     * server to the user key), L2/L3 are per team + agent.
     */
    async scopedStats(): Promise<ScopedStats> {
      const [l0, l1, l2, l3, skills] = await Promise.all([
        total("v3/conversation/count"),
        total("v3/atomic/count"),
        total("v3/scenario/count"),
        total("v3/core/count"),
        total("v3/skill/list", {
          filters: { owner_agent_id: config.agentId },
          pagination: { limit: 1 },
        }),
      ]);
      return { l0, l1, l2, l3, skills };
    },

    /** Instance-wide layer counts (Bearer-scoped endpoint). */
    async statsOverview(): Promise<StatsOverview> {
      const data = await request("v3/stats/overview", scope());
      if (!data || typeof data !== "object") {
        throw new Error("unexpected response from v3/stats/overview");
      }
      return data as StatsOverview;
    },

    /**
     * List conversations visible in the current scope.
     *
     * The server has no session-listing endpoint, so this reads recent L0
     * messages through v3/conversation/query, groups them by session_id, and
     * asks v3/conversation/count for each session's exact message count.
     */
    async listConversations(query?: string, limit = 20): Promise<ConversationList> {
      const wanted = Math.max(1, limit);
      const ids: string[] = [];
      const seen = new Set<string>();
      let totalMessages = 0;
      let scannedMessages = 0;
      let offset = 0;

      for (let page = 0; page < 10; page += 1) {
        const data = await request("v3/conversation/query", {
          ...scope(),
          limit: 100,
          offset,
        });
        if (!data || typeof data !== "object") {
          throw new Error("unexpected response from v3/conversation/query");
        }
        const d = data as { messages?: ConversationMessage[]; total?: number };
        const messages = d.messages ?? [];
        totalMessages = typeof d.total === "number" ? d.total : totalMessages;
        scannedMessages += messages.length;
        for (const message of messages) {
          const id = message.session_id;
          if (!id || seen.has(id)) continue;
          if (query && !id.toLowerCase().includes(query.toLowerCase())) continue;
          seen.add(id);
          ids.push(id);
        }
        offset += messages.length;
        if (messages.length === 0 || ids.length >= wanted || offset >= totalMessages) {
          break;
        }
      }

      const selected = ids.slice(0, wanted);
      const sessions = await Promise.all(
        selected.map(async (id) => ({ id, count: await conversationCount(id) }))
      );
      return { sessions, totalMessages, scannedMessages };
    },
  };
}
