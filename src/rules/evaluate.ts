/**
 * The decision pipeline (ARCHITECTURE §6). FIXED ORDER (D-3):
 *   (0) kill-switch short-circuit
 *   (1) data-availability   -> DATA_UNAVAILABLE
 *   (2) drawdown            -> DRAWDOWN_BREACH
 *   (3) velocity            -> VELOCITY_EXCEEDED
 *   (4) ladder              -> LADDER_DETECTED
 * Evaluation stops at the first failing rule, so exactly one BlockCode is ever
 * returned (P-4). Rules are pure functions of a frozen RuleContext — all I/O
 * (market + account reads) happens here, before any rule runs.
 */
import { BlockCode, RefusalCode } from "../domain/blockCode.js";
import type {
  Decision,
  MarketSnapshot,
  RuleResult,
  Session,
  StateSnapshot,
  Ticket,
} from "../domain/types.js";
import type { LedgerStore } from "../state/ledger.js";
import type { SessionStore } from "../state/sessionStore.js";
import type { MarketReader } from "../market/marketReader.js";
import type { AccountReader } from "../market/accountReader.js";
import { computePnl, type PnlResult } from "../state/pnl.js";
import { countInWindow } from "../state/velocityWindow.js";
import type { RuleContext, RuleFn } from "./context.js";
import { dataAvailabilityRule } from "./dataAvailability.js";
import { drawdownRule } from "./drawdown.js";
import { velocityRule } from "./velocity.js";
import { ladderRule } from "./ladder.js";

/** The fixed pipeline order — exported so a test can assert it structurally (EV-7). */
export const RULE_PIPELINE: RuleFn[] = [dataAvailabilityRule, drawdownRule, velocityRule, ladderRule];

export interface EvaluateDeps {
  sessionStore: SessionStore;
  ledger: LedgerStore;
  marketReader: MarketReader;
  accountReader: AccountReader;
  now?: () => Date;
}

function buildSnapshot(
  session: Session,
  pnl: PnlResult,
  tradeCountInWindow: number,
  ledgerPositions: Record<string, { netQuantity: string; lastTradeQty: string; lastTradeWasLoss: boolean }>,
): StateSnapshot {
  return {
    runningPnlUsdt: pnl.runningPnlUsdt,
    realizedPnlUsdt: pnl.realizedPnlUsdt,
    unrealizedPnlUsdt: pnl.unrealizedPnlUsdt,
    drawdownPct: pnl.drawdownPct,
    tradeCountInWindow,
    velocityWindowSeconds: session.config.velocityWindowSeconds,
    perSymbol: ledgerPositions,
    killSwitch: session.status,
    haltReason: session.haltReason,
    configVersion: session.configVersion,
  };
}

function zeroSnapshot(session: Session): StateSnapshot {
  return {
    runningPnlUsdt: "0",
    realizedPnlUsdt: "0",
    unrealizedPnlUsdt: "0",
    drawdownPct: "0",
    tradeCountInWindow: 0,
    velocityWindowSeconds: session.config.velocityWindowSeconds,
    perSymbol: {},
    killSwitch: session.status,
    haltReason: session.haltReason,
    configVersion: session.configVersion,
  };
}

export interface EvaluateResult {
  decision: Decision;
  /** true when the pipeline says forward this call to the upstream */
  forward: boolean;
}

export async function evaluate(ticket: Ticket, deps: EvaluateDeps): Promise<EvaluateResult> {
  const session = deps.sessionStore.current();
  const nowIso = (deps.now?.() ?? new Date()).toISOString();

  // (0) kill-switch — no reads, no rules
  if (session.status === "HALTED") {
    const code = session.haltReason ?? BlockCode.DATA_UNAVAILABLE;
    const rr: RuleResult = {
      rule: "KILL_SWITCH",
      pass: false,
      code,
      observed: "HALTED",
      threshold: "ACTIVE",
      detail: `Session halted (${code}). Re-arm required.`,
    };
    return {
      forward: false,
      decision: {
        ticketId: ticket.ticketId,
        sessionId: session.sessionId,
        decidedAt: nowIso,
        outcome: "BLOCKED",
        code,
        ruleResults: [rr],
        stateSnapshot: zeroSnapshot(session),
      },
    };
  }

  // scope refusal — not a risk halt (RefusalCode, not BlockCode)
  if (!session.config.allowedSymbols.includes(ticket.symbol)) {
    return {
      forward: false,
      decision: {
        ticketId: ticket.ticketId,
        sessionId: session.sessionId,
        decidedAt: nowIso,
        outcome: "BLOCKED",
        code: null,
        refusal: RefusalCode.SYMBOL_NOT_WHITELISTED,
        ruleResults: [],
        stateSnapshot: zeroSnapshot(session),
      },
    };
  }

  // fresh reads — every call, never cached (P-3)
  const ledgerSnap = deps.ledger.snapshot();
  const market: Record<string, MarketSnapshot> = {};
  const symbols = new Set<string>([ticket.symbol, ...Object.keys(ledgerSnap.positions)]);
  for (const sym of symbols) market[sym] = await deps.marketReader.get(sym);
  const account = await deps.accountReader.balances();

  const pnl = computePnl(ledgerSnap, market, session.startingEquity);
  const tradeCountInWindow = countInWindow(
    session.tradeTimestamps,
    nowIso,
    session.config.velocityWindowSeconds,
  );

  const ctx: RuleContext = Object.freeze({
    ticket,
    session,
    config: session.config,
    ledger: ledgerSnap,
    market,
    account,
    pnl,
    tradeCountInWindow,
    now: nowIso,
  });

  const perSymbol: StateSnapshot["perSymbol"] = {};
  for (const [sym, p] of Object.entries(ledgerSnap.positions)) {
    perSymbol[sym] = {
      netQuantity: p.netQuantity,
      lastTradeQty: p.lastTradeQty,
      lastTradeWasLoss: p.lastTradeWasLoss,
    };
  }
  const snapshot = buildSnapshot(session, pnl, tradeCountInWindow, perSymbol);

  const results: RuleResult[] = [];
  for (const rule of RULE_PIPELINE) {
    const r = rule(ctx);
    results.push(r);
    if (!r.pass) {
      deps.sessionStore.halt(r.code!, r.detail);
      return {
        forward: false,
        decision: {
          ticketId: ticket.ticketId,
          sessionId: session.sessionId,
          decidedAt: nowIso,
          outcome: "BLOCKED",
          code: r.code!,
          ruleResults: results,
          stateSnapshot: { ...snapshot, killSwitch: "HALTED", haltReason: r.code! },
        },
      };
    }
  }

  return {
    forward: true,
    decision: {
      ticketId: ticket.ticketId,
      sessionId: session.sessionId,
      decidedAt: nowIso,
      outcome: "ALLOWED",
      code: null,
      ruleResults: results,
      stateSnapshot: snapshot,
    },
  };
}
