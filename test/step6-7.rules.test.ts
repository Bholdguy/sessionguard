import { describe, expect, it } from "vitest";
import { countInWindow } from "../src/state/velocityWindow.js";
import { velocityRule } from "../src/rules/velocity.js";
import { ladderRule } from "../src/rules/ladder.js";
import { BlockCode } from "../src/domain/blockCode.js";
import type { Config, SymbolPosition, Ticket } from "../src/domain/types.js";
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
const NOW = "2026-09-08T12:00:00.000Z";
const ago = (s: number) => new Date(Date.parse(NOW) - s * 1000).toISOString();

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    ticketId: "t", sessionId: "s", receivedAt: NOW, toolName: "trade.placeOrder",
    upstreamToolName: "spot_new_order", symbol: "BTCUSDT", side: "BUY", type: "MARKET",
    quantity: "1", quoteOrderQty: null, price: null, timeInForce: null, rawParams: {}, ...over,
  };
}
function baseCtx(over: Partial<RuleContext> = {}): RuleContext {
  return {
    ticket: ticket(),
    session: {} as never,
    config: CONFIG,
    ledger: { sessionId: "s", fills: [], positions: {}, realizedPnl: "0", totalCommission: "0", updatedAt: NOW },
    market: { BTCUSDT: { symbol: "BTCUSDT", markPrice: "60000", fetchedAt: NOW, source: "mcp:market.price", stale: false, ok: true } },
    account: { fetchedAt: NOW, balances: { USDT: "1000" }, equityUsdt: "1000", stale: false, ok: true },
    pnl: { realizedPnlUsdt: "0", unrealizedPnlUsdt: "0", runningPnlUsdt: "0", runningEquity: "1000", drawdownPct: "0", perSymbolUnrealized: {}, missingMarks: [] },
    tradeCountInWindow: 0,
    now: NOW,
    ...over,
  };
}
function pos(over: Partial<SymbolPosition> = {}): SymbolPosition {
  return {
    symbol: "BTCUSDT", netQuantity: "1", avgEntryPrice: "60000", realizedPnl: "0",
    lastTradeQty: "1", lastRealizedDelta: "0", lastTradeWasLoss: false, lastTradeSide: "BUY",
    updatedAt: NOW, ...over,
  };
}

describe("Step 6 — velocity", () => {
  it("VL-1: 4 in window -> pass", () => {
    const ts = [ago(800), ago(600), ago(400), ago(100)];
    expect(countInWindow(ts, NOW, 900)).toBe(4);
    expect(velocityRule(baseCtx({ tradeCountInWindow: 4 })).pass).toBe(true);
  });
  it("VL-2: 5 in window -> block VELOCITY_EXCEEDED, observed '5'", () => {
    const r = velocityRule(baseCtx({ tradeCountInWindow: 5 }));
    expect(r.pass).toBe(false);
    expect(r.code).toBe(BlockCode.VELOCITY_EXCEEDED);
    expect(r.observed).toBe("5");
    expect(r.threshold).toBe("5");
  });
  it("VL-3: aged-out timestamps do not count", () => {
    const ts = [ago(1000), ago(950), ago(920), ago(500), ago(100)];
    expect(countInWindow(ts, NOW, 900)).toBe(2);
  });
  it("VL-4: the window boundary is inclusive", () => {
    expect(countInWindow([ago(900)], NOW, 900)).toBe(1);
  });
});

describe("Step 7 — ladder", () => {
  it("LD-1: loss then 2x same-direction -> block LADDER_DETECTED, observed '2'", () => {
    const ctx = baseCtx({
      ticket: ticket({ quantity: "2" }),
      ledger: { ...baseCtx().ledger, positions: { BTCUSDT: pos({ lastTradeWasLoss: true }) } },
    });
    const r = ladderRule(ctx);
    expect(r.pass).toBe(false);
    expect(r.code).toBe(BlockCode.LADDER_DETECTED);
    expect(r.observed).toBe("2");
    expect(r.threshold).toBe("1.5");
  });
  it("LD-2: loss then 1.2x -> pass", () => {
    const ctx = baseCtx({
      ticket: ticket({ quantity: "1.2" }),
      ledger: { ...baseCtx().ledger, positions: { BTCUSDT: pos({ lastTradeWasLoss: true }) } },
    });
    expect(ladderRule(ctx).pass).toBe(true);
  });
  it("LD-3: loss then exactly 1.5x -> pass (strict >)", () => {
    const ctx = baseCtx({
      ticket: ticket({ quantity: "1.5" }),
      ledger: { ...baseCtx().ledger, positions: { BTCUSDT: pos({ lastTradeWasLoss: true }) } },
    });
    expect(ladderRule(ctx).pass).toBe(true);
  });
  it("LD-4: win then 5x -> pass (ladder only after a loss)", () => {
    const ctx = baseCtx({
      ticket: ticket({ quantity: "5" }),
      ledger: { ...baseCtx().ledger, positions: { BTCUSDT: pos({ lastTradeWasLoss: false }) } },
    });
    expect(ladderRule(ctx).pass).toBe(true);
  });
  it("LD-5: loss then 3x but opposite direction (reduces) -> pass", () => {
    const ctx = baseCtx({
      ticket: ticket({ quantity: "3", side: "SELL" }),
      ledger: { ...baseCtx().ledger, positions: { BTCUSDT: pos({ netQuantity: "1", lastTradeWasLoss: true }) } },
    });
    expect(ladderRule(ctx).pass).toBe(true);
  });
  it("LD-6: no prior trade on symbol -> pass", () => {
    expect(ladderRule(baseCtx({ ticket: ticket({ quantity: "10" }) })).pass).toBe(true);
  });
  it("LD-7: re-entry from flat after a realised loss, 2x -> block", () => {
    const ctx = baseCtx({
      ticket: ticket({ quantity: "2" }),
      ledger: {
        ...baseCtx().ledger,
        positions: { BTCUSDT: pos({ netQuantity: "0", lastTradeWasLoss: true }) },
      },
    });
    expect(ladderRule(ctx).code).toBe(BlockCode.LADDER_DETECTED);
  });
});
