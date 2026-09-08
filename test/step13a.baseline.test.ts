import { describe, expect, it } from "vitest";
import { mkdtempSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runBaseline,
  parseCsv,
  generateHeadline,
  CSV_HEADER,
  LOSING_SCENARIOS,
} from "../src/evidence/baseline.js";

function evidenceDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sg-bl-"));
  cpSync("./evidence/scenarios", join(d, "scenarios"), { recursive: true });
  return d;
}

describe("Step 13a — baseline comparison + headline (BL-1..BL-5)", () => {
  it("BL-1/BL-2: one row per (scenario x mode); correct header", async () => {
    const dir = evidenceDir();
    const { csv } = await runBaseline({ evidenceDir: dir });
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines.length).toBe(1 + LOSING_SCENARIOS.length * 2);
    const rows = parseCsv(csv);
    for (const s of LOSING_SCENARIOS) {
      expect(rows.filter((r) => r.scenario === s).map((r) => r.mode).sort()).toEqual([
        "supervised",
        "unsupervised",
      ]);
    }
  });

  it("BL-3: supervised halts every losing scenario; unsupervised never halts and trades more", async () => {
    const { csv } = await runBaseline({ evidenceDir: evidenceDir() });
    const rows = parseCsv(csv);
    for (const s of LOSING_SCENARIOS) {
      const sup = rows.find((r) => r.scenario === s && r.mode === "supervised")!;
      const uns = rows.find((r) => r.scenario === s && r.mode === "unsupervised")!;
      expect(sup.halted).toBe(true);
      expect(uns.halted).toBe(false);
      expect(uns.trades_executed).toBeGreaterThan(sup.trades_executed);
    }
    // drawdown + ladder: unsupervised ends strictly deeper in drawdown
    for (const s of ["drawdown", "ladder"]) {
      const sup = rows.find((r) => r.scenario === s && r.mode === "supervised")!;
      const uns = rows.find((r) => r.scenario === s && r.mode === "unsupervised")!;
      expect(Number(uns.final_drawdown_pct)).toBeLessThan(Number(sup.final_drawdown_pct));
    }
  });

  it("BL-4: headline is a pure function of the CSV; integers match row counts", async () => {
    const { csv, headline } = await runBaseline({ evidenceDir: evidenceDir() });
    const again = generateHeadline(parseCsv(csv));
    expect(again).toBe(headline);
    expect(headline).toContain(`Across ${LOSING_SCENARIOS.length} scripted losing sessions`);
    expect(headline).toContain("halted before further loss in every case");
    expect(headline).toContain("kept trading through all 3");
  });

  it("BL-5: re-running reproduces the CSV row-for-row (determinism)", async () => {
    const d1 = evidenceDir();
    const d2 = evidenceDir();
    const a = await runBaseline({ evidenceDir: d1 });
    const b = await runBaseline({ evidenceDir: d2 });
    expect(a.csv).toBe(b.csv);
    expect(readFileSync(join(d1, "results.csv"), "utf8")).toBe(
      readFileSync(join(d2, "results.csv"), "utf8"),
    );
  });
});
