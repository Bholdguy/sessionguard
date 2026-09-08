import { describe, expect, it } from "vitest";
import { loadScenario, runScenarioSupervised, runScenarioUnsupervised } from "../src/evidence/scenarioRunner.js";
import { readAuditRows, reconstruct } from "../src/audit/auditLog.js";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const SCEN = (n: string) => loadScenario(`./evidence/scenarios/${n}.json`);
const evidenceDir = () => mkdtempSync(join(tmpdir(), "sg-scn-"));

describe("Step 13 — scripted demo scenarios (integration, MockUpstream)", () => {
  it("IT-1 happy: all ALLOWED, session ACTIVE", async () => {
    const r = await runScenarioSupervised(SCEN("happy"), { evidenceDir: evidenceDir() });
    expect(r.outcomes).toEqual(["ALLOWED", "ALLOWED", "ALLOWED"]);
    expect(r.halted).toBe(false);
  });

  it("IT-2 drawdown: 4 ALLOWED then DRAWDOWN_BREACH; halt at index 4; upstream never saw trade 5", async () => {
    const r = await runScenarioSupervised(SCEN("drawdown"), { evidenceDir: evidenceDir() });
    expect(r.outcomes.slice(0, 4)).toEqual(["ALLOWED", "ALLOWED", "ALLOWED", "ALLOWED"]);
    expect(r.outcomes[4]).toBe("DRAWDOWN_BREACH");
    expect(r.haltAtIndex).toBe(4);
    expect(r.terminalCode).toBe("DRAWDOWN_BREACH");
    expect(Number(r.drawdownAtHalt)).toBeLessThanOrEqual(-5);
    expect(Number(r.drawdownAtHalt)).toBeGreaterThan(-9); // fired near the threshold, not late
  });

  it("IT-3 velocity: 5 ALLOWED then VELOCITY_EXCEEDED at index 5", async () => {
    const r = await runScenarioSupervised(SCEN("velocity"), { evidenceDir: evidenceDir() });
    expect(r.tradesExecuted).toBe(5);
    expect(r.outcomes[5]).toBe("VELOCITY_EXCEEDED");
    expect(r.haltAtIndex).toBe(5);
  });

  it("IT-4 velocity: the blocked trade does not increase the executed count (INV-7)", async () => {
    const r = await runScenarioSupervised(SCEN("velocity"), { evidenceDir: evidenceDir() });
    expect(r.tradesExecuted).toBe(5); // not 6
  });

  it("IT-5 ladder: LADDER_DETECTED at index 2", async () => {
    const r = await runScenarioSupervised(SCEN("ladder"), { evidenceDir: evidenceDir() });
    expect(r.outcomes.slice(0, 2)).toEqual(["ALLOWED", "ALLOWED"]);
    expect(r.outcomes[2]).toBe("LADDER_DETECTED");
    expect(r.haltAtIndex).toBe(2);
  });

  it("IT-6 data-loss: DATA_UNAVAILABLE at index 2, no forward, HALTED", async () => {
    const r = await runScenarioSupervised(SCEN("data-loss"), { evidenceDir: evidenceDir() });
    expect(r.outcomes[2]).toBe("DATA_UNAVAILABLE");
    expect(r.halted).toBe(true);
    expect(r.tradesExecuted).toBe(2);
  });

  it("IT-8: the run reconstructs from the audit JSONL alone (INV-11)", async () => {
    const dir = evidenceDir();
    const r = await runScenarioSupervised(SCEN("drawdown"), { evidenceDir: dir });
    const rows = readAuditRows(r.auditPath!);
    const rec = reconstruct(rows);
    expect(rec.allowed).toBe(4);
    expect(rec.blocked).toBe(3); // trades 5,6,7 blocked
    expect(rec.terminalCode).toBe("DRAWDOWN_BREACH");
    expect(rec.logIdGaps).toEqual([]);
  });

  it("IT-9: repeated runs give identical outcomes + terminal code (determinism)", async () => {
    const runs = await Promise.all(
      [0, 1, 2, 3, 4].map(() => runScenarioSupervised(SCEN("drawdown"), { evidenceDir: evidenceDir() })),
    );
    const sigs = runs.map((r) => JSON.stringify([r.outcomes, r.terminalCode, r.haltAtIndex]));
    expect(new Set(sigs).size).toBe(1);
  });

  it("unsupervised drawdown keeps trading through all 7 and ends deeper", async () => {
    const sup = await runScenarioSupervised(SCEN("drawdown"), { evidenceDir: evidenceDir() });
    const uns = await runScenarioUnsupervised(SCEN("drawdown"));
    expect(uns.halted).toBe(false);
    expect(uns.tradesExecuted).toBe(7);
    expect(Number(uns.finalDrawdownPct)).toBeLessThan(Number(sup.drawdownAtHalt));
  });
});
