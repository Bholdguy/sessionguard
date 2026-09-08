/**
 * Admin surface (PRD Step 10): manual re-arm + live config swap + read-only
 * /state. Localhost only; mutating routes require SESSIONGUARD_ADMIN_TOKEN.
 * Re-arm = new session id, fresh baseline, cleared ledger + window (D-8).
 */
import express from "express";
import type { Server as HttpServer } from "node:http";
import type { Config, Session, StateSnapshot } from "../domain/types.js";
import type { SessionStore } from "../state/sessionStore.js";
import type { LedgerStore } from "../state/ledger.js";
import type { AccountReader } from "../market/accountReader.js";
import { parseConfig, nextConfigVersion } from "../config/load.js";

export interface AdminDeps {
  sessionStore: SessionStore;
  ledger: LedgerStore;
  accountReader: AccountReader;
  adminToken: string;
  liveSnapshot: () => Promise<StateSnapshot>;
  onRearm?: (prev: string, next: Session) => void;
  onConfigChange?: (from: number, to: number) => void;
}

export async function startAdminServer(
  deps: AdminDeps,
  opts: { host?: string; port: number },
): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());

  const gate: express.RequestHandler = (req, res, next) => {
    if (req.headers["x-admin-token"] === deps.adminToken) return next();
    res.status(401).json({ error: "bad or missing x-admin-token" });
  };

  app.get("/state", async (_req, res) => {
    try {
      res.json(await deps.liveSnapshot());
    } catch (e) {
      res.status(503).json({ error: String((e as Error).message) });
    }
  });

  app.post("/admin/rearm", gate, async (_req, res) => {
    const prev = deps.sessionStore.isArmed() ? deps.sessionStore.current().sessionId : "(none)";
    let equity: string;
    try {
      equity = await deps.accountReader.snapshotStartingEquity(); // fail closed if unreadable
    } catch (e) {
      res.status(503).json({ error: `cannot re-arm: ${(e as Error).message}` });
      return;
    }
    const next = deps.sessionStore.rearm(equity);
    deps.ledger.rebind(next.sessionId);
    deps.onRearm?.(prev, next);
    res.json({ rearmed: true, prevSessionId: prev, sessionId: next.sessionId, startingEquity: equity });
  });

  app.post("/admin/config", gate, (req, res) => {
    let cfg: Config;
    try {
      cfg = parseConfig(JSON.stringify({ ...deps.sessionStore.current().config, ...req.body }));
    } catch (e) {
      res.status(400).json({ error: String((e as Error).message) });
      return;
    }
    const from = deps.sessionStore.configVersion;
    const to = nextConfigVersion();
    deps.sessionStore.swapConfig(cfg, to);
    deps.onConfigChange?.(from, to);
    res.json({ configChanged: true, from, to, config: cfg });
  });

  const server: HttpServer = await new Promise((resolve) => {
    const s = app.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
