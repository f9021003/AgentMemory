import { expect, test } from "bun:test";
import { buildConversationPayload, makeSessionIdleHook } from "./hooks.ts";

const messages = [
  {
    info: { id: "m1", role: "user" },
    parts: [{ type: "text", text: "hello" }],
  },
  {
    info: { id: "m2", role: "assistant" },
    parts: [
      { type: "text", text: "checking" },
      { type: "toolCall", toolCall: { id: "t1", name: "bash", input: { command: "ls" } } },
    ],
  },
];

test("the idle hook captures through the shared client", async () => {
  const captured = [];
  const logs = [];
  const client = {
    async addConversation(sessionId, payload) {
      captured.push({ sessionId, payload });
      return { total_count: payload.length };
    },
  };
  const logger = { info: (...args) => logs.push(args), error: (...args) => logs.push(args) };

  await makeSessionIdleHook(client, logger)(messages);

  expect(captured).toHaveLength(1);
  expect(captured[0].sessionId.startsWith("auto:")).toBe(true);
  expect(captured[0].payload).toEqual(buildConversationPayload(messages));
  expect(logs[0][0]).toContain("captured");
});

test("the idle hook logs a capture failure and does not throw", async () => {
  const errors = [];
  const client = {
    async addConversation() {
      throw new Error(
        "HTTP 403 on v3/conversation/add: permission_denied: agent does not belong to the team"
      );
    },
  };
  const logger = { info: () => {}, error: (...args) => errors.push(args) };

  await makeSessionIdleHook(client, logger)(messages);

  expect(errors).toHaveLength(1);
  expect(String(errors[0][1])).toContain("HTTP 403");
});

test("the idle hook treats a partial acceptance as a failure", async () => {
  const errors = [];
  const client = {
    async addConversation(_sessionId, payload) {
      return { total_count: payload.length - 1 };
    },
  };
  const logger = { info: () => {}, error: (...args) => errors.push(args) };

  await makeSessionIdleHook(client, logger)(messages);

  expect(errors).toHaveLength(1);
  expect(String(errors[0][0])).toContain("accepted");
});
