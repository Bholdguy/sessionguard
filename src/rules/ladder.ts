/**
 * Rule 4 — LADDER_DETECTED (PRD Step 7). Martingale / DCA-after-a-loss: the core
 * blow-up pattern per Quora and r/CryptoCurrency (Trading Parrot).
 *
 * STUB until Step 7 — returns pass. Real body: block when the incoming ticket
 * increases same-direction exposure on a symbol whose last trade realised a
 * loss, and quantity > lastTradeQty * config.ladderMultipleLimit.
 */
import type { RuleResult } from "../domain/types.js";
import type { RuleContext, RuleFn } from "./context.js";

export const ladderRule: RuleFn = (ctx: RuleContext): RuleResult => {
  void ctx;
  return {
    rule: "LADDER",
    pass: true,
    code: null,
    observed: "0",
    threshold: ctx.config.ladderMultipleLimit,
    detail: "ladder rule not yet enforced (Step 7)",
  };
};
