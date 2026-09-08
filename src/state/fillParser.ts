/**
 * Parse fills out of a place-order MCP response (Step 3). Handles: fills array,
 * multi-fill, thin FILLED response (synthesize from executed/quote totals).
 * Returns [] + `resolved:false` when the response carries no usable fill data —
 * the caller then queries the order or fails closed (never invents a fill).
 */
import { randomUUID } from "node:crypto";
import { Decimal } from "../domain/decimal.js";
import type { Fill, Ticket } from "../domain/types.js";

interface RawFill {
  price?: unknown;
  qty?: unknown;
  quantity?: unknown;
  commission?: unknown;
  commissionAsset?: unknown;
  tradeId?: unknown;
}
interface RawOrder {
  symbol?: unknown;
  side?: unknown;
  status?: unknown;
  executedQty?: unknown;
  cummulativeQuoteQty?: unknown;
  cumulativeQuoteQty?: unknown;
  transactTime?: unknown;
  fills?: unknown;
}

/** Pull the JSON payload out of an MCP CallToolResult ({content:[{type:"text",text}]}). */
export function payloadOf(mcpResult: unknown): Record<string, unknown> | null {
  const r = mcpResult as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };
  if (r && typeof r === "object" && r.structuredContent && typeof r.structuredContent === "object") {
    return r.structuredContent as Record<string, unknown>;
  }
  const text = r?.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface ParsedFills {
  fills: Fill[];
  resolved: boolean; // false => response had no usable fill data
}

export function parsePlaceOrderFills(mcpResult: unknown, ticket: Ticket): ParsedFills {
  const p = payloadOf(mcpResult) as RawOrder | null;
  if (!p) return { fills: [], resolved: false };

  const symbol = String(p.symbol ?? ticket.symbol);
  const side = String(p.side ?? ticket.side).toUpperCase() === "SELL" ? "SELL" : "BUY";
  const ts = p.transactTime ? new Date(Number(p.transactTime)).toISOString() : new Date().toISOString();

  const rawFills = Array.isArray(p.fills) ? (p.fills as RawFill[]) : [];
  const mk = (price: string, qty: string, commission: string, commissionAsset: string, tradeId: string): Fill => {
    const q = new Decimal(qty);
    const px = new Decimal(price);
    return {
      fillId: tradeId || randomUUID(),
      sessionId: ticket.sessionId,
      ticketId: ticket.ticketId,
      symbol,
      side,
      price: px.toFixed(),
      quantity: q.toFixed(),
      quoteQuantity: px.times(q).toFixed(),
      commission: new Decimal(commission || "0").toFixed(),
      commissionAsset: commissionAsset || "USDT",
      timestamp: ts,
      raw: {},
    };
  };

  if (rawFills.length > 0) {
    const fills = rawFills
      .map((f) => {
        const price = f.price != null ? String(f.price) : null;
        const qty = f.qty != null ? String(f.qty) : f.quantity != null ? String(f.quantity) : null;
        if (!price || !qty) return null;
        return mk(
          price,
          qty,
          f.commission != null ? String(f.commission) : "0",
          f.commissionAsset != null ? String(f.commissionAsset) : "USDT",
          f.tradeId != null ? String(f.tradeId) : "",
        );
      })
      .filter((x): x is Fill => x !== null);
    if (fills.length > 0) return { fills, resolved: true };
  }

  // thin FILLED response — synthesize one fill from the totals
  const status = String(p.status ?? "").toUpperCase();
  const execQty = p.executedQty != null ? String(p.executedQty) : null;
  const quote =
    p.cummulativeQuoteQty != null
      ? String(p.cummulativeQuoteQty)
      : p.cumulativeQuoteQty != null
        ? String(p.cumulativeQuoteQty)
        : null;
  if (status === "FILLED" && execQty && quote && new Decimal(execQty).gt(0)) {
    const avg = new Decimal(quote).div(execQty);
    return { fills: [mk(avg.toFixed(), execQty, "0", "USDT", "")], resolved: true };
  }

  return { fills: [], resolved: false };
}
