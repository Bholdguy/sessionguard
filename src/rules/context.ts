import type {
  AccountSnapshot,
  Config,
  Ledger,
  MarketSnapshot,
  RuleResult,
  Session,
  Ticket,
} from "../domain/types.js";
import type { PnlResult } from "../state/pnl.js";

export interface RuleContext {
  ticket: Ticket;
  session: Session;
  config: Config;
  ledger: Ledger;
  /** fresh reads for the ticket symbol + every other open-position symbol */
  market: Record<string, MarketSnapshot>;
  account: AccountSnapshot;
  pnl: PnlResult;
  tradeCountInWindow: number;
  now: string; // ISO-8601
}

export type RuleFn = (ctx: RuleContext) => RuleResult;

export function pass(rule: RuleResult["rule"], observed: string, threshold: string, detail: string): RuleResult {
  return { rule, pass: true, code: null, observed, threshold, detail };
}
