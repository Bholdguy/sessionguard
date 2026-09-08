import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { startAdminServer } from "../src/admin/adminServer.js";
import { liveSnapshot, renderDashboard } from "../src/view/stateView.js";
import { startMockUpstream } from "./mockUpstream.js";
import type { Config } from "../src/domain/types.js";

const CONFIG: Config = {
  drawdownPctLimit: "5",
  velocityWindowSeconds: 900,
  velocityMaxTrades: 5,
  ladderMultipleLimit: "1.5",
  allowedSymbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
  priceStalenessSeconds: 10,
  dataFetchTimeoutMs: 3000,
  priceSanityMaxDeviationPct: "20",
};

describe("Steps 10-11 — admin + dashboard", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c().catch(() => undefined);
  });

  async function boot() {
    const mock = await startMockUpstream();
    cleanups.push(mock.close);
    mock.setScript({ equityUsdt: "1000", balances: { USDT: "1000" } });
    const dir = mkdtempSync(join(tmpdir(), "sg-adm-"));
    const app = await createApp({
      mcpUrl: mock.url, nodeEnv: "test", config: CONFIG, configVersion: 1,
      evidenceDir: dir, toolsListTimeoutMs: 5000, log: () => undefined,
    });
    cleanups.push(app.close);
    const admin = await startAdminServer(
      {
        sessionStore: app.sessionStore,
        ledger: app.ledger,
        accountReader: app.accountReader,
        adminToken: "adm",
        liveSnapshot: () => liveSnapshot({ sessionStore: app.sessionStore, ledger: app.ledger, marketReader: app.marketReader }),
        onRearm: (prev, next) => {
          app.audit.reset(prev, next);
          app.audit.rebind(next.sessionId);
          app.audit.sessionStart(next, app.catalog);
        },
      },
      { port: 0 },
    );
    cleanups.push(admin.close);
    return { mock, app, admin };
  }

  it("GET /state serialises decimals as strings (no number leak)", async () => {
    const { admin } = await boot();
    const s = (await (await fetch(`${admin.url}/state`)).json()) as Record<string, unknown>;
    expect(typeof s.drawdownPct).toBe("string");
    expect(typeof s.runningPnlUsdt).toBe("string");
    expect(s.killSwitch).toBe("ACTIVE");
  });

  it("POST /admin/rearm requires the admin token", async () => {
    const { admin } = await boot();
    const bad = await fetch(`${admin.url}/admin/rearm`, { method: "POST" });
    expect(bad.status).toBe(401);
  });

  it("re-arm after a halt clears the kill-switch and starts a new session (D-8, INV-8)", async () => {
    const { app, admin } = await boot();
    app.sessionStore.halt("DRAWDOWN_BREACH" as never, "seeded");
    const before = app.sessionStore.current().sessionId;

    const res = await fetch(`${admin.url}/admin/rearm`, {
      method: "POST",
      headers: { "x-admin-token": "adm" },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.rearmed).toBe(true);
    expect(body.prevSessionId).toBe(before);
    expect(app.sessionStore.current().sessionId).not.toBe(before);
    expect(app.sessionStore.current().status).toBe("ACTIVE");
    expect(app.ledger.fillCount).toBe(0);
  });

  it("renderDashboard shows P&L, drawdown vs limit, velocity, kill-switch", async () => {
    const { app } = await boot();
    const s = await app.snapshot();
    const out = renderDashboard(s, { drawdownPctLimit: "5", velocityMaxTrades: 5 });
    expect(out).toMatch(/kill-switch : ● ACTIVE/);
    expect(out).toMatch(/drawdown/);
    expect(out).toMatch(/velocity    : 0\/5/);
  });
});
