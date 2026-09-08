/**
 * Rule 3 — VELOCITY_EXCEEDED (PRD Step 6). Counts the calls, per the r/AI_Agents
 * finding (one position churned 7x in 17 min; fees > direction P&L). Fills
 * TradeGuard's stated "no velocity rule" gap.
 *
 * `ctx.tradeCountInWindow` is computed by evaluate() from the session's
 * allowed+forwarded trade timestamps (INV-7).
 */
import { BlockCode } from "../domain/blockCode.js";
import type { RuleResult } from "../domain/types.js";
import type { RuleContext, RuleFn } from "./context.js";

export const velocityRule: RuleFn = (ctx: RuleContext): RuleResult => {
  const limit = ctx.config.velocityMaxTrades;
  const observed = ctx.tradeCountInWindow;
  const ok = observed < limit; // block the call that would be the (limit+1)th in the window

  return {
    rule: "VELOCITY",
    pass: ok,
    code: ok ? null : BlockCode.VELOCITY_EXCEEDED,
    observed: String(observed),
    threshold: String(limit),
    detail: ok
      ? `${observed} trades in the last ${ctx.config.velocityWindowSeconds}s (limit ${limit})`
      : `${observed} trades in ${ctx.config.velocityWindowSeconds}s exceeds ${limit}. Trading halted.`,
  };
};
