/**
 * Append-only fill ledger + derived per-symbol positions (PRD §9.3, §9.4).
 * Average-cost accounting for spot; positions may flatten or flip.
 * All arithmetic via decimal.js (P-2). Commission (in USDT terms) is booked as
 * an immediate realized cost, so a fee-only fill still reduces realized P&L.
 */
import { Decimal, ZERO, format, parse } from "../domain/decimal.js";
import type { Fill, Ledger, Side, SymbolPosition } from "../domain/types.js";

function zeroPos(symbol: string, at: string): SymbolPosition {
  return {
    symbol,
    netQuantity: ZERO,
    avgEntryPrice: ZERO,
    realizedPnl: ZERO,
    lastTradeQty: ZERO,
    lastRealizedDelta: ZERO,
    lastTradeWasLoss: false,
    lastTradeSide: null,
    updatedAt: at,
  };
}

export class LedgerStore {
  private readonly _fills: Fill[] = [];
  private readonly _positions = new Map<string, SymbolPosition>();
  private _realizedPnl = new Decimal(0);
  private _totalCommission = new Decimal(0);
  private _updatedAt = new Date(0).toISOString();

  constructor(public readonly sessionId: string) {}

  /** Apply one fill. Throws (fails closed) on a commission we cannot value in USDT. */
  applyFill(fill: Fill, opts: { commissionUsdtRate?: string } = {}): void {
    if (fill.sessionId !== this.sessionId) {
      throw new Error(`ledger: fill for session ${fill.sessionId} != ${this.sessionId}`);
    }
    const qty = parse(fill.quantity, "fill.quantity").abs();
    const price = parse(fill.price, "fill.price");
    if (qty.lte(0) || price.lte(0)) {
      throw new Error(`ledger: non-positive fill qty/price (${fill.quantity}/${fill.price})`);
    }

    // commission -> USDT
    let commUsdt: Decimal;
    if (fill.commissionAsset === "USDT" || fill.commission === "0") {
      commUsdt = parse(fill.commission, "fill.commission");
    } else if (opts.commissionUsdtRate !== undefined) {
      commUsdt = parse(fill.commission, "fill.commission").times(
        parse(opts.commissionUsdtRate, "commissionUsdtRate"),
      );
    } else {
      throw new Error(
        `ledger: commission in ${fill.commissionAsset} with no USDT rate — failing closed (PN-7)`,
      );
    }

    const pos = this._positions.get(fill.symbol) ?? zeroPos(fill.symbol, fill.timestamp);
    const signed = fill.side === "BUY" ? qty : qty.neg();
    const net = parse(pos.netQuantity);

    let realizedPrice = new Decimal(0);
    let closeQty = new Decimal(0);
    let newNet: Decimal;
    let newAvg: Decimal;

    const opposite = net.isZero() ? false : net.isPositive() !== signed.isPositive();
    if (opposite) {
      closeQty = Decimal.min(net.abs(), signed.abs());
      const avg = parse(pos.avgEntryPrice);
      realizedPrice = net.isPositive()
        ? closeQty.times(price.minus(avg)) // closing a long
        : closeQty.times(avg.minus(price)); // covering a short
      newNet = net.plus(signed);
      if (newNet.isZero()) {
        newAvg = new Decimal(0);
      } else if (newNet.isPositive() === net.isPositive()) {
        newAvg = avg; // partial close, same side
      } else {
        newAvg = price; // flipped; remainder opens fresh at fill price
      }
    } else {
      const oldAbs = net.abs();
      const newAbs = oldAbs.plus(signed.abs());
      const avg = parse(pos.avgEntryPrice);
      newAvg = newAbs.isZero()
        ? new Decimal(0)
        : oldAbs.times(avg).plus(signed.abs().times(price)).div(newAbs);
      newNet = net.plus(signed);
    }

    const realizedDelta = realizedPrice.minus(commUsdt);
    const didClose = closeQty.gt(0);

    const updated: SymbolPosition = {
      symbol: fill.symbol,
      netQuantity: format(newNet),
      avgEntryPrice: format(newAvg),
      realizedPnl: format(parse(pos.realizedPnl).plus(realizedDelta)),
      lastTradeQty: format(qty),
      lastRealizedDelta: format(realizedDelta),
      lastTradeWasLoss: didClose && realizedDelta.isNegative(),
      lastTradeSide: fill.side as Side,
      updatedAt: fill.timestamp,
    };
    this._positions.set(fill.symbol, updated);

    this._fills.push(fill);
    this._realizedPnl = this._realizedPnl.plus(realizedDelta);
    this._totalCommission = this._totalCommission.plus(commUsdt);
    this._updatedAt = fill.timestamp;
  }

  position(symbol: string): SymbolPosition | undefined {
    return this._positions.get(symbol);
  }

  get fillCount(): number {
    return this._fills.length;
  }

  /** Immutable snapshot for the rule pipeline. */
  snapshot(): Ledger {
    const positions: Record<string, SymbolPosition> = {};
    for (const [k, v] of this._positions) positions[k] = { ...v };
    return {
      sessionId: this.sessionId,
      fills: this._fills.map((f) => ({ ...f })),
      positions,
      realizedPnl: format(this._realizedPnl),
      totalCommission: format(this._totalCommission),
      updatedAt: this._updatedAt,
    };
  }

  /** Wipe on re-arm (D-8). */
  clear(): void {
    this._fills.length = 0;
    this._positions.clear();
    this._realizedPnl = new Decimal(0);
    this._totalCommission = new Decimal(0);
    this._updatedAt = new Date(0).toISOString();
  }
}
