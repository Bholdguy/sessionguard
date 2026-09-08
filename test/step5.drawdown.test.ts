import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "../src/state/sessionStore.js";
import { LedgerStore } from "../src/state/ledger.js";
import { evaluate, RULE_PIPELINE } from "../src/rules/evaluate.js";
import { drawdownRule } from "../src/rules/drawdown.js";
import { BlockCode } from "../src/domain/blockCode.js";
import type { AccountSnapshot, Config, MarketSnapshot, Ticket } from "../src/domain/types.js";
import type { RuleContext } from "../src/rules/context.js";

const CONFIG: Config = {
  drawdownPctLimit: "5",
  velocityWindowSeconds: 900,
  velocityMaxTrades: 5,
  ladderMultipleLimit: "1.5",
  allowedSymbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
  priceStalenessSeconds: 10,
  dataFetchTimeoutMs: 3000,
  priceSanityMaxDeviationPct: "20",
};

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    ticketId: "t-" + Math.random(),
    sessionId: "s",
    receivedAt: new Date().toISOString(),
    toolName: "trade.placeOrder",
    upstreamToolName: "spot_new_order",
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    quantity: "0.01",
    quoteOrderQty: null,
    price: null,
    timeInForce: null,
    rawParams: {},
    ...over,
  };
}
const okMark = (symbol: string, markPrice: string): MarketSnapshot => ({
  symbol,
  markPrice,
  fetchedAt: new Date().toISOString(),
  source: "mcp:market.price",
  stale: false,
  ok: true,
});
const okAccount = (): AccountSnapshot => ({
  fetchedAt: new Date().toISOString(),
  balances: { USDT: "1000" },
  equityUsdt: "1000",
  stale: false,
  ok: true,
});

function harness(opts: { markPrice?: string; account?: AccountSnapshot } = {}) {
  const sessionStore = new SessionStore(CONFIG, 1);
  sessionStore.arm("1000");
  const ledger = new LedgerStore(sessionStore.current().sessionId);
  const marketReader = {
    get: vi.fn(async (s: string) => okMark(s, opts.markPrice ?? "60000")),
  };
  const accountReader = {
    balances: vi.fn(async () => opts.account ?? okAccount()),
    snapshotStartingEquity: vi.fn(async () => "1000"),
  };
  return { sessionStore, ledger, marketReader, accountReader };
}

describe("Step 5 — drawdown rule (unit)", () => {
  function ctxWithDrawdown(dd: string): RuleContext {
    return {
      ticket: ticket(),
      session: { config: CONFIG } as never,
      config: CONFIG,
      ledger: {} as never,
      market: {},
      account: okAccount(),
      pnl: {
        realizedPnlUsdt: "0",
        unrealizedPnlUsdt: "0",
        runningPnlUsdt: "0",
        runningEquity: "0",
        drawdownPct: dd,
        perSymbolUnrealized: {},
        missingMarks: [],
      },
      tradeCountInWindow: 0,
      now: new Date().toISOString(),
    };
  }

  it("DD-1: -4.9% allows", () => {
    expect(drawdownRule(ctxWithDrawdown("-4.9")).pass).toBe(true);
  });
  it("DD-2: exactly -5.0% blocks with DRAWDOWN_BREACH, observed '-5'", () => {
    const r = drawdownRule(ctxWithDrawdown("-5.0"));
    expect(r.pass).toBe(false);
    expect(r.code).toBe(BlockCode.DRAWDOWN_BREACH);
    expect(r.observed).toBe("-5");
    expect(r.threshold).toBe("-5");
  });
  it("DD-3: -6.2% blocks, observed '-6.2'", () => {
    const r = drawdownRule(ctxWithDrawdown("-6.2"));
    expect(r.pass).toBe(false);
    expect(r.observed).toBe("-6.2");
  });
  it("DD-6 provenance: observed comes from pnl, not from ticket text (INV-6)", () => {
    const c = ctxWithDrawdown("-6.2");
    (c.ticket.rawParams as Record<string, unknown>)["drawdown"] = "-1";
    expect(drawdownRule(c).observed).toBe("-6.2");
  });
});

describe("Step 5 — evaluate pipeline (order + short-circuit)", () => {
  it("EV-7: fixed order is data -> drawdown -> velocity -> ladder", async () => {
    const h = harness();
    const { decision } = await evaluate(ticket(), h);
    expect(decision.ruleResults.map((r) => r.rule)).toEqual([
      "DATA_AVAILABILITY",
      "DRAWDOWN",
      "VELOCITY",
      "LADDER",
    ]);
    expect(RULE_PIPELINE).toHaveLength(4);
  });

  it("EV-5: all pass -> ALLOWED + forward", async () => {
    const h = harness();
    const res = await evaluate(ticket(), h);
    expect(res.decision.outcome).toBe("ALLOWED");
    expect(res.forward).toBe(true);
  });

  it("drawdown breach -> BLOCKED, not forwarded, session HALTED, upstream never called", async () => {
    const h = harness();
    // seed a big realised loss: buy 0.5 @ 60000 then sell 0.5 @ 40000 => -10000 on 1000 equity
    h.ledger.applyFill({
      fillId: "a", sessionId: h.sessionStore.current().sessionId, ticketId: "x", symbol: "BTCUSDT",
      side: "BUY", price: "60000", quantity: "0.5", quoteQuantity: "30000", commission: "0",
      commissionAsset: "USDT", timestamp: new Date().toISOString(), raw: {},
    });
    h.ledger.applyFill({
      fillId: "b", sessionId: h.sessionStore.current().sessionId, ticketId: "y", symbol: "BTCUSDT",
      side: "SELL", price: "40000", quantity: "0.5", quoteQuantity: "20000", commission: "0",
      commissionAsset: "USDT", timestamp: new Date().toISOString(), raw: {},
    });
    const res = await evaluate(ticket(), h);
    expect(res.decision.outcome).toBe("BLOCKED");
    expect(res.decision.code).toBe(BlockCode.DRAWDOWN_BREACH);
    expect(res.forward).toBe(false);
    expect(h.sessionStore.current().status).toBe("HALTED");
    // stops at drawdown: data(pass) + drawdown(fail) only
    expect(res.decision.ruleResults.map((r) => r.rule)).toEqual(["DATA_AVAILABILITY", "DRAWDOWN"]);
  });

  it("EV-1: a HALTED session short-circuits with the stored code, no reads", async () => {
    const h = harness();
    h.sessionStore.halt(BlockCode.VELOCITY_EXCEEDED, "prior");
    const res = await evaluate(ticket(), h);
    expect(res.decision.code).toBe(BlockCode.VELOCITY_EXCEEDED);
    expect(res.decision.ruleResults.map((r) => r.rule)).toEqual(["KILL_SWITCH"]);
    expect(h.marketReader.get).not.toHaveBeenCalled();
    expect(h.accountReader.balances).not.toHaveBeenCalled();
  });

  it("EV-6: symbol not whitelisted -> RefusalCode, not a BlockCode, no halt", async () => {
    const h = harness();
    const res = await evaluate(ticket({ symbol: "DOGEUSDT" }), h);
    expect(res.decision.code).toBeNull();
    expect(res.decision.refusal).toBe("SYMBOL_NOT_WHITELISTED");
    expect(h.sessionStore.current().status).toBe("ACTIVE");
  });

  it("EV-9: RuleContext handed to rules is frozen", async () => {
    const h = harness();
    let seen: RuleContext | undefined;
    const spyPipeline = RULE_PIPELINE.slice();
    // wrap the first rule to capture ctx
    const orig = spyPipeline[0]!;
    RULE_PIPELINE[0] = (c) => {
      seen = c;
      return orig(c);
    };
    await evaluate(ticket(), h);
    RULE_PIPELINE[0] = orig;
    expect(Object.isFrozen(seen)).toBe(true);
  });
});
