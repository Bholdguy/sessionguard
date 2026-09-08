/**
 * Wire-up (ARCHITECTURE §3). Boot sequence, all fail-closed:
 *   config -> upstream connect -> tools/list resolve (hard timeout) ->
 *   starting-equity snapshot -> arm session -> SESSION_START audit row.
 * Returns the pieces the inbound server, admin server, dashboard, and the
 * scenario/baseline runners all share.
 */
import type { Config, StateSnapshot, ToolCatalog } from "./domain/types.js";
import { createUpstreamClient, type UpstreamClient } from "./mcp/upstreamClient.js";
import { resolveOrExit } from "./mcp/toolCatalog.js";
import { createMarketReader, type MarketReader } from "./market/marketReader.js";
import { createAccountReader, type AccountReader } from "./market/accountReader.js";
import { SessionStore } from "./state/sessionStore.js";
import { LedgerStore } from "./state/ledger.js";
import { AuditLog } from "./audit/auditLog.js";
import { createToolCallHandler } from "./proxy.js";
import { createInboundServer } from "./mcp/inboundServer.js";
import { liveSnapshot } from "./view/stateView.js";

export interface AppOptions {
  mcpUrl: string;
  bearerToken?: string | undefined;
  nodeEnv?: string | undefined;
  config: Config;
  configVersion: number;
  evidenceDir: string;
  toolsListTimeoutMs: number;
  now?: () => Date;
  exit?: (code: number) => never;
  log?: (line: string) => void;
}

export interface App {
  upstream: UpstreamClient;
  catalog: ToolCatalog;
  sessionStore: SessionStore;
  ledger: LedgerStore;
  audit: AuditLog;
  marketReader: MarketReader;
  accountReader: AccountReader;
  inboundServer: ReturnType<typeof createInboundServer>;
  onToolCall: ReturnType<typeof createToolCallHandler>;
  snapshot: () => Promise<StateSnapshot>;
  close: () => Promise<void>;
}

export async function createApp(opts: AppOptions): Promise<App> {
  const log = opts.log ?? ((l: string) => console.error(l));

  const upstream = createUpstreamClient({
    url: opts.mcpUrl,
    bearerToken: opts.bearerToken,
    nodeEnv: opts.nodeEnv,
  });
  await upstream.connect();

  const catalog = await resolveOrExit(upstream, {
    timeoutMs: opts.toolsListTimeoutMs,
    upstreamLabel: opts.mcpUrl,
    ...(opts.exit ? { exit: opts.exit } : {}),
    log,
  });

  const marketReader = createMarketReader({
    upstream,
    catalog,
    config: opts.config,
    ...(opts.now ? { now: () => opts.now!().getTime() } : {}),
  });
  const accountReader = createAccountReader({ upstream, catalog, config: opts.config });

  const startingEquity = await accountReader.snapshotStartingEquity(); // throws => boot fails closed

  const sessionStore = new SessionStore(opts.config, opts.configVersion);
  const session = sessionStore.arm(startingEquity);

  const ledger = new LedgerStore(session.sessionId);
  const audit = new AuditLog(opts.evidenceDir, session.sessionId);
  audit.sessionStart(session, catalog);

  const onToolCall = createToolCallHandler({
    upstream,
    catalog,
    audit,
    sessionStore,
    ledger,
    marketReader,
    accountReader,
    queryOrderTool: catalog.map["trade.queryOrder"],
    ...(opts.now ? { now: opts.now } : {}),
  });

  const inboundServer = createInboundServer({ catalog, onToolCall });

  log(`session ${session.sessionId} ACTIVE  starting equity ${startingEquity} USDT`);

  return {
    upstream,
    catalog,
    sessionStore,
    ledger,
    audit,
    marketReader,
    accountReader,
    inboundServer,
    onToolCall,
    snapshot: () =>
      liveSnapshot({ sessionStore, ledger, marketReader, ...(opts.now ? { now: opts.now } : {}) }),
    close: async () => {
      await upstream.close();
    },
  };
}
