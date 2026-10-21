import type { PluginOptions } from "@opencode-ai/plugin";
import type { AgentMemoryConfig } from "./client";

export const DEFAULT_BASE_URL = "http://localhost:8420";
export const DEFAULT_SERVICE_ID = "default";

export class AgentMemoryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentMemoryConfigError";
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolve and validate the plugin options.
 *
 * teamId, agentId and userKey are required: the server no longer supports a
 * `default` team/agent, and silently falling back would send writes to the
 * wrong scope (or fail with HTTP 403).
 */
export function resolveConfig(options: PluginOptions | null | undefined): AgentMemoryConfig {
  const o = (options && typeof options === "object" ? options : {}) as Record<string, unknown>;
  const teamId = nonEmpty(o.teamId);
  const agentId = nonEmpty(o.agentId);
  const userKey = nonEmpty(o.userKey);

  if (!teamId || !agentId || !userKey) {
    const missing: string[] = [];
    if (!teamId) missing.push("teamId");
    if (!agentId) missing.push("agentId");
    if (!userKey) missing.push("userKey");
    throw new AgentMemoryConfigError(
      `missing required AgentMemory config: ${missing.join(", ")}`
    );
  }

  return {
    baseUrl: nonEmpty(o.baseUrl) ?? DEFAULT_BASE_URL,
    userKey,
    serviceId: nonEmpty(o.serviceId) ?? DEFAULT_SERVICE_ID,
    teamId,
    agentId,
    apiKey: nonEmpty(o.apiKey),
  };
}
