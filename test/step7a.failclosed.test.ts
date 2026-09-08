import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "../src/state/sessionStore.js";
import { LedgerStore } from "../src/state/ledger.js";
import { evaluate } from "../src/rules/evaluate.js";
import { dataAvailabilityRule } from "../src/rules/dataAvailability.js";
import { BlockCode } from "../src/domain/blockCode.js";
import { AuthError } from "../src/mcp/upstreamClient.js";
import type { AccountSnapshot, Config, MarketSnapshot, Ticket } from "../src/domain/types.js";
import type { RuleContext } from "../src/rules/context.js";

const CONFIG: Config = {
  drawdownPctLimit: "5",
  velocityWindowSeconds: 900,
  velocityMaxTrades: 5,
  ladderMultipleLimit: "1.5",
  allowedSymbols: ["BTCUSDT"],
  priceStalenessSeconds: 10,
  dataFetchTimeoutMs: 3000,
  priceSanityMaxDeviationPct: "20",
};
function ticket(): Ticket {
  return {
    ticketId: "t", sessionId: "s", receivedAt: new Date().toISOString(), toolName: "trade.placeOrder",
    upstreamToolName: "spot_new_order", symbol: "BTCUSDT", side: "BUY", type: "MARKET",
    quantity: "0.01", quoteOrderQty: null, price: null, timeInForce: null, rawParams: {},
  };
}
const okMark = (s: string): MarketSnapshot => ({ symbol: s, markPrice: "60000", fetchedAt: new Date().toISOString(), source: "mcp:market.price", stale: false, ok: true });
const okAcct = (): AccountSnapshot => ({ fetchedAt: new Date().toISOString(), balances: { USDT: "1000" }, equityUsdt: "1000", stale: false, ok: true });

function harness(market: () => Promise<MarketSnapshot>, account: () => Promise<AccountSnapshot> = async () => okAcct()) {
  const sessionStore = new SessionStore(CONFIG, 1);
  sessionStore.arm("1000");
  const ledger = new LedgerStore(sessionStore.current().sessionId);
  return {
    sessionStore,
    ledger,
    marketReader: { get: vi.fn(market) },
    accountReader: { balances: vi.fn(account), snapshotStartingEquity: vi.fn(async () => "1000") },
  };
}

describe("Step 7a — fail closed on missing data (DATA_UNAVAILABLE)", () => {
  it("DA-2: market read threw -> block, no forward, HALTED, drawdown never evaluated", async () => {
    const h = harness(async () => ({ ...okMark("BTCUSDT"), ok: false, markPrice: "0", reason: "error: boom" }));
    const res = await evaluate(ticket(), h);
    expect(res.decision.code).toBe(BlockCode.DATA_UNAVAILABLE);
    expect(res.forward).toBe(false);
    expect(h.sessionStore.current().status).toBe("HALTED");
    expect(res.decision.ruleResults.map((r) => r.rule)).toEqual(["DATA_AVAILABILITY"]);
  });

  it("DA-3: stale market snapshot -> DATA_UNAVAILABLE", async () => {
    const h = harness(async () => ({ ...okMark("BTCUSDT"), stale: true, ok: false }));
    expect((await evaluate(ticket(), h)).decision.code).toBe(BlockCode.DATA_UNAVAILABLE);
  });

  it("DA-4: non-positive price -> DATA_UNAVAILABLE", async () => {
    const h = harness(async () => ({ ...okMark("BTCUSDT"), markPrice: "0" }));
    expect((await evaluate(ticket(), h)).decision.code).toBe(BlockCode.DATA_UNAVAILABLE);
  });

  it("DA-6: account read not ok -> DATA_UNAVAILABLE", async () => {
    const h = harness(async () => okMark("BTCUSDT"), async () => ({ ...okAcct(), ok: false, reason: "timeout" }));
    expect((await evaluate(ticket(), h)).decision.code).toBe(BlockCode.DATA_UNAVAILABLE);
  });

  it("DA-7: account ok but quote asset missing -> DATA_UNAVAILABLE (defence in depth)", async () => {
    const h = harness(
      async () => okMark("BTCUSDT"),
      async () => ({ ...okAcct(), balances: { BTC: "1" }, equityUsdt: "0" }),
    );
    const res = await evaluate(ticket(), h);
    expect(res.decision.code).toBe(BlockCode.DATA_UNAVAILABLE);
    // and the rule catches it directly too
    const r = dataAvailabilityRule({
      ticket: ticket(), session: {} as never, config: CONFIG,
      ledger: { sessionId: "s", fills: [], positions: {}, realizedPnl: "0", totalCommission: "0", updatedAt: "" },
      market: { BTCUSDT: okMark("BTCUSDT") },
      account: { ...okAcct(), balances: { BTC: "1" } },
      pnl: { realizedPnlUsdt: "0", unrealizedPnlUsdt: "0", runningPnlUsdt: "0", runningEquity: "1000", drawdownPct: "0", perSymbolUnrealized: {}, missingMarks: [] },
      tradeCountInWindow: 0, now: "",
    } as RuleContext);
    expect(r.pass).toBe(false);
    expect(r.code).toBe(BlockCode.DATA_UNAVAILABLE);
  });

  it("DA-9: upstream 401 surfaced by the reader -> DATA_UNAVAILABLE (never an unguarded forward)", async () => {
    const h = harness(async () => {
      // marketReader would catch AuthError and return ok:false; simulate that result
      const e = new AuthError("upstream auth rejected: 401");
      return { ...okMark("BTCUSDT"), ok: false, markPrice: "0", reason: `error: ${e.message}` };
    });
    const res = await evaluate(ticket(), h);
    expect(res.decision.code).toBe(BlockCode.DATA_UNAVAILABLE);
    expect(res.forward).toBe(false);
  });

  it("INV-3: a missing mark for an OPEN position is not treated as zero", async () => {
    const h = harness(async () => ({ ...okMark("BTCUSDT"), stale: true, ok: false }));
    // open a position so pnl needs a mark
    h.ledger.applyFill({
      fillId: "a", sessionId: h.sessionStore.current().sessionId, ticketId: "x", symbol: "BTCUSDT",
      side: "BUY", price: "60000", quantity: "0.01", quoteQuantity: "600", commission: "0",
      commissionAsset: "USDT", timestamp: new Date().toISOString(), raw: {},
    });
    const res = await evaluate(ticket(), h);
    expect(res.decision.code).toBe(BlockCode.DATA_UNAVAILABLE);
  });
});
