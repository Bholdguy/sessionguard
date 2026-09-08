import { randomUUID } from "node:crypto";
import type { OrderType, Side, Ticket } from "../domain/types.js";

/**
 * Build a Ticket from raw agent args using a FIXED param allow-list.
 * `rawParams` keeps the exact object reference the agent sent — it is forwarded
 * verbatim and MUST NOT be mutated anywhere (PRD §9.1, SECURITY §1).
 */
export function buildTicket(p: {
  sessionId: string;
  logicalName: string;
  upstreamToolName: string;
  args: Record<string, unknown>;
}): Ticket {
  const a = p.args;
  const str = (k: string): string | null =>
    a[k] === undefined || a[k] === null ? null : String(a[k]);

  const side = String(a["side"] ?? "").toUpperCase();
  const type = String(a["type"] ?? "MARKET").toUpperCase();

  return {
    ticketId: randomUUID(),
    sessionId: p.sessionId,
    receivedAt: new Date().toISOString(),
    toolName: p.logicalName,
    upstreamToolName: p.upstreamToolName,
    symbol: String(a["symbol"] ?? ""),
    side: (side === "SELL" ? "SELL" : "BUY") as Side,
    type: (type === "LIMIT" ? "LIMIT" : "MARKET") as OrderType,
    quantity: str("quantity"),
    quoteOrderQty: str("quoteOrderQty"),
    price: str("price"),
    timeInForce: str("timeInForce"),
    rawParams: a,
  };
}
