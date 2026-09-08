/**
 * Account balance reads (PRD Step 4 wiring; hardened in Step 7a). Fail-closed on
 * error/timeout/missing quote asset (P-3). `snapshotStartingEquity` is taken
 * once at arm time — a session cannot arm without a baseline (D-8).
 */
import { Decimal } from "../domain/decimal.js";
import type { AccountSnapshot, Config, ToolCatalog } from "../domain/types.js";
import type { UpstreamClient } from "../mcp/upstreamClient.js";
import { payloadOf } from "../state/fillParser.js";
import { TimeoutError, errMsg, withTimeout } from "../util/timeout.js";

const QUOTE = "USDT";

export interface AccountReader {
  balances(): Promise<AccountSnapshot>;
  snapshotStartingEquity(): Promise<string>;
}

function unavailable(reason: string): AccountSnapshot {
  return { fetchedAt: new Date().toISOString(), balances: {}, equityUsdt: "0", stale: false, ok: false, reason };
}

interface RawBal {
  asset?: unknown;
  free?: unknown;
  locked?: unknown;
}

export function createAccountReader(deps: {
  upstream: UpstreamClient;
  catalog: ToolCatalog;
  config: Config;
}): AccountReader {
  const tool = deps.catalog.map["account.balances"];

  async function read(): Promise<AccountSnapshot> {
    if (!tool) return unavailable("no account.balances capability resolved");
    let payload: Record<string, unknown> | null;
    try {
      const res = await withTimeout(
        deps.upstream.callTool(tool, {}),
        deps.config.dataFetchTimeoutMs,
        "account.balances",
      );
      payload = payloadOf(res);
    } catch (e) {
      return unavailable(e instanceof TimeoutError ? "timeout" : `error: ${errMsg(e)}`);
    }
    if (!payload) return unavailable("unparseable account response");

    const arr: RawBal[] = Array.isArray(payload["balances"])
      ? (payload["balances"] as RawBal[])
      : Array.isArray(payload)
        ? (payload as RawBal[])
        : [];
    if (arr.length === 0) return unavailable("no balances in account response");

    const balances: Record<string, string> = {};
    for (const b of arr) {
      const asset = String(b.asset ?? "");
      if (!asset) continue;
      let total: Decimal;
      try {
        total = new Decimal(String(b.free ?? "0")).plus(new Decimal(String(b.locked ?? "0")));
      } catch {
        return unavailable(`balance for ${asset} not numeric`);
      }
      balances[asset] = total.toFixed();
    }
    if (balances[QUOTE] === undefined) return unavailable(`quote asset ${QUOTE} missing from balances`);

    return {
      fetchedAt: new Date().toISOString(),
      balances,
      equityUsdt: balances[QUOTE],
      stale: false,
      ok: true,
    };
  }

  return {
    balances: read,
    async snapshotStartingEquity(): Promise<string> {
      const s = await read();
      if (!s.ok) throw new Error(`cannot snapshot starting equity: ${s.reason}`);
      return s.equityUsdt;
    },
  };
}
