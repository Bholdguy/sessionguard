/**
 * Rule 2 — DRAWDOWN_BREACH (PRD Step 5). Fills TradeGuard's stated "no drawdown
 * rule" gap; grounded in the r/ClaudeAI $31k thread (soft position sizing,
 * drawdown flywheel). observed/threshold are computed here in code, never from
 * any model output (INV-6).
 */
import { BlockCode } from "../domain/blockCode.js";
import { format, parse } from "../domain/decimal.js";
import type { RuleResult } from "../domain/types.js";
import type { RuleContext, RuleFn } from "./context.js";

export const drawdownRule: RuleFn = (ctx: RuleContext): RuleResult => {
  const threshold = parse(ctx.config.drawdownPctLimit, "drawdownPctLimit").neg(); // "5" -> -5
  const observed = parse(ctx.pnl.drawdownPct, "pnl.drawdownPct");
  const ok = observed.gt(threshold); // -4.9 > -5 -> pass ; -5.0 not > -5 -> block

  return {
    rule: "DRAWDOWN",
    pass: ok,
    code: ok ? null : BlockCode.DRAWDOWN_BREACH,
    observed: format(observed),
    threshold: format(threshold),
    detail: ok
      ? `session drawdown ${format(observed)}% within ${format(threshold)}% limit`
      : `Session drawdown ${format(observed)}% exceeds ${format(threshold)}% limit. Trading halted.`,
  };
};
