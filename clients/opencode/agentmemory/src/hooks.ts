export interface SessionMessage {
  info: { id: string; role: string };
  parts: Array<{
    type: string;
    text?: string;
    toolCall?: { id: string; name: string; input: object };
    toolResult?: { toolCallId: string; content: string; isError?: boolean };
  }>;
}

export interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export interface CaptureClient {
  addConversation(
    sessionId: string,
    messages: Array<{ role: string; content: string }>
  ): Promise<unknown>;
}

/**
 * Fold a session's messages into a flat list of role/content pairs.
 *
 * Tool calls and their results are unfolded into assistant/user pairs so
 * the L0 layer mirrors the actual conversation flow (including tool use).
 */
export function buildConversationPayload(messages: SessionMessage[]): { role: "user" | "assistant"; content: string }[] {
  const pairs: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const msg of messages) {
    const role = msg.info.role === "assistant" ? "assistant" : "user";
    const textParts = msg.parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text ?? "")
      .join("\n");
    if (textParts) {
      pairs.push({ role, content: textParts });
    }
    if (msg.parts.some((p) => p.type === "toolCall" || p.type === "toolResult")) {
      const toolCalls = msg.parts.filter((p) => p.type === "toolCall");
      for (const tc of toolCalls) {
        const input = tc.toolCall?.input ?? {};
        const args = typeof input === "string" ? input : JSON.stringify(input);
        pairs.push({ role: "assistant", content: `${tc.toolCall?.name ?? "tool"}(${args})` });
      }
      const toolResults = msg.parts.filter((p) => p.type === "toolResult");
      for (const tr of toolResults) {
        const content = tr.toolResult?.content ?? "";
        pairs.push({ role: "user", content: `[tool result] ${content}` });
      }
    }
  }
  return pairs;
}

/**
 * Build an async hook that captures a session to AgentMemory L0 when
 * the session becomes idle. Uses the same captured client (and therefore the
 * same team/agent/auth headers) as the manual tools.
 */
export function makeSessionIdleHook(
  client: CaptureClient,
  logger: Logger
): (messages: SessionMessage[]) => Promise<void> {
  return async (messages: SessionMessage[]) => {
    const payload = buildConversationPayload(messages);
    if (payload.length === 0) {
      logger.info("agentmemory: session idle, nothing to capture");
      return;
    }
    try {
      const data = (await client.addConversation(`auto:${Date.now()}`, payload)) as
        | { total_count?: number }
        | null;
      const accepted = typeof data?.total_count === "number" ? data.total_count : payload.length;
      if (accepted !== payload.length) {
        logger.error(
          "agentmemory: capture accepted %d of %d turn(s)",
          accepted,
          payload.length
        );
        return;
      }
      logger.info("agentmemory: captured %d turn(s) to L0", accepted);
    } catch (err) {
      logger.error("agentmemory: capture error: %s", String(err));
    }
  };
}
