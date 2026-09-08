/** Live StateSnapshot for GET /state and the dashboard (PRD Step 11). Read-only. */
import type { MarketSnapshot, StateSnapshot } from "../domain/types.js";
import type { LedgerStore } from "../state/ledger.js";
import type { SessionStore } from "../state/sessionStore.js";
import type { MarketReader } from "../market/marketReader.js";
import { computePnl } from "../state/pnl.js";
import { countInWindow } from "../state/velocityWindow.js";

export async function liveSnapshot(deps: {
  sessionStore: SessionStore;
  ledger: LedgerStore;
  marketReader: MarketReader;
  now?: () => Date;
}): Promise<StateSnapshot> {
  const session = deps.sessionStore.current();
  const ledger = deps.ledger.snapshot();
  const market: Record<string, MarketSnapshot> = {};
  for (const sym of Object.keys(ledger.positions)) market[sym] = await deps.marketReader.get(sym);
  const pnl = computePnl(ledger, market, session.startingEquity);
  const tradeCountInWindow = countInWindow(
    session.tradeTimestamps,
    (deps.now?.() ?? new Date()).toISOString(),
    session.config.velocityWindowSeconds,
  );
  const perSymbol: StateSnapshot["perSymbol"] = {};
  for (const [sym, p] of Object.entries(ledger.positions)) {
    perSymbol[sym] = {
      netQuantity: p.netQuantity,
      lastTradeQty: p.lastTradeQty,
      lastTradeWasLoss: p.lastTradeWasLoss,
    };
  }
  return {
    runningPnlUsdt: pnl.runningPnlUsdt,
    realizedPnlUsdt: pnl.realizedPnlUsdt,
    unrealizedPnlUsdt: pnl.unrealizedPnlUsdt,
    drawdownPct: pnl.drawdownPct,
    tradeCountInWindow,
    velocityWindowSeconds: session.config.velocityWindowSeconds,
    perSymbol,
    killSwitch: session.status,
    haltReason: session.haltReason,
    configVersion: session.configVersion,
  };
}

export function renderDashboard(s: StateSnapshot, cfg: { drawdownPctLimit: string; velocityMaxTrades: number }): string {
  const bar = s.killSwitch === "HALTED" ? "■ HALTED" : "● ACTIVE";
  const lines = [
    `┌─ SessionGuard ─────────────────────────────────`,
    `│ kill-switch : ${bar}${s.haltReason ? `  (${s.haltReason})` : ""}`,
    `│ P&L         : ${s.runningPnlUsdt} USDT  (real ${s.realizedPnlUsdt} / unreal ${s.unrealizedPnlUsdt})`,
    `│ drawdown    : ${s.drawdownPct}%   limit -${cfg.drawdownPctLimit}%`,
    `│ velocity    : ${s.tradeCountInWindow}/${cfg.velocityMaxTrades} in ${s.velocityWindowSeconds}s`,
    `│ config ver  : ${s.configVersion}`,
  ];
  for (const [sym, p] of Object.entries(s.perSymbol)) {
    lines.push(`│ ${sym.padEnd(9)}: net ${p.netQuantity}  last ${p.lastTradeQty}${p.lastTradeWasLoss ? "  (last=loss)" : ""}`);
  }
  lines.push(`└────────────────────────────────────────────────`);
  return lines.join("\n");
}
