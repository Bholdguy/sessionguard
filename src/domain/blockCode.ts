/**
 * The four named block codes (PRD §4.2). Every rejection carries EXACTLY ONE of
 * these as its primary signal — never a free-text reason string (PRD P-4).
 */
export enum BlockCode {
  /** cumulative session P&L crossed the configured drawdown % */
  DRAWDOWN_BREACH = "DRAWDOWN_BREACH",
  /** trade count in the rolling window exceeded the configured limit */
  VELOCITY_EXCEEDED = "VELOCITY_EXCEEDED",
  /** position size increased after a loss on the same symbol beyond the configured multiple */
  LADDER_DETECTED = "LADDER_DETECTED",
  /** market price or account state could not be read fresh; fail closed, no trade */
  DATA_UNAVAILABLE = "DATA_UNAVAILABLE",
}

/**
 * Non-risk refusals. Deliberately a SEPARATE enum: a scope refusal or a
 * not-armed proxy is not a session-risk halt and must never be conflated with
 * the four BlockCodes in metrics or the demo narrative (PRD §4.2).
 */
export enum RefusalCode {
  /** agent tried a tool outside the ToolCatalog (transfer / withdraw / futures / margin) */
  UNSUPPORTED_TOOL = "UNSUPPORTED_TOOL",
  /** symbol outside config.allowedSymbols */
  SYMBOL_NOT_WHITELISTED = "SYMBOL_NOT_WHITELISTED",
  /** no active session */
  SESSION_NOT_ARMED = "SESSION_NOT_ARMED",
}

export const ALL_BLOCK_CODES: readonly BlockCode[] = Object.freeze([
  BlockCode.DRAWDOWN_BREACH,
  BlockCode.VELOCITY_EXCEEDED,
  BlockCode.LADDER_DETECTED,
  BlockCode.DATA_UNAVAILABLE,
]);
