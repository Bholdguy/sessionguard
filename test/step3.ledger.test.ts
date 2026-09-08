import { describe, expect, it } from "vitest";
import { LedgerStore } from "../src/state/ledger.js";
import { parsePlaceOrderFills } from "../src/state/fillParser.js";
import type { Fill, Ticket } from "../src/domain/types.js";

const SID = "sess-1";
function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    ticketId: "t1",
    sessionId: SID,
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
function fill(over: Partial<Fill> = {}): Fill {
  return {
    fillId: "f" + Math.random(),
    sessionId: SID,
    ticketId: "t1",
    symbol: "BTCUSDT",
    side: "BUY",
    price: "60000",
    quantity: "0.01",
    quoteQuantity: "600",
    commission: "0",
    commissionAsset: "USDT",
    timestamp: new Date().toISOString(),
    raw: {},
    ...over,
  };
}

describe("Step 3 — ledger (average-cost, decimal-exact)", () => {
  it("records two fills; realized reflects only the fee on an opening buy", () => {
    const l = new LedgerStore(SID);
    l.applyFill(fill({ price: "60000", quantity: "0.01", commission: "0.6" }));
    l.applyFill(fill({ price: "61000", quantity: "0.01", commission: "0.61" }));
    expect(l.fillCount).toBe(2);
    const pos = l.position("BTCUSDT")!;
    expect(pos.netQuantity).toBe("0.02");
    // avg = (0.01*60000 + 0.01*61000) / 0.02 = 60500
    expect(pos.avgEntryPrice).toBe("60500");
    // realized = -(0.6 + 0.61) fees, no price realization
    expect(l.snapshot().realizedPnl).toBe("-1.21");
    expect(pos.lastTradeWasLoss).toBe(false); // fee-only, no close
  });

  it("realizes an exact loss on a closing sell (PN-3 shape)", () => {
    const l = new LedgerStore(SID);
    l.applyFill(fill({ side: "BUY", price: "60000", quantity: "0.01", commission: "0.6" }));
    l.applyFill(fill({ side: "SELL", price: "59000", quantity: "0.01", commission: "0.59" }));
    // price pnl = 0.01 * (59000 - 60000) = -10 ; minus fees 0.6 + 0.59
    expect(l.snapshot().realizedPnl).toBe("-11.19");
    const pos = l.position("BTCUSDT")!;
    expect(pos.netQuantity).toBe("0");
    expect(pos.lastTradeWasLoss).toBe(true);
    expect(pos.lastTradeQty).toBe("0.01");
  });

  it("no float error (0.1 + 0.2 class)", () => {
    const l = new LedgerStore(SID);
    l.applyFill(fill({ side: "BUY", price: "0.1", quantity: "1", commission: "0" }));
    l.applyFill(fill({ side: "BUY", price: "0.2", quantity: "1", commission: "0" }));
    expect(l.position("BTCUSDT")!.avgEntryPrice).toBe("0.15");
  });

  it("position flip long -> short accounts the closed leg only", () => {
    const l = new LedgerStore(SID);
    l.applyFill(fill({ side: "BUY", price: "60000", quantity: "0.02", commission: "0" }));
    l.applyFill(fill({ side: "SELL", price: "61000", quantity: "0.03", commission: "0" }));
    const pos = l.position("BTCUSDT")!;
    // closed 0.02 @ +1000 => +20 realized; remaining 0.01 short @ 61000
    expect(l.snapshot().realizedPnl).toBe("20");
    expect(pos.netQuantity).toBe("-0.01");
    expect(pos.avgEntryPrice).toBe("61000");
  });

  it("commission in BNB with no rate fails closed (PN-7 — never silently dropped)", () => {
    const l = new LedgerStore(SID);
    expect(() =>
      l.applyFill(fill({ commission: "0.001", commissionAsset: "BNB" })),
    ).toThrow(/failing closed/);
  });

  it("INV-1: a profitable fill never reduces cumulative realized", () => {
    const l = new LedgerStore(SID);
    l.applyFill(fill({ side: "BUY", price: "100", quantity: "1", commission: "0" }));
    const before = Number(l.snapshot().realizedPnl);
    l.applyFill(fill({ side: "SELL", price: "150", quantity: "1", commission: "0" })); // +50
    const after = Number(l.snapshot().realizedPnl);
    expect(after).toBeGreaterThanOrEqual(before);
    expect(l.snapshot().realizedPnl).toBe("50");
  });
});

describe("Step 3 — fill parser", () => {
  it("parses a fills[] array", () => {
    const res = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            symbol: "BTCUSDT",
            side: "BUY",
            status: "FILLED",
            transactTime: 1_700_000_000_000,
            fills: [{ price: "60000.00", qty: "0.01", commission: "0.60", commissionAsset: "USDT" }],
          }),
        },
      ],
    };
    const { fills, resolved } = parsePlaceOrderFills(res, ticket());
    expect(resolved).toBe(true);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.price).toBe("60000");
    expect(fills[0]!.quoteQuantity).toBe("600");
  });

  it("synthesizes one fill from a thin FILLED response", () => {
    const res = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            symbol: "BTCUSDT",
            side: "BUY",
            status: "FILLED",
            executedQty: "0.02",
            cummulativeQuoteQty: "1200",
          }),
        },
      ],
    };
    const { fills, resolved } = parsePlaceOrderFills(res, ticket());
    expect(resolved).toBe(true);
    expect(fills[0]!.price).toBe("60000");
    expect(fills[0]!.quantity).toBe("0.02");
  });

  it("returns resolved:false when there is no usable fill data (never invents one)", () => {
    const res = { content: [{ type: "text", text: JSON.stringify({ symbol: "BTCUSDT", status: "NEW" }) }] };
    const { fills, resolved } = parsePlaceOrderFills(res, ticket());
    expect(resolved).toBe(false);
    expect(fills).toHaveLength(0);
  });
});
