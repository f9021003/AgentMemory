import { test, expect } from "bun:test";
import { AgentMemoryConfigError, resolveConfig } from "./config.ts";

test("resolves the configured team, agent and auth without defaults", () => {
  const config = resolveConfig({
    baseUrl: "http://memory.example:8420/",
    userKey: "sk-mem-test",
    serviceId: "prod",
    teamId: "team-123",
    agentId: "agt-456",
    apiKey: "admin-key",
  });

  expect(config).toEqual({
    baseUrl: "http://memory.example:8420/",
    userKey: "sk-mem-test",
    serviceId: "prod",
    teamId: "team-123",
    agentId: "agt-456",
    apiKey: "admin-key",
  });
});

test("applies only the non-scope defaults", () => {
  const config = resolveConfig({
    userKey: "sk-mem-test",
    teamId: "team-123",
    agentId: "agt-456",
  });

  expect(config.baseUrl).toBe("http://localhost:8420");
  expect(config.serviceId).toBe("default");
  expect(config.apiKey).toBeNull();
});

test("reports every missing required field instead of falling back to default", () => {
  expect(() => resolveConfig({ baseUrl: "http://localhost:8420" })).toThrow(
    AgentMemoryConfigError
  );
  expect(() => resolveConfig({ baseUrl: "http://localhost:8420" })).toThrow(
    /missing required AgentMemory config: teamId, agentId, userKey/
  );
});

test("treats blank values as missing", () => {
  expect(() => resolveConfig({ userKey: "sk-mem-test", teamId: "  ", agentId: "\t" })).toThrow(
    /teamId, agentId/
  );
});
