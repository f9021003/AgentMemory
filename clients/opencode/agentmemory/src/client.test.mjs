import { afterEach, expect, test } from "bun:test";
import { buildClient } from "./client.ts";

const config = {
  baseUrl: "http://memory.test:8420",
  userKey: "sk-mem-test",
  serviceId: "prod",
  teamId: "team-123",
  agentId: "agt-456",
  apiKey: "admin-key",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), init, body });
    const result = await handler(new URL(String(url)), body, init);
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return calls;
}

test("recall uses the configured scope and unwraps the response envelope", async () => {
  const calls = mockFetch((url) => {
    expect(url.pathname).toBe("/v3/recall");
    return {
      body: {
        code: 0,
        data: { strategy: "bm25", memories: [{ id: "m1", type: "episodic", content: "hello", score: 1 }] },
      },
    };
  });

  const client = buildClient(config);
  const result = await client.recall("hello");

  expect(result.memories[0].content).toBe("hello");
  expect(calls[0].body).toEqual({
    query: "hello",
    max_results: 8,
    team_id: "team-123",
    agent_id: "agt-456",
  });
  expect(calls[0].init.headers["x-memory-user-key"]).toBe("sk-mem-test");
  expect(calls[0].init.headers["x-memory-service-id"]).toBe("prod");
  expect(calls[0].init.headers.Authorization).toBe("Bearer admin-key");
});

test("addConversation writes to the configured scope and returns the accepted count", async () => {
  const calls = mockFetch((url) => {
    expect(url.pathname).toBe("/v3/conversation/add");
    return { body: { code: 0, data: { total_count: 1, accepted_ids: ["c1"] } } };
  });

  const client = buildClient(config);
  const result = await client.addConversation("s1", [{ role: "user", content: "AMEM-VERIFY" }]);

  expect(result.total_count).toBe(1);
  expect(calls[0].body).toEqual({
    team_id: "team-123",
    agent_id: "agt-456",
    session_id: "s1",
    messages: [{ role: "user", content: "AMEM-VERIFY" }],
  });
  expect(JSON.stringify(calls[0].body)).not.toContain("default");
});

test("a non-zero envelope code is an error even when HTTP is 200", async () => {
  mockFetch(() => ({ body: { code: 7, message: "permission_denied: nope" } }));
  const client = buildClient(config);

  await expect(client.recall("x")).rejects.toThrow(
    "API code 7 on v3/recall: permission_denied: nope"
  );
});

test("an HTTP error includes the path and server message", async () => {
  mockFetch(() => ({
    status: 403,
    body: { code: 403, message: "permission_denied: agent does not belong to the team" },
  }));
  const client = buildClient(config);

  await expect(
    client.addConversation("s1", [{ role: "user", content: "x" }])
  ).rejects.toThrow(
    "HTTP 403 on v3/conversation/add: permission_denied: agent does not belong to the team"
  );
});

test("listConversations groups scoped messages instead of calling the missing session/ls route", async () => {
  const calls = mockFetch((url, body) => {
    if (url.pathname === "/v3/conversation/query") {
      return {
        body: {
          code: 0,
          data: {
            total: 2,
            messages: [
              { session_id: "s1", role: "user", content: "a" },
              { session_id: "s2", role: "user", content: "b" },
            ],
          },
        },
      };
    }
    if (url.pathname === "/v3/conversation/count") {
      return { body: { code: 0, data: { total: body.session_id === "s1" ? 3 : 1 } } };
    }
    throw new Error(`unexpected path ${url.pathname}`);
  });

  const client = buildClient(config);
  const result = await client.listConversations("", 20);

  expect(result.sessions).toEqual([
    { id: "s1", count: 3 },
    { id: "s2", count: 1 },
  ]);
  expect(calls.some((c) => c.url.includes("/v3/session/ls"))).toBe(false);
  expect(calls[0].body).toMatchObject({ team_id: "team-123", agent_id: "agt-456" });
});

test("scopedStats reads scoped layer counts", async () => {
  mockFetch((url) => {
    const totals = {
      "/v3/conversation/count": 11,
      "/v3/atomic/count": 7,
      "/v3/scenario/count": 3,
      "/v3/core/count": 2,
      "/v3/skill/list": 5,
    };
    return { body: { code: 0, data: { total: totals[url.pathname] } } };
  });

  const client = buildClient(config);
  expect(await client.scopedStats()).toEqual({ l0: 11, l1: 7, l2: 3, l3: 2, skills: 5 });
});
