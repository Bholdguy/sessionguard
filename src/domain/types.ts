/**
 * Core interfaces (PRD §9). Money / price / quantity / P&L fields are decimal
 * STRINGS (see domain/decimal.ts). `number` is used only for integer counts,
 * timestamps-as-ms, and config windows.
 */
import type { BlockCode, RefusalCode } from "./blockCode.js";
import type { DecimalString } from "./decimal.js";

export type Side = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT";

// ─────────────────────────────────────────────────────────────────────────────
// 9.1 Ticket — an intercepted trade proposal
// ─────────────────────────────────────────────────────────────────────────────
export interface Ticket {
  ticketId: string; // uuid, assigned by SessionGuard at intercept
  sessionId: string;
  receivedAt: string; // ISO-8601 UTC
  toolName: string; // resolved logical capability, e.g. "trade.placeOrder"
  upstreamToolName: string; // concrete Binance tool name from ToolCatalog
  symbol: string;
  side: Side;
  type: OrderType;
  quantity: DecimalString | null; // base asset (null if quoteOrderQty used)
  quoteOrderQty: DecimalString | null; // quote asset (null if quantity used)
  price: DecimalString | null; // for LIMIT, null for MARKET
  timeInForce: string | null;
  rawParams: Record<string, unknown>; // verbatim args from the agent; NEVER mutated before forwarding
}

// ─────────────────────────────────────────────────────────────────────────────
// 9.2 Fill — a realized execution
// ─────────────────────────────────────────────────────────────────────────────
export interface Fill {
  fillId: string;
  sessionId: string;
  ticketId: string;
  symbol: string;
  side: Side;
  price: DecimalString; // actual execution price
  quantity: DecimalString; // base asset filled
  quoteQuantity: DecimalString; // = price * quantity
  commission: DecimalString;
  commissionAsset: string;
  timestamp: string; // ISO-8601 UTC from exchange transactTime
  raw: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9.3 SymbolPosition — per-symbol position and trend
// ─────────────────────────────────────────────────────────────────────────────
export interface SymbolPosition {
  symbol: string;
  netQuantity: DecimalString; // signed (+ long, - short); spot stays >= 0 in practice
  avgEntryPrice: DecimalString; // average cost of the open position
  realizedPnl: DecimalString; // quote asset (USDT), cumulative for this symbol
  lastTradeQty: DecimalString; // abs base qty of the most recent fill on this symbol
  lastRealizedDelta: DecimalString; // realized-P&L change from the most recent fill
  lastTradeWasLoss: boolean; // lastRealizedDelta < 0
  lastTradeSide: Side | null;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9.4 Ledger — append-only fills + derived positions
// ─────────────────────────────────────────────────────────────────────────────
export interface Ledger {
  sessionId: string;
  fills: Fill[]; // append-only; never edited or reordered
  positions: Record<string, SymbolPosition>; // keyed by symbol
  realizedPnl: DecimalString; // sum over symbols, USDT
  totalCommission: DecimalString; // USDT-equivalent
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9.5 Market and account snapshots
// ─────────────────────────────────────────────────────────────────────────────
export interface MarketSnapshot {
  symbol: string;
  markPrice: DecimalString; // > 0 when ok
  fetchedAt: string; // ISO-8601 UTC
  source: "mcp:market.price" | "mcp:market.klines" | "none";
  stale: boolean; // now - fetchedAt > config.priceStalenessSeconds
  ok: boolean; // fetch succeeded and payload validated
  reason?: string; // diagnostic only when !ok / stale — never the deciding signal
}

export interface AccountSnapshot {
  fetchedAt: string;
  balances: Record<string, DecimalString>; // asset -> (free + locked)
  equityUsdt: DecimalString;
  stale: boolean;
  ok: boolean;
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9.6 Rules, decision
// ─────────────────────────────────────────────────────────────────────────────
export type RuleName = "KILL_SWITCH" | "DATA_AVAILABILITY" | "DRAWDOWN" | "VELOCITY" | "LADDER";

export interface RuleResult {
  rule: RuleName;
  pass: boolean;
  code: BlockCode | null; // set iff pass === false
  observed: string; // code-computed evidence, e.g. "-6.2" or "6" (NEVER from an LLM)
  threshold: string; // e.g. "-5" or "5"
  detail: string; // templated string; secondary to `code` (P-4)
}

export type DecisionOutcome = "ALLOWED" | "BLOCKED";

export interface Decision {
  ticketId: string;
  sessionId: string;
  decidedAt: string;
  outcome: DecisionOutcome;
  code: BlockCode | null; // set iff outcome === "BLOCKED"; exactly one code
  refusal?: RefusalCode; // set when the call was refused pre-rules (not a risk halt)
  ruleResults: RuleResult[]; // fixed order; stops at the first failing rule
  stateSnapshot: StateSnapshot;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9.7 Session, config, audit, tool catalog
// ─────────────────────────────────────────────────────────────────────────────
export type SessionStatus = "ACTIVE" | "HALTED";

export interface Session {
  sessionId: string;
  startedAt: string;
  startingEquity: DecimalString; // USDT, snapshot at arm time
  status: SessionStatus;
  haltReason: BlockCode | null;
  haltedAt: string | null;
  haltDetail: string | null; // human-readable; not the source of any deciding number
  config: Config;
  configVersion: number;
  tradeTimestamps: string[]; // ISO-8601 of ALLOWED + forwarded trades (velocity window input)
}

export interface Config {
  drawdownPctLimit: DecimalString; // > 0  (e.g. "5" means halt at -5%)
  velocityWindowSeconds: number; // int > 0
  velocityMaxTrades: number; // int > 0
  ladderMultipleLimit: DecimalString; // >= 1
  allowedSymbols: string[]; // non-empty subset of the three demo symbols
  priceStalenessSeconds: number; // int > 0
  dataFetchTimeoutMs: number; // int > 0
  priceSanityMaxDeviationPct: DecimalString; // mark vs recent klines close; beyond this => DATA_UNAVAILABLE
}

export interface StateSnapshot {
  runningPnlUsdt: DecimalString; // realized + unrealized
  realizedPnlUsdt: DecimalString;
  unrealizedPnlUsdt: DecimalString;
  drawdownPct: DecimalString; // negative = loss
  tradeCountInWindow: number;
  velocityWindowSeconds: number;
  perSymbol: Record<
    string,
    { netQuantity: DecimalString; lastTradeQty: DecimalString; lastTradeWasLoss: boolean }
  >;
  killSwitch: SessionStatus;
  haltReason: BlockCode | null;
  configVersion: number;
}

export type AuditCallType = "SESSION_START" | "TOOL_CALL" | "CONFIG_CHANGE" | "RESET";

export interface AuditLogEntry {
  logId: number; // monotonic, per session
  sessionId: string;
  timestamp: string;
  callType: AuditCallType;
  toolName: string | null;
  outcome: DecisionOutcome | null;
  code: BlockCode | null;
  refusal?: RefusalCode | null;
  ruleResults: RuleResult[];
  stateSnapshot: StateSnapshot;
  forwardedResponseDigest: string | null; // sha256 + {fillPrice, fillQty}; not the full payload
  meta?: Record<string, unknown>; // SESSION_START: resolved ToolCatalog; CONFIG_CHANGE: {from,to}
}

export type LogicalTool =
  | "market.price"
  | "market.klines"
  | "account.balances"
  | "account.trades"
  | "trade.placeOrder"
  | "trade.testOrder"
  | "trade.queryOrder"
  | "trade.openOrders";

export interface ToolCatalog {
  resolvedAt: string;
  map: Partial<Record<LogicalTool, string>>; // logical -> concrete Binance tool name
  rawList: Array<{ name: string; description?: string; inputSchema: unknown }>;
  excluded: Array<{ name: string; why: string }>; // transfer/withdraw/futures/margin
}

/** Required logical capabilities — boot fails closed if any is unresolved (D-1). */
export const REQUIRED_LOGICAL_TOOLS: readonly LogicalTool[] = Object.freeze([
  "market.price",
  "account.balances",
  "trade.placeOrder",
]);

/** Optional — a warning + disabled hardening if unresolved (D-1). */
export const OPTIONAL_LOGICAL_TOOLS: readonly LogicalTool[] = Object.freeze([
  "market.klines",
  "account.trades",
  "trade.testOrder",
  "trade.queryOrder",
  "trade.openOrders",
]);
