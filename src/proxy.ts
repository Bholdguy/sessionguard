/**
 * The dominant mechanism (PRD §1.2). For a trade-placement call:
 *   intercept -> build Ticket -> evaluate (fixed-order rules) ->
 *   forward-or-block -> parse fills into the ledger -> record for velocity ->
 *   audit row + receipt.
 * Read-only tools (price, balances, query/open orders) are forwarded directly;
 * they are not session-risk events. Excluded tools are already refused upstream
 * in inboundServer.
 */
import type { LogicalTool, ToolCatalog } from "./domain/types.js";
import type { UpstreamClient } from "./mcp/upstreamClient.js";
import type { ToolCallOutcome } from "./mcp/inboundServer.js";
import { buildTicket } from "./mcp/ticket.js";
import { forward } from "./mcp/passthrough.js";
import { evaluate, type EvaluateDeps } from "./rules/evaluate.js";
import { parsePlaceOrderFills } from "./state/fillParser.js";
import { blockedToolResult } from "./audit/receipt.js";
import { AuditLog, digestResponse } from "./audit/auditLog.js";
import type { LedgerStore } from "./state/ledger.js";
import type { SessionStore } from "./state/sessionStore.js";

export interface ProxyDeps extends EvaluateDeps {
  upstream: UpstreamClient;
  catalog: ToolCatalog;
  audit: AuditLog;
  sessionStore: SessionStore;
  ledger: LedgerStore;
  queryOrderTool?: string | undefined;
  now?: () => Date;
}

const TRADE_PLACE: LogicalTool = "trade.placeOrder";

export function createToolCallHandler(deps: ProxyDeps) {
  return async function onToolCall(params: {
    upstreamToolName: string;
    logicalName: string | null;
    args: Record<string, unknown>;
  }): Promise<ToolCallOutcome> {
    // read-only / non-order tools: forward directly, no rule evaluation
    if (params.logicalName !== TRADE_PLACE) {
      return { result: await forward(deps.upstream, params.upstreamToolName, params.args) };
    }

    const session = deps.sessionStore.current();
    const ticket = buildTicket({
      sessionId: session.sessionId,
      logicalName: TRADE_PLACE,
      upstreamToolName: params.upstreamToolName,
      args: params.args,
    });

    const { decision, forward: doForward } = await evaluate(ticket, deps);

    if (!doForward) {
      deps.audit.toolCall(decision, params.upstreamToolName, null);
      return { result: blockedToolResult(decision) };
    }

    // ALLOWED — forward verbatim, capture the upstream response unmodified (INV-9)
    let upstreamResult: unknown;
    let digest: string | null = null;
    await forward(deps.upstream, params.upstreamToolName, params.args, {
      onResult: async (_tool, _args, result) => {
        upstreamResult = result;
        let parsed = parsePlaceOrderFills(result, ticket);
        if (!parsed.resolved && deps.queryOrderTool) {
          try {
            const q = await deps.upstream.callTool(deps.queryOrderTool, {
              symbol: ticket.symbol,
              orderId: (result as { orderId?: unknown })?.orderId ?? undefined,
            });
            parsed = parsePlaceOrderFills(q, ticket);
          } catch {
            /* leave unresolved — recorded below, fee stays unbooked deliberately */
          }
        }
        for (const f of parsed.fills) deps.ledger.applyFill(f);
        digest = digestResponse(result, parsed.fills.map((f) => ({ price: f.price, quantity: f.quantity })));
      },
    });

    // a forwarded+executed trade counts toward the velocity window (INV-7)
    deps.sessionStore.recordTrade((deps.now?.() ?? new Date()).toISOString());
    deps.audit.toolCall(decision, params.upstreamToolName, digest);

    return { result: upstreamResult ?? { content: [{ type: "text", text: "{}" }] } };
  };
}
