/**
 * Fresh market-price reads with a hard timeout, a freshness stamp, a sanity
 * clamp vs the recent klines close, and FAIL-CLOSED on any error/timeout/stale/
 * non-positive value (P-3). Never returns a cached or last-known price.
 */
import { Decimal } from "../domain/decimal.js";
import type { Config, MarketSnapshot, ToolCatalog } from "../domain/types.js";
import type { UpstreamClient } from "../mcp/upstreamClient.js";
import { payloadOf } from "../state/fillParser.js";
import { TimeoutError, errMsg, withTimeout } from "../util/timeout.js";

export interface MarketReader {
  get(symbol: string): Promise<MarketSnapshot>;
}

function unavailable(symbol: string, reason: string): MarketSnapshot {
  return {
    symbol,
    markPrice: "0",
    fetchedAt: new Date().toISOString(),
    source: "none",
    stale: false,
    ok: false,
    reason,
  };
}

function extractPrice(payload: Record<string, unknown> | null): { price: string; time?: number } | null {
  if (!payload) return null;
  const p = payload as Record<string, unknown>;
  const raw = p["price"] ?? p["markPrice"] ?? p["lastPrice"] ?? p["c"];
  if (raw == null) return null;
  const time = p["time"] != null ? Number(p["time"]) : p["closeTime"] != null ? Number(p["closeTime"]) : undefined;
  return time !== undefined ? { price: String(raw), time } : { price: String(raw) };
}

function klinesClose(payload: unknown): string | null {
  // Binance klines: array of [openTime, open, high, low, close, volume, closeTime, ...]
  if (Array.isArray(payload) && payload.length > 0) {
    const last = payload[payload.length - 1];
    if (Array.isArray(last) && last.length >= 5) return String(last[4]);
  }
  const p = payloadOf(payload);
  if (Array.isArray(p)) return klinesClose(p);
  return null;
}

export function createMarketReader(deps: {
  upstream: UpstreamClient;
  catalog: ToolCatalog;
  config: Config;
  now?: () => number;
}): MarketReader {
  const now = deps.now ?? (() => Date.now());
  const priceTool = deps.catalog.map["market.price"];
  const klinesTool = deps.catalog.map["market.klines"];

  return {
    async get(symbol: string): Promise<MarketSnapshot> {
      if (!priceTool) return unavailable(symbol, "no market.price capability resolved");

      let payload: Record<string, unknown> | null;
      try {
        const res = await withTimeout(
          deps.upstream.callTool(priceTool, { symbol }),
          deps.config.dataFetchTimeoutMs,
          `market.price(${symbol})`,
        );
        payload = payloadOf(res);
      } catch (e) {
        return unavailable(symbol, e instanceof TimeoutError ? "timeout" : `error: ${errMsg(e)}`);
      }

      const ext = extractPrice(payload);
      if (!ext) return unavailable(symbol, "price missing/unparseable in response");

      let price: Decimal;
      try {
        price = new Decimal(ext.price);
      } catch {
        return unavailable(symbol, `price not a decimal: ${ext.price}`);
      }
      if (!price.isFinite() || price.lte(0)) {
        return unavailable(symbol, `non-positive price: ${ext.price}`);
      }

      const fetchedAtMs = now();
      const stale =
        ext.time !== undefined &&
        fetchedAtMs - ext.time > deps.config.priceStalenessSeconds * 1000;

      // sanity clamp vs recent klines close
      if (klinesTool) {
        try {
          const kres = await withTimeout(
            deps.upstream.callTool(klinesTool, { symbol, interval: "1m", limit: 1 }),
            deps.config.dataFetchTimeoutMs,
            `market.klines(${symbol})`,
          );
          const close = klinesClose(kres);
          if (close) {
            const c = new Decimal(close);
            if (c.gt(0)) {
              const devPct = price.minus(c).abs().div(c).times(100);
              if (devPct.gt(deps.config.priceSanityMaxDeviationPct)) {
                return unavailable(
                  symbol,
                  `price ${ext.price} deviates ${devPct.toFixed(1)}% from klines close ${close}`,
                );
              }
            }
          }
        } catch {
          // klines is a best-effort sanity check; its own failure does not
          // fail the price read, but a genuinely stale/erroring price already did.
        }
      }

      return {
        symbol,
        markPrice: price.toFixed(),
        fetchedAt: new Date(fetchedAtMs).toISOString(),
        source: "mcp:market.price",
        stale,
        ok: !stale,
        ...(stale ? { reason: "stale: upstream timestamp older than priceStalenessSeconds" } : {}),
      };
    },
  };
}
