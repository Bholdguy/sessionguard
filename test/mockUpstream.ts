/**
 * MockUpstream — an MCP server implementing the same *kind* of tool surface as
 * Binance Agent OS, with deterministic scripted responses (D-0, D-7).
 *
 * Concrete tool names deliberately differ from any guessed Binance names so the
 * ToolCatalog discovery (D-1) is genuinely exercised. Includes a withdraw and a
 * futures tool that MUST be excluded from the resolved catalog (SECURITY §5).
 */
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Decimal } from "../src/domain/decimal.js";
import { mountMcpServer } from "../src/mcp/httpServer.js";

export interface MockCall {
  tool: string;
  args: Record<string, unknown>;
  at: string;
}

export interface MockScript {
  priceBySymbol: Record<string, string>;
  equityUsdt: string;
  balances: Record<string, string>;
  commissionRate: string; // fraction, e.g. "0.001"
  /** FIFO queue of per-placeOrder overrides: fill price, or an error. */
  placeOrderQueue: Array<{ fillPrice?: string; status?: string; error?: string }>;
  /** force the next read of this logical kind to fail / be stale */
  failNextRead?: { kind: "price" | "account"; mode: "error" | "stale" };
  /** override the klines close per symbol (to test the price sanity clamp) */
  klinesCloseBySymbol?: Record<string, string>;
}

const DEFAULT_SCRIPT: MockScript = {
  priceBySymbol: { BTCUSDT: "60000.00", ETHUSDT: "3000.00", BNBUSDT: "600.00" },
  equityUsdt: "1000.00",
  balances: { USDT: "1000.00", BTC: "0", ETH: "0", BNB: "0" },
  commissionRate: "0.001",
  placeOrderQueue: [],
};

const TOOLS = [
  { name: "spot_get_price", description: "Latest price for a symbol", inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } },
  { name: "spot_get_klines", description: "Recent candlesticks (klines) for a symbol", inputSchema: { type: "object", properties: { symbol: { type: "string" }, interval: { type: "string" }, limit: { type: "number" } }, required: ["symbol"] } },
  { name: "spot_account_info", description: "Agentic sub-account balances", inputSchema: { type: "object", properties: {} } },
  { name: "spot_my_trades", description: "Account trade execution history", inputSchema: { type: "object", properties: { symbol: { type: "string" } } } },
  { name: "spot_new_order", description: "Place a new spot order", inputSchema: { type: "object", properties: { symbol: { type: "string" }, side: { type: "string" }, type: { type: "string" }, quantity: { type: "string" }, price: { type: "string" } }, required: ["symbol", "side", "type"] } },
  { name: "spot_test_order", description: "Validate a spot order without placing it (dry run)", inputSchema: { type: "object", properties: { symbol: { type: "string" } } } },
  { name: "spot_query_order", description: "Query the status of an existing order", inputSchema: { type: "object", properties: { symbol: { type: "string" }, orderId: { type: "string" } } } },
  { name: "spot_open_orders", description: "Current open orders", inputSchema: { type: "object", properties: { symbol: { type: "string" } } } },
  // — MUST be excluded from the resolved catalog —
  { name: "wallet_withdraw", description: "Withdraw crypto to an external address", inputSchema: { type: "object", properties: {} } },
  { name: "futures_new_order", description: "Place a USDⓈ-M futures order", inputSchema: { type: "object", properties: {} } },
];

function textResult(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export async function startMockUpstream(opts: {
  port?: number;
  logFile?: string;
  requireBearer?: string;
} = {}): Promise<{
  url: string;
  port: number;
  calls: MockCall[];
  script: MockScript;
  setScript: (s: Partial<MockScript>) => void;
  reset: () => void;
  close: () => Promise<void>;
}> {
  const calls: MockCall[] = [];
  let script: MockScript = structuredClone(DEFAULT_SCRIPT);
  let orderSeq = 1000;

  const server = new Server({ name: "mock-binance-agentos", version: "0.0.1" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as never }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const call: MockCall = { tool, args, at: new Date().toISOString() };
    calls.push(call);
    if (opts.logFile) appendFileSync(opts.logFile, JSON.stringify(call) + "\n");

    switch (tool) {
      case "spot_get_price": {
        if (script.failNextRead?.kind === "price") {
          const mode = script.failNextRead.mode;
          delete script.failNextRead;
          if (mode === "error") throw new Error("mock: price feed unavailable");
          // stale: return a timestamp 32s in the past
          const sym = String(args["symbol"] ?? "");
          return textResult({ symbol: sym, price: script.priceBySymbol[sym] ?? "0", time: Date.now() - 32_000 });
        }
        const sym = String(args["symbol"] ?? "");
        const price = script.priceBySymbol[sym];
        if (!price) throw new Error(`mock: no price scripted for ${sym}`);
        return textResult({ symbol: sym, price, time: Date.now() });
      }
      case "spot_get_klines": {
        const sym = String(args["symbol"] ?? "");
        const close = script.klinesCloseBySymbol?.[sym] ?? script.priceBySymbol[sym] ?? "0";
        return textResult([[Date.now() - 60_000, close, close, close, close, "1.0", Date.now()]]);
      }
      case "spot_account_info": {
        if (script.failNextRead?.kind === "account") {
          const mode = script.failNextRead.mode;
          delete script.failNextRead;
          if (mode === "error") throw new Error("mock: account read unavailable");
        }
        return textResult({
          balances: Object.entries(script.balances).map(([asset, free]) => ({ asset, free, locked: "0" })),
          updateTime: Date.now(),
        });
      }
      case "spot_my_trades":
        return textResult([]);
      case "spot_open_orders":
        return textResult([]);
      case "spot_test_order":
        return textResult({});
      case "spot_query_order": {
        return textResult({ symbol: args["symbol"], orderId: args["orderId"], status: "FILLED" });
      }
      case "spot_new_order": {
        const override = script.placeOrderQueue.shift();
        if (override?.error) throw new Error(`mock: ${override.error}`);
        const sym = String(args["symbol"] ?? "");
        const qty = String(args["quantity"] ?? "0");
        const px = override?.fillPrice ?? script.priceBySymbol[sym] ?? "0";
        const quote = new Decimal(px).times(qty);
        const commission = quote.times(script.commissionRate);
        const orderId = String(++orderSeq);
        return textResult({
          symbol: sym,
          orderId,
          status: override?.status ?? "FILLED",
          side: args["side"],
          type: args["type"],
          executedQty: qty,
          cummulativeQuoteQty: quote.toFixed(),
          transactTime: Date.now(),
          fills: [
            {
              price: px,
              qty,
              commission: commission.toFixed(),
              commissionAsset: "USDT",
              tradeId: orderSeq * 7,
            },
          ],
        });
      }
      case "wallet_withdraw":
      case "futures_new_order":
        throw new Error(`mock: ${tool} must never be called through SessionGuard`);
      default:
        throw new Error(`mock: unknown tool ${tool}`);
    }
  });

  const mounted = await mountMcpServer({
    server,
    port: opts.port ?? 0,
    ...(opts.requireBearer ? { requireBearer: opts.requireBearer } : {}),
  });

  return {
    url: mounted.url,
    port: mounted.port,
    calls,
    get script() {
      return script;
    },
    setScript: (s) => {
      script = { ...script, ...s };
    },
    reset: () => {
      script = structuredClone(DEFAULT_SCRIPT);
      calls.length = 0;
      orderSeq = 1000;
    },
    close: mounted.close,
  };
}

// Standalone: `npm run mock`
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const port = Number(process.env["MOCK_UPSTREAM_PORT"] ?? 8790);
  startMockUpstream({ port, logFile: process.env["MOCK_LOG_FILE"] }).then((m) => {
    console.log(`MockUpstream listening on ${m.url}`);
  });
}
