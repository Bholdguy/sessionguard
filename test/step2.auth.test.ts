import { afterEach, describe, expect, it } from "vitest";
import { AuthError, createUpstreamClient } from "../src/mcp/upstreamClient.js";
import { startMockUpstream } from "./mockUpstream.js";

describe("Step 2 — auth scaffold (D-4)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c().catch(() => undefined);
  });

  it("refuses a non-HTTPS upstream in production mode", () => {
    expect(() =>
      createUpstreamClient({ url: "http://example.com/mcp", nodeEnv: "production" }),
    ).toThrow(/refusing non-HTTPS/);
  });

  it("allows loopback http only in test|demo mode", () => {
    expect(() =>
      createUpstreamClient({ url: "http://127.0.0.1:9/mcp", nodeEnv: "test" }),
    ).not.toThrow();
  });

  it("attaches the bearer token (gate accepts the matching token)", async () => {
    const mock = await startMockUpstream({ requireBearer: "good-token" });
    cleanups.push(mock.close);

    const client = createUpstreamClient({
      url: mock.url,
      bearerToken: "good-token",
      nodeEnv: "test",
    });
    cleanups.push(client.close);
    await client.connect();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("spot_new_order");
  });

  it("a 401 surfaces as AuthError — never a silent stale success or a hang", async () => {
    const mock = await startMockUpstream({ requireBearer: "good-token" });
    cleanups.push(mock.close);

    const client = createUpstreamClient({
      url: mock.url,
      bearerToken: "WRONG",
      nodeEnv: "test",
    });
    cleanups.push(client.close);

    await expect(client.connect()).rejects.toBeInstanceOf(AuthError);
  });

  it("single-shot refresh is attempted once, then fails closed if still rejected", async () => {
    const mock = await startMockUpstream({ requireBearer: "good-token" });
    cleanups.push(mock.close);

    let refreshCalls = 0;
    const client = createUpstreamClient({
      url: mock.url,
      bearerToken: "WRONG",
      nodeEnv: "test",
      refresh: async () => {
        refreshCalls++;
        return "STILL-WRONG";
      },
    });
    cleanups.push(client.close);

    await expect(client.connect()).rejects.toBeInstanceOf(AuthError);
    expect(refreshCalls).toBe(1); // exactly once, no loop
  });

  it("refresh that returns a valid token recovers the call", async () => {
    const mock = await startMockUpstream({ requireBearer: "good-token" });
    cleanups.push(mock.close);

    const client = createUpstreamClient({
      url: mock.url,
      bearerToken: "WRONG",
      nodeEnv: "test",
      refresh: async () => "good-token",
    });
    cleanups.push(client.close);

    await client.connect();
    const tools = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });
});
