/**
 * Running P&L (PRD Step 4). Realized comes from the ledger (already net of
 * commission). Unrealized = netQuantity * (markPrice - avgEntryPrice) per open
 * symbol, using a fresh MarketSnapshot. drawdownPct is measured against the
 * session's starting equity. All decimal.js (P-2).
 */
import { Decimal, format, parse } from "../domain/decimal.js";
import type { Ledger, MarketSnapshot } from "../domain/types.js";

export interface PnlResult {
  realizedPnlUsdt: string;
  unrealizedPnlUsdt: string;
  runningPnlUsdt: string; // realized + unrealized
  runningEquity: string; // startingEquity + realized + unrealized
  drawdownPct: string; // (runningEquity - startingEquity) / startingEquity * 100 ; negative = loss
  perSymbolUnrealized: Record<string, string>;
  /** open-position symbols with no fresh/ok mark — the data rule (7a) blocks on these */
  missingMarks: string[];
}

export function computePnl(
  ledger: Ledger,
  marks: Record<string, MarketSnapshot>,
  startingEquity: string,
): PnlResult {
  const realized = parse(ledger.realizedPnl, "ledger.realizedPnl");
  let unrealized = new Decimal(0);
  const perSymbolUnrealized: Record<string, string> = {};
  const missingMarks: string[] = [];

  for (const [symbol, pos] of Object.entries(ledger.positions)) {
    const net = parse(pos.netQuantity);
    if (net.isZero()) {
      perSymbolUnrealized[symbol] = "0";
      continue;
    }
    const mark = marks[symbol];
    if (!mark || !mark.ok || mark.stale) {
      missingMarks.push(symbol);
      continue;
    }
    const u = net.times(parse(mark.markPrice, "markPrice").minus(parse(pos.avgEntryPrice)));
    perSymbolUnrealized[symbol] = format(u);
    unrealized = unrealized.plus(u);
  }

  const start = parse(startingEquity, "startingEquity");
  const runningEquity = start.plus(realized).plus(unrealized);
  const drawdownPct = start.isZero()
    ? new Decimal(0)
    : runningEquity.minus(start).div(start).times(100);

  return {
    realizedPnlUsdt: format(realized),
    unrealizedPnlUsdt: format(unrealized),
    runningPnlUsdt: format(realized.plus(unrealized)),
    runningEquity: format(runningEquity),
    drawdownPct: format(drawdownPct),
    perSymbolUnrealized,
    missingMarks,
  };
}
