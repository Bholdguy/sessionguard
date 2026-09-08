/**
 * Boot-time tool discovery (D-1). Binance does not publish literal MCP tool
 * names, so SessionGuard resolves a fixed set of LOGICAL capabilities from the
 * upstream tools/list at boot. Hard timeout; on timeout or any unresolved
 * REQUIRED capability -> one clear error, exit non-zero. No retry loop, no hang.
 *
 * transfer / withdraw / futures / margin tools are deliberately EXCLUDED from
 * the resolved map (D-2, D-6, SECURITY.md §5).
 */
import {
  OPTIONAL_LOGICAL_TOOLS,
  REQUIRED_LOGICAL_TOOLS,
  type LogicalTool,
  type ToolCatalog,
} from "../domain/types.js";
import type { UpstreamClient, UpstreamTool } from "./upstreamClient.js";
import { TimeoutError, errMsg, withTimeout } from "../util/timeout.js";

/** A tool whose name/description matches any of these is never put in the map. */
// prettier-ignore
export const EXCLUDE_PATTERN = /withdraw|withdrawal|transfer|futures|fapi|dapi|delivery|margin|leverage|coin[_-]?m|usd[ts]?[_-]?m/i; // EXCLUDE_PATTERN: keeps these off the resolved map (D-6)

/** Ordered candidate name/description patterns per logical capability. First match wins. */
export const CANDIDATE_PATTERNS: Record<LogicalTool, RegExp[]> = {
  "market.price": [/(^|_)price$/i, /ticker.*price/i, /price.*ticker/i, /get_?price/i, /symbol_?price/i],
  "market.klines": [/kline/i, /candle/i, /ohlc/i],
  "account.balances": [/balance/i, /account_?info/i, /get_?account/i, /wallet_?balance/i],
  "account.trades": [/my_?trades/i, /account_?trades/i, /trade_?history/i, /execution/i],
  "trade.placeOrder": [/place_?order/i, /new_?order/i, /create_?order/i, /submit_?order/i, /spot_?order/i],
  "trade.testOrder": [/test_?order/i, /order_?test/i, /dry_?run/i],
  "trade.queryOrder": [/query_?order/i, /get_?order/i, /order_?status/i, /^order$/i],
  "trade.openOrders": [/open_?orders/i, /current_?orders/i, /pending_?orders/i],
};

function matches(tool: UpstreamTool, pats: RegExp[]): boolean {
  const hay = `${tool.name}\n${tool.description ?? ""}`;
  return pats.some((p) => p.test(hay));
}

export function resolveToolCatalog(
  rawList: UpstreamTool[],
  now: Date = new Date(),
): { catalog: ToolCatalog; missingRequired: LogicalTool[] } {
  const excluded: ToolCatalog["excluded"] = [];
  const candidatePool: UpstreamTool[] = [];
  for (const t of rawList) {
    if (EXCLUDE_PATTERN.test(`${t.name} ${t.description ?? ""}`)) {
      excluded.push({ name: t.name, why: "matched transfer/withdraw/futures/margin exclusion" });
    } else {
      candidatePool.push(t);
    }
  }

  const map: Partial<Record<LogicalTool, string>> = {};
  const allLogical: LogicalTool[] = [...REQUIRED_LOGICAL_TOOLS, ...OPTIONAL_LOGICAL_TOOLS];
  for (const logical of allLogical) {
    const hit = candidatePool.find((t) => matches(t, CANDIDATE_PATTERNS[logical]));
    if (hit) map[logical] = hit.name;
  }

  const missingRequired = REQUIRED_LOGICAL_TOOLS.filter((l) => !map[l]);

  const catalog: ToolCatalog = {
    resolvedAt: now.toISOString(),
    map,
    rawList,
    excluded,
  };
  return { catalog, missingRequired };
}

export interface ResolveOptions {
  timeoutMs: number;
  upstreamLabel: string;
  /** injectable for tests; defaults to process.exit */
  exit?: (code: number) => never;
  log?: (line: string) => void;
}

export async function resolveOrExit(
  client: UpstreamClient,
  opts: ResolveOptions,
): Promise<ToolCatalog> {
  const exit = opts.exit ?? ((c: number) => process.exit(c));
  const log = opts.log ?? ((l: string) => console.error(l));

  let rawList: UpstreamTool[];
  try {
    rawList = await withTimeout(
      client.listTools(),
      opts.timeoutMs,
      `tools/list against ${opts.upstreamLabel}`,
    );
  } catch (e) {
    if (e instanceof TimeoutError) {
      log(
        `FATAL: tools/list timed out after ${opts.timeoutMs}ms against ${opts.upstreamLabel} ` +
          `— cannot resolve tool catalog. Exiting.`,
      );
    } else {
      log(`FATAL: tools/list failed against ${opts.upstreamLabel}: ${errMsg(e)}. Exiting.`);
    }
    return exit(1);
  }

  const { catalog, missingRequired } = resolveToolCatalog(rawList);
  if (missingRequired.length > 0) {
    const l = missingRequired[0]!;
    const tried = CANDIDATE_PATTERNS[l].map((p) => p.source).join(", ");
    log(
      `FATAL: required capability "${l}" did not match any upstream tool ` +
        `(patterns tried: ${tried}). Exiting.`,
    );
    return exit(1);
  }

  const missingOptional = OPTIONAL_LOGICAL_TOOLS.filter((l) => !catalog.map[l]);
  if (missingOptional.length > 0) {
    log(
      `WARN: optional capabilities unresolved: ${missingOptional.join(", ")} ` +
        `— related hardening disabled, continuing.`,
    );
  }
  log(
    `ToolCatalog resolved: ${Object.keys(catalog.map).length}/${
      REQUIRED_LOGICAL_TOOLS.length + OPTIONAL_LOGICAL_TOOLS.length
    } capabilities (${REQUIRED_LOGICAL_TOOLS.length}/${REQUIRED_LOGICAL_TOOLS.length} required). ` +
      `Excluded ${catalog.excluded.length} transfer/withdraw/futures/margin tools.`,
  );
  return catalog;
}

/** logical name for a concrete upstream tool name, or null if not in the map. */
export function logicalFor(catalog: ToolCatalog, upstreamName: string): LogicalTool | null {
  for (const [logical, concrete] of Object.entries(catalog.map)) {
    if (concrete === upstreamName) return logical as LogicalTool;
  }
  return null;
}
