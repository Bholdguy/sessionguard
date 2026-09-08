/**
 * Deterministic scenario runner (PRD Steps 12–13). Drives a scripted sequence
 * of trade.placeOrder calls through SessionGuard against MockUpstream (D-0/D-7),
 * or — in "unsupervised" mode — straight at the mock with no proxy, for the
 * baseline comparison (Step 13a).
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { format, parse } from "../domain/decimal.js";
import type { Config } from "../domain/types.js";
import { createApp } from "../app.js";
import { LedgerStore } from "../state/ledger.js";
import { computePnl } from "../state/pnl.js";
import { parsePlaceOrderFills } from "../state/fillParser.js";
import { createUpstreamClient } from "../mcp/upstreamClient.js";
import { resolveToolCatalog } from "../mcp/toolCatalog.js";
import { startMockUpstream } from "../../test/mockUpstream.js";

export interface ScenarioTicket {
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  quantity: string;
  price?: string;
  mark?: string;
  fillPrice?: string;
  failRead?: { kind: "price" | "account"; mode: "error" | "stale" };
}

export interface Scenario {
  name: string;
  startingEquity: string;
  tickets: ScenarioTicket[];
  expected: { terminalCode: string | null; halted: boolean; haltAtIndex?: number };
}

export interface RunReport {
  name: string;
  mode: "supervised" | "unsupervised";
  outcomes: string[]; // "ALLOWED" / "EXECUTED" / a BlockCode / a RefusalCode
  halted: boolean;
  haltAtIndex: number | null;
  terminalCode: string | null;
  /** drawdown % the deciding rule observed at the halt (supervised); else final */
  drawdownAtHalt: string;
  finalDrawdownPct: string;
  tradesExecuted: number;
  feeToGrossPnl: string;
  auditPath?: string;
}

const DEFAULT_CONFIG: Config = {
  drawdownPctLimit: "5",
  velocityWindowSeconds: 900,
  velocityMaxTrades: 5,
  ladderMultipleLimit: "1.5",
  allowedSymbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
  priceStalenessSeconds: 10,
  dataFetchTimeoutMs: 3000,
  priceSanityMaxDeviationPct: "20",
};

export function loadScenario(path: string): Scenario {
  return JSON.parse(readFileSync(path, "utf8")) as Scenario;
}

function feeRatio(ledger: LedgerStore, unrealizedUsdt: string): string {
  const snap = ledger.snapshot();
  const comm = parse(snap.totalCommission);
  // gross price-only P&L magnitude = (realised net of fees + fees) + unrealised
  const gross = parse(snap.realizedPnl).plus(comm).plus(parse(unrealizedUsdt)).abs();
  if (gross.lte(0)) return comm.gt(0) ? "inf" : "0";
  const r = comm.div(gross);
  return r.gt(999) ? "999+" : format(r);
}

const BASE_PRICES: Record<string, string> = { BTCUSDT: "60000", ETHUSDT: "3000", BNBUSDT: "600" };

export async function runScenarioSupervised(
  scenario: Scenario,
  opts: { config?: Config; evidenceDir?: string } = {},
): Promise<RunReport> {
  const config = opts.config ?? DEFAULT_CONFIG;
  const evidenceDir = opts.evidenceDir ?? "./evidence";
  const mock = await startMockUpstream();
  const prices = { ...BASE_PRICES };
  mock.setScript({
    equityUsdt: scenario.startingEquity,
    balances: { USDT: scenario.startingEquity, BTC: "0", ETH: "0", BNB: "0" },
    priceBySymbol: { ...prices },
  });

  const app = await createApp({
    mcpUrl: mock.url,
    nodeEnv: "test",
    config,
    configVersion: 1,
    evidenceDir,
    toolsListTimeoutMs: 5000,
    log: () => undefined,
  });
  const placeTool = app.catalog.map["trade.placeOrder"]!;

  const outcomes: string[] = [];
  let haltAtIndex: number | null = null;
  let terminalCode: string | null = null;
  let drawdownAtHalt = "0";

  for (let i = 0; i < scenario.tickets.length; i++) {
    const t = scenario.tickets[i]!;
    if (t.mark) prices[t.symbol] = t.mark;
    mock.setScript({ priceBySymbol: { ...prices } });
    if (t.fillPrice) mock.setScript({ placeOrderQueue: [{ fillPrice: t.fillPrice }] });
    if (t.failRead) mock.setScript({ failNextRead: { kind: t.failRead.kind, mode: t.failRead.mode } });

    const res = (await app.onToolCall({
      upstreamToolName: placeTool,
      logicalName: "trade.placeOrder",
      args: { symbol: t.symbol, side: t.side, type: t.type, quantity: t.quantity, ...(t.price ? { price: t.price } : {}) },
    })) as { result: { isError?: boolean; content: Array<{ text: string }> } };

    const payload = JSON.parse(res.result.content[0]!.text) as {
      code?: string;
      detail?: string;
      receipt?: { sessionGuard?: { ruleResults?: Array<{ pass: boolean; observed: string; rule: string }> } };
    };
    if (res.result.isError && payload.code) {
      outcomes.push(payload.code);
      if (haltAtIndex === null && payload.code !== "SYMBOL_NOT_WHITELISTED") {
        haltAtIndex = i;
        terminalCode = payload.code;
        const failing = payload.receipt?.sessionGuard?.ruleResults?.find((r) => !r.pass);
        if (failing && failing.rule === "DRAWDOWN") drawdownAtHalt = failing.observed;
        else drawdownAtHalt = (await app.snapshot()).drawdownPct;
      }
    } else {
      outcomes.push("ALLOWED");
    }
  }

  const snap = await app.snapshot();
  const report: RunReport = {
    name: scenario.name,
    mode: "supervised",
    outcomes,
    halted: app.sessionStore.current().status === "HALTED",
    haltAtIndex,
    terminalCode,
    drawdownAtHalt: haltAtIndex === null ? snap.drawdownPct : drawdownAtHalt,
    finalDrawdownPct: snap.drawdownPct,
    tradesExecuted: outcomes.filter((o) => o === "ALLOWED").length,
    feeToGrossPnl: feeRatio(app.ledger, snap.unrealizedPnlUsdt),
    auditPath: app.audit.path,
  };
  await app.close();
  await mock.close();
  return report;
}

export async function runScenarioUnsupervised(scenario: Scenario): Promise<RunReport> {
  const mock = await startMockUpstream();
  const prices = { ...BASE_PRICES };
  mock.setScript({
    equityUsdt: scenario.startingEquity,
    balances: { USDT: scenario.startingEquity },
    priceBySymbol: { ...prices },
  });

  const upstream = createUpstreamClient({ url: mock.url, nodeEnv: "test" });
  await upstream.connect();
  const { catalog } = resolveToolCatalog(await upstream.listTools());
  const placeTool = catalog.map["trade.placeOrder"]!;

  const shadow = new LedgerStore("unsupervised");
  const outcomes: string[] = [];

  for (const t of scenario.tickets) {
    if (t.mark) prices[t.symbol] = t.mark;
    mock.setScript({ priceBySymbol: { ...prices } });
    if (t.fillPrice) mock.setScript({ placeOrderQueue: [{ fillPrice: t.fillPrice }] });
    // the naive agent does no market read, so t.failRead is a no-op for it

    const result = await upstream.callTool(placeTool, {
      symbol: t.symbol,
      side: t.side,
      type: t.type,
      quantity: t.quantity,
    });
    const parsed = parsePlaceOrderFills(result, {
      ticketId: "u",
      sessionId: "unsupervised",
      receivedAt: new Date().toISOString(),
      toolName: "trade.placeOrder",
      upstreamToolName: placeTool,
      symbol: t.symbol,
      side: t.side,
      type: t.type,
      quantity: t.quantity,
      quoteOrderQty: null,
      price: null,
      timeInForce: null,
      rawParams: {},
    });
    for (const f of parsed.fills) shadow.applyFill(f);
    outcomes.push("EXECUTED");
  }

  const marks: Record<string, import("../domain/types.js").MarketSnapshot> = {};
  for (const [sym, px] of Object.entries(prices)) {
    marks[sym] = { symbol: sym, markPrice: px, fetchedAt: new Date().toISOString(), source: "mcp:market.price", stale: false, ok: true };
  }
  const pnl = computePnl(shadow.snapshot(), marks, scenario.startingEquity);

  await upstream.close();
  await mock.close();
  return {
    name: scenario.name,
    mode: "unsupervised",
    outcomes,
    halted: false,
    haltAtIndex: null,
    terminalCode: null,
    drawdownAtHalt: pnl.drawdownPct,
    finalDrawdownPct: pnl.drawdownPct,
    tradesExecuted: outcomes.length,
    feeToGrossPnl: feeRatio(shadow, pnl.unrealizedPnlUsdt),
  };
}

// CLI: npm run agent -- --scenario drawdown [--unsupervised]
const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const name = args[args.indexOf("--scenario") + 1] ?? "happy";
  const unsupervised = args.includes("--unsupervised");
  const scenario = loadScenario(`./evidence/scenarios/${name}.json`);
  const report = unsupervised
    ? await runScenarioUnsupervised(scenario)
    : await runScenarioSupervised(scenario);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
