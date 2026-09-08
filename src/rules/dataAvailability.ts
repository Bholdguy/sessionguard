/**
 * Rule 1 — DATA_UNAVAILABLE (PRD Step 7a). FAIL CLOSED: any error / timeout /
 * stale / incomplete / non-positive market or account read blocks the next
 * trade. Never substitutes a cached, last-known, or zero value (P-3, INV-3).
 *
 * Runs FIRST after the kill-switch short-circuit (fixed order, D-3). The reader
 * hardening (marketReader/accountReader timeouts, 401->fail-closed) and the
 * forced-failure integration test IT-6 are completed in Step 7a.
 */
import { BlockCode } from "../domain/blockCode.js";
import { parse } from "../domain/decimal.js";
import type { RuleResult } from "../domain/types.js";
import type { RuleContext, RuleFn } from "./context.js";

function fail(detail: string): RuleResult {
  return {
    rule: "DATA_AVAILABILITY",
    pass: false,
    code: BlockCode.DATA_UNAVAILABLE,
    observed: "unavailable",
    threshold: "fresh",
    detail,
  };
}

export const dataAvailabilityRule: RuleFn = (ctx: RuleContext): RuleResult => {
  // account must be readable and carry the quote asset
  if (!ctx.account.ok || ctx.account.stale) {
    return fail(`Account state unavailable (${ctx.account.reason ?? "not ok"}). No data, no trade.`);
  }
  if (ctx.account.balances["USDT"] === undefined) {
    return fail("Account state incomplete: quote asset USDT missing from balances. No data, no trade.");
  }

  // every symbol we need a mark for must be fresh & ok
  const needed = new Set<string>([ctx.ticket.symbol, ...ctx.pnl.missingMarks]);
  for (const sym of needed) {
    const m = ctx.market[sym];
    if (!m || !m.ok || m.stale) {
      return fail(`Market price for ${sym} unavailable (${m?.reason ?? "no snapshot"}). No data, no trade.`);
    }
    let px;
    try {
      px = parse(m.markPrice, "markPrice");
    } catch {
      return fail(`Market price for ${sym} not a decimal (${m.markPrice}). No data, no trade.`);
    }
    if (px.lte(0)) return fail(`Market price for ${sym} non-positive (${m.markPrice}). No data, no trade.`);
  }

  return {
    rule: "DATA_AVAILABILITY",
    pass: true,
    code: null,
    observed: "fresh",
    threshold: "fresh",
    detail: "market + account reads fresh",
  };
};
