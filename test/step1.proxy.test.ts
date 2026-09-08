import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMockUpstream } from "./mockUpstream.js";
import { createUpstreamClient } from "../src/mcp/upstreamClient.js";
import { resolveOrExit, resolveToolCatalog } from "../src/mcp/toolCatalog.js";
import { createInboundServer } from "../src/mcp/inboundServer.js";
import { mountMcpServer } from "../src/mcp/httpServer.js";
import { forward } from "../src/mcp/passthrough.js";

describe("Step 1 — MCP proxy skeleton", () => {
  let mock: Awaited<ReturnType<typeof startMockUpstream>>;
  let inbound: Awaited<ReturnType<typeof mountMcpServer>>;
  let agent: Client;

  beforeAll(async () => {
    mock = await startMockUpstream();

    const upstream = createUpstreamClient({ url: mock.url, nodeEnv: "test" });
    await upstream.connect();

    const logs: string[] = [];
    const catalog = await resolveOrExit(upstream, {
      timeoutMs: 5000,
      upstreamLabel: mock.url,
      exit: ((c: number) => {
        throw new Error(`unexpected exit(${c})`);
      }) as (c: number) => never,
      log: (l) => logs.push(l),
    });
    (globalThis as Record<string, unknown>).__catalog = catalog;
    (globalThis as Record<string, unknown>).__logs = logs;

    const makeServer = () =>
      createInboundServer({
        catalog,
        onToolCall: async ({ upstreamToolName, args }) => ({
          result: await forward(upstream, upstreamToolName, args),
        }),
      });
    inbound = await mountMcpServer({ createServer: makeServer, port: 0 });

    agent = new Client({ name: "test-agent", version: "0.0.1" }, { capabilities: {} });
    await agent.connect(new StreamableHTTPClientTransport(new URL(inbound.url)));
  });

  afterAll(async () => {
    await agent?.close().catch(() => undefined);
    await inbound?.close();
    await mock?.close();
  });

  it("resolves all required logical capabilities from a non-Binance-named surface (D-1)", () => {
    const catalog = (globalThis as Record<string, unknown>).__catalog as ReturnType<
      typeof resolveToolCatalog
    >["catalog"];
    expect(catalog.map["market.price"]).toBe("spot_get_price");
    expect(catalog.map["account.balances"]).toBe("spot_account_info");
    expect(catalog.map["trade.placeOrder"]).toBe("spot_new_order");
    expect(catalog.map["trade.queryOrder"]).toBe("spot_query_order");
  });

  it("excludes withdraw and futures tools from the catalog (SECURITY §5)", () => {
    const catalog = (globalThis as Record<string, unknown>).__catalog as ReturnType<
      typeof resolveToolCatalog
    >["catalog"];
    const excludedNames = catalog.excluded.map((e) => e.name);
    expect(excludedNames).toContain("wallet_withdraw");
    expect(excludedNames).toContain("futures_new_order");
    expect(Object.values(catalog.map)).not.toContain("wallet_withdraw");
  });

  it("mirrors the upstream tool set outward, minus excluded tools (DoD)", async () => {
    const tools = (await agent.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("spot_new_order");
    expect(tools).toContain("spot_get_price");
    expect(tools).not.toContain("wallet_withdraw");
    expect(tools).not.toContain("futures_new_order");
  });

  it("forwards a trade byte-for-byte and returns the upstream response unmodified (INV-9)", async () => {
    const args = { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: "0.01" };
    const res = (await agent.callTool({ name: "spot_new_order", arguments: args })) as {
      content: Array<{ text: string }>;
    };

    // mock received exactly what the agent sent
    const received = mock.calls.find((c) => c.tool === "spot_new_order");
    expect(received?.args).toEqual(args);

    // agent got the upstream payload unmodified
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.symbol).toBe("BTCUSDT");
    expect(payload.status).toBe("FILLED");
    expect(payload.fills[0].price).toBe("60000.00");
  });

  it("refuses a direct call to an excluded tool with UNSUPPORTED_TOOL", async () => {
    const res = (await agent.callTool({ name: "wallet_withdraw", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).refusal).toBe("UNSUPPORTED_TOOL");
    expect(mock.calls.some((c) => c.tool === "wallet_withdraw")).toBe(false);
  });
});

describe("Step 1 — boot fails closed (INV-12 / D-1)", () => {
  it("resolveToolCatalog reports a missing REQUIRED capability", () => {
    const { missingRequired } = resolveToolCatalog([
      { name: "spot_get_price", description: "price", inputSchema: {} },
      { name: "spot_account_info", description: "balances", inputSchema: {} },
      // no place-order tool
    ]);
    expect(missingRequired).toContain("trade.placeOrder");
  });

  it("resolveOrExit calls exit(1) exactly once on an unresolved required capability", async () => {
    const fakeClient = {
      connect: async () => undefined,
      listTools: async () => [
        { name: "spot_get_price", description: "price", inputSchema: {} },
        { name: "spot_account_info", description: "balances", inputSchema: {} },
      ],
      callTool: async () => ({}),
      close: async () => undefined,
    };
    let exitCode: number | undefined;
    const logs: string[] = [];
    await resolveOrExit(fakeClient, {
      timeoutMs: 5000,
      upstreamLabel: "fake",
      exit: ((c: number) => {
        exitCode = c;
        throw new Error("exit");
      }) as (c: number) => never,
      log: (l) => logs.push(l),
    }).catch(() => undefined);
    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.includes("trade.placeOrder") && l.includes("Exiting"))).toBe(true);
  });

  it("resolveOrExit calls exit(1) on tools/list timeout", async () => {
    const hang = {
      connect: async () => undefined,
      listTools: () => new Promise<never>(() => {}),
      callTool: async () => ({}),
      close: async () => undefined,
    };
    let exitCode: number | undefined;
    const logs: string[] = [];
    await resolveOrExit(hang, {
      timeoutMs: 50,
      upstreamLabel: "hang",
      exit: ((c: number) => {
        exitCode = c;
        throw new Error("exit");
      }) as (c: number) => never,
      log: (l) => logs.push(l),
    }).catch(() => undefined);
    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.includes("timed out after 50ms"))).toBe(true);
  });
});

describe("Step 1 — inbound server accepts multiple sequential sessions (regression)", () => {
  let mock: Awaited<ReturnType<typeof startMockUpstream>>;
  let inbound: Awaited<ReturnType<typeof mountMcpServer>>;

  beforeAll(async () => {
    mock = await startMockUpstream();
    const upstream = createUpstreamClient({ url: mock.url, nodeEnv: "test" });
    await upstream.connect();
    const catalog = await resolveOrExit(upstream, {
      timeoutMs: 5000,
      upstreamLabel: mock.url,
      exit: ((c: number) => {
        throw new Error(`unexpected exit(${c})`);
      }) as (c: number) => never,
      log: () => undefined,
    });
    inbound = await mountMcpServer({
      createServer: () =>
        createInboundServer({
          catalog,
          onToolCall: async ({ upstreamToolName, args }) => ({
            result: await forward(upstream, upstreamToolName, args),
          }),
        }),
      port: 0,
    });
  });

  afterAll(async () => {
    await inbound?.close();
    await mock?.close();
  });

  it("a second client can initialize after the first — no 'Already connected to a transport' crash", async () => {
    const connectOnce = async (name: string) => {
      const client = new Client({ name, version: "0.0.1" }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(inbound.url)));
      const tools = (await client.listTools()).tools.map((t) => t.name);
      await client.close().catch(() => undefined);
      return tools;
    };

    const first = await connectOnce("agent-1");
    expect(first).toContain("spot_new_order");

    // before the fix this rejected with "Already connected to a transport"
    const second = await connectOnce("agent-2");
    expect(second).toContain("spot_new_order");
  });
});
