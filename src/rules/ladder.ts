/**
 * Rule 4 — LADDER_DETECTED (PRD Step 7). Martingale / DCA-after-a-loss: the core
 * blow-up pattern per Quora ("bots that increase lot size after a loss") and
 * r/CryptoCurrency (Trading Parrot — stacked safety orders, silent drawdown).
 *
 * Blocks when ALL hold:
 *   - the incoming ticket INCREASES same-direction exposure on symbol S
 *     (adding to an open position on the same side, or re-entering from flat)
 *   - S's most recent fill realised a loss (pos.lastTradeWasLoss)
 *   - incoming size / lastTradeQty  >  config.ladderMultipleLimit  (strict)
 */
import { BlockCode } from "../domain/blockCode.js";
import { Decimal, format, parse } from "../domain/decimal.js";
import type { RuleResult } from "../domain/types.js";
import type { RuleContext, RuleFn } from "./context.js";

function pass(observed: string, threshold: string, detail: string): RuleResult {
  return { rule: "LADDER", pass: true, code: null, observed, threshold, detail };
}

export const ladderRule: RuleFn = (ctx: RuleContext): RuleResult => {
  const { ticket } = ctx;
  const multiple = ctx.config.ladderMultipleLimit;
  const pos = ctx.ledger.positions[ticket.symbol];

  if (!pos || !pos.lastTradeWasLoss) {
    return pass("0", multiple, "no prior loss on this symbol");
  }

  const lastQty = parse(pos.lastTradeQty);
  if (lastQty.lte(0)) return pass("0", multiple, "no sized prior trade on this symbol");

  // incoming size in base units
  let qty: Decimal;
  if (ticket.quantity != null) {
    qty = parse(ticket.quantity, "ticket.quantity").abs();
  } else if (ticket.quoteOrderQty != null) {
    const mark = ctx.market[ticket.symbol];
    if (!mark || !mark.ok) return pass("0", multiple, "cannot size quoteOrderQty without a mark");
    qty = parse(ticket.quoteOrderQty, "ticket.quoteOrderQty").div(parse(mark.markPrice)).abs();
  } else {
    return pass("0", multiple, "ticket carries no size");
  }

  // same-direction exposure increase?
  const net = parse(pos.netQuantity);
  const addingSameSide =
    net.isZero() || (net.isPositive() ? ticket.side === "BUY" : ticket.side === "SELL");
  if (!addingSameSide) {
    return pass("0", multiple, "incoming trade reduces exposure — not a ladder");
  }

  const ratio = qty.div(lastQty);
  const ok = ratio.lte(multiple); // strict: exactly Nx is allowed (LD-3)

  return {
    rule: "LADDER",
    pass: ok,
    code: ok ? null : BlockCode.LADDER_DETECTED,
    observed: format(ratio),
    threshold: format(multiple),
    detail: ok
      ? `size ${format(ratio)}x the prior losing trade (limit ${format(multiple)}x)`
      : `Size ${format(ratio)}x the prior losing trade on ${ticket.symbol} exceeds ${format(
          multiple,
        )}x. Trading halted.`,
  };
};
