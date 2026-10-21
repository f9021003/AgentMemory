import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";
import type { Event, EventSessionIdle } from "@opencode-ai/sdk";
import { createTools } from "./tools.ts";
import { makeSessionIdleHook, type SessionMessage, type Logger } from "./hooks.ts";
import { buildClient } from "./client.ts";
import { resolveConfig } from "./config.ts";


/**
 * The OpenCode plugin entry.
 *
 * Registers the memory tools and the session-idle capture hook.
 * All calls go directly to the AgentMemory core HTTP API (port 8420),
 * no external binary required.
 */
export default async (input: PluginInput, options: PluginOptions = {}) => {
  const config = resolveConfig(options);
  const client = buildClient(config);

  console.info(
    `[agentmemory] config loaded baseUrl=${config.baseUrl} serviceId=${config.serviceId} ` +
      `teamId=${config.teamId} agentId=${config.agentId} ` +
      `userKey=${config.userKey ? "set" : "unset"} apiKey=${config.apiKey ? "set" : "unset"}`
  );

  const logger: Logger = {
    info: (msg, ...args) => console.log(`[agentmemory] INFO ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[agentmemory] ERROR ${msg}`, ...args),
  };

  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/health`, { method: "GET" });
    if (res.ok) {
      console.info(`[agentmemory] connected to ${config.baseUrl}`);
    } else {
      console.warn(`[agentmemory] health check HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[agentmemory] health check failed: ${String(err)}`);
  }

  return {
    tool: createTools(client),
    event: async (evtInput: { event: Event }) => {
      const ev = evtInput.event as EventSessionIdle;
      if (ev.type !== "session.idle") {
        return;
      }
      const sessionID = ev.properties.sessionID;
      if (!sessionID) {
        return;
      }

      try {
        const { data } = await input.client.session.messages({ path: { id: sessionID } });
        const msgs = Array.isArray(data) ? (data as SessionMessage[]) : [];
        if (msgs.length === 0) {
          logger.info("session idle, no messages to capture");
          return;
        }
        await makeSessionIdleHook(client, logger)(msgs);
      } catch (err) {
        logger.error("capture error: %s", String(err));
      }
    },
  };
};
