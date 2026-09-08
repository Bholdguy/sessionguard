/**
 * SessionGuard entrypoint. Boots the app (fail-closed), starts the inbound MCP
 * proxy server, the admin server (/state, /admin/rearm, /admin/config), and the
 * terminal dashboard.
 */
import { readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { createApp } from "./app.js";
import { loadConfig } from "./config/load.js";
import { mountMcpServer } from "./mcp/httpServer.js";
import { startAdminServer } from "./admin/adminServer.js";
import { liveSnapshot, renderDashboard } from "./view/stateView.js";

async function main(): Promise<void> {
  try {
    loadDotenv();
  } catch {
    /* dotenv optional */
  }
  const env = process.env;
  const nodeEnv = env["NODE_ENV"] ?? "production";

  const cfgPath = env["SESSIONGUARD_CONFIG_PATH"] ?? "./config.json";
  let loaded;
  try {
    loaded = loadConfig(cfgPath);
  } catch (e) {
    console.error(`FATAL: ${(e as Error).message}`);
    process.exit(1);
  }

  const app = await createApp({
    mcpUrl: env["BINANCE_AGENT_OS_MCP_URL"] ?? "https://agent.binance.com/mcp/agentic",
    bearerToken: env["BINANCE_AGENT_OS_BEARER_TOKEN"] || undefined,
    nodeEnv,
    config: loaded.config,
    configVersion: loaded.version,
    evidenceDir: env["SESSIONGUARD_EVIDENCE_DIR"] ?? "./evidence",
    toolsListTimeoutMs: Number(env["TOOLS_LIST_TIMEOUT_MS"] ?? 5000),
    log: (l) => console.error(l),
  });

  const inbound = await mountMcpServer({
    createServer: app.makeInboundServer,
    host: env["SESSIONGUARD_INBOUND_HOST"] ?? "127.0.0.1",
    port: Number(env["SESSIONGUARD_INBOUND_PORT"] ?? 8788),
  });
  console.error(`inbound MCP proxy listening on ${inbound.url}`);

  const admin = await startAdminServer(
    {
      sessionStore: app.sessionStore,
      ledger: app.ledger,
      accountReader: app.accountReader,
      adminToken: env["SESSIONGUARD_ADMIN_TOKEN"] ?? "change-me-local-only",
      liveSnapshot: () =>
        liveSnapshot({ sessionStore: app.sessionStore, ledger: app.ledger, marketReader: app.marketReader }),
      onRearm: (prev, next) => {
        app.audit.reset(prev, next);
        app.audit.rebind(next.sessionId);
        app.audit.sessionStart(next, app.catalog);
      },
      onConfigChange: (from, to) => {
        void liveSnapshot({
          sessionStore: app.sessionStore,
          ledger: app.ledger,
          marketReader: app.marketReader,
        }).then((s) => app.audit.configChange(from, to, s));
      },
    },
    {
      host: env["SESSIONGUARD_ADMIN_HOST"] ?? "127.0.0.1",
      port: Number(env["SESSIONGUARD_ADMIN_PORT"] ?? 8789),
    },
  );
  console.error(`admin + /state listening on ${admin.url}`);

  const cfg = { drawdownPctLimit: loaded.config.drawdownPctLimit, velocityMaxTrades: loaded.config.velocityMaxTrades };
  setInterval(async () => {
    try {
      const s = await app.snapshot();
      process.stdout.write("\x1b[2J\x1b[H" + renderDashboard(s, cfg) + "\n");
    } catch {
      /* transient */
    }
  }, 1000).unref();

  const shutdown = async () => {
    await inbound.close();
    await admin.close();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).message}`);
  process.exit(1);
});
