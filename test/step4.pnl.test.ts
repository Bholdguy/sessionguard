import { afterEach, describe, expect, it } from "vitest";
import { LedgerStore } from "../src/state/ledger.js";
import { computePnl } from "../src/state/pnl.js";
import { createMarketReader } from "../src/market/marketReader.js";
import { resolveToolCatalog } from "../src/mcp/toolCatalog.js";
import { createUpstreamClient } from "../src/mcp/upstreamClient.js";
import { startMockUpstream } from "./mockUpstream.js";
import type { Config, Fill, MarketSnapshot } from "../src/domain/types.js";

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

function fill(over: Partial<Fill>): Fill {
  return {
    fillId: "f" + Math.random(),
    sessionId: "s",
    ticketId: "t",
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
const freshMark = (symbol: string, markPrice: string): MarketSnapshot => ({
  symbol,
  markPrice,
  fetchedAt: new Date().toISOString(),
  source: "mcp:market.price",
  stale: false,
  ok: true,
});

describe("Step 4 — computePnl (exact, decimal)", () => {
  it("PN-2: open buy + favourable mark -> exact unrealized, fee in realized", () => {
    const l = new LedgerStore("s");
    l.applyFill(fill({ price: "60000", quantity: "0.01", commission: "0.6" }));
    const r = computePnl(l.snapshot(), { BTCUSDT: freshMark("BTCUSDT", "61000") }, "1000");
    expect(r.unrealizedPnlUsdt).toBe("10"); // 0.01 * (61000-60000)
    expect(r.realizedPnlUsdt).toBe("-0.6");
    expect(r.runningPnlUsdt).toBe("9.4");
    // drawdownPct = (1000 + 9.4 - 1000)/1000*100
    expect(r.drawdownPct).toBe("0.94");
  });

  it("3-trade scripted sequence matches a hand calc EXACTLY (Step 4 DoD)", () => {
    const l = new LedgerStore("s");
    l.applyFill(fill({ side: "BUY", price: "60000", quantity: "0.10", commission: "6" }));
    l.applyFill(fill({ side: "BUY", price: "58000", quantity: "0.10", commission: "5.8" }));
    l.applyFill(fill({ side: "SELL", price: "59000", quantity: "0.10", commission: "5.9" }));
    // avg after 2 buys = 59000 ; sell 0.10 @ 59000 => price pnl 0 ; fees = 6 + 5.8 + 5.9 = 17.7
    const snap = l.snapshot();
    expect(snap.realizedPnl).toBe("-17.7");
    // remaining 0.10 long @ 59000, mark 59500 => unrealized 0.10*500 = 50
    const r = computePnl(snap, { BTCUSDT: freshMark("BTCUSDT", "59500") }, "1000");
    expect(r.unrealizedPnlUsdt).toBe("50");
    expect(r.runningPnlUsdt).toBe("32.3");
    expect(r.drawdownPct).toBe("3.23");
  });

  it("open position with a missing/stale mark is reported, not zeroed (INV-3)", () => {
    const l = new LedgerStore("s");
    l.applyFill(fill({ side: "BUY", price: "60000", quantity: "0.01" }));
    const stale = { ...freshMark("BTCUSDT", "61000"), stale: true, ok: false };
    const r = computePnl(l.snapshot(), { BTCUSDT: stale }, "1000");
    expect(r.missingMarks).toContain("BTCUSDT");
    expect(r.unrealizedPnlUsdt).toBe("0"); // not counted — the data rule blocks the trade
  });
});

describe("Step 4 — marketReader (fail closed)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c().catch(() => undefined);
  });

  async function reader() {
    const mock = await startMockUpstream();
    cleanups.push(mock.close);
    const upstream = createUpstreamClient({ url: mock.url, nodeEnv: "test" });
    cleanups.push(upstream.close);
    await upstream.connect();
    const { catalog } = resolveToolCatalog(await upstream.listTools());
    return { mock, r: createMarketReader({ upstream, catalog, config: CONFIG }) };
  }

  it("returns a fresh ok snapshot on the happy path", async () => {
    const { r } = await reader();
    const s = await r.get("BTCUSDT");
    expect(s.ok).toBe(true);
    expect(s.stale).toBe(false);
    expect(s.markPrice).toBe("60000");
  });

  it("errored price feed -> ok:false, never a cached value", async () => {
    const { mock, r } = await reader();
    mock.setScript({ failNextRead: { kind: "price", mode: "error" } });
    const s = await r.get("BTCUSDT");
    expect(s.ok).toBe(false);
    expect(s.markPrice).toBe("0");
    expect(s.reason).toMatch(/error/);
  });

  it("stale upstream timestamp -> stale:true, ok:false", async () => {
    const { mock, r } = await reader();
    mock.setScript({ failNextRead: { kind: "price", mode: "stale" } });
    const s = await r.get("BTCUSDT");
    expect(s.stale).toBe(true);
    expect(s.ok).toBe(false);
  });

  it("price wildly off the klines close -> ok:false (sanity clamp)", async () => {
    const { mock, r } = await reader();
    mock.setScript({
      priceBySymbol: { BTCUSDT: "90000.00", ETHUSDT: "3000", BNBUSDT: "600" },
      klinesCloseBySymbol: { BTCUSDT: "60000.00" },
    });
    const s = await r.get("BTCUSDT");
    expect(s.ok).toBe(false);
    expect(s.reason).toMatch(/deviates/);
  });
});
