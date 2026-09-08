/**
 * Step 13a — supervised vs unsupervised across the scripted LOSING scenarios.
 * Writes evidence/results.csv (one row per scenario x mode) and generates
 * evidence/headline.txt as a PURE FUNCTION of that CSV (BL-4). Re-running
 * reproduces the CSV row-for-row (BL-5).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Decimal } from "../domain/decimal.js";
import {
  loadScenario,
  runScenarioSupervised,
  runScenarioUnsupervised,
  type RunReport,
} from "./scenarioRunner.js";

export const LOSING_SCENARIOS = ["drawdown", "velocity", "ladder"] as const;

export const CSV_HEADER =
  "scenario,mode,halted,halt_trade_index,final_drawdown_pct,trades_executed,fee_to_gross_pnl";

const round = (s: string, dp: number): string =>
  s === "inf" || s === "999+" ? s : new Decimal(s).toDecimalPlaces(dp).toString();

export function toCsvRow(r: RunReport): string {
  return [
    r.name,
    r.mode,
    r.halted,
    r.haltAtIndex ?? "",
    round(r.mode === "supervised" ? r.drawdownAtHalt : r.finalDrawdownPct, 2),
    r.tradesExecuted,
    round(r.feeToGrossPnl, 4),
  ].join(",");
}

export interface CsvRow {
  scenario: string;
  mode: "supervised" | "unsupervised";
  halted: boolean;
  halt_trade_index: number | null;
  final_drawdown_pct: string;
  trades_executed: number;
  fee_to_gross_pnl: string;
}

export function parseCsv(csv: string): CsvRow[] {
  const [, ...lines] = csv.trim().split(/\r?\n/);
  return lines.map((l) => {
    const [scenario, mode, halted, halt, dd, trades, fee] = l.split(",");
    return {
      scenario: scenario!,
      mode: mode as CsvRow["mode"],
      halted: halted === "true",
      halt_trade_index: halt === "" ? null : Number(halt),
      final_drawdown_pct: dd!,
      trades_executed: Number(trades),
      fee_to_gross_pnl: fee!,
    };
  });
}

/** PURE: same CSV rows in -> same sentence out (BL-4). */
export function generateHeadline(rows: CsvRow[]): string {
  const scenarios = [...new Set(rows.map((r) => r.scenario))];
  const n = scenarios.length;
  const sup = rows.filter((r) => r.mode === "supervised");
  const uns = rows.filter((r) => r.mode === "unsupervised");
  const supHalted = sup.filter((r) => r.halted).length;
  const unsHalted = uns.filter((r) => r.halted).length;

  const extraTrades = uns.reduce((a, r) => a + r.trades_executed, 0) -
    sup.reduce((a, r) => a + r.trades_executed, 0);

  // average "x deeper" over scenarios where the supervised halt drawdown is negative
  const depthRatios: Decimal[] = [];
  for (const s of scenarios) {
    const su = sup.find((r) => r.scenario === s)!;
    const un = uns.find((r) => r.scenario === s)!;
    const sd = new Decimal(su.final_drawdown_pct);
    const ud = new Decimal(un.final_drawdown_pct);
    if (sd.lt(0) && ud.lt(0)) depthRatios.push(ud.div(sd));
  }
  const avgRatio =
    depthRatios.length > 0
      ? depthRatios
          .reduce((a, b) => a.plus(b), new Decimal(0))
          .div(depthRatios.length)
          .toDecimalPlaces(1)
          .toString()
      : null;

  const parts = [
    `Across ${n} scripted losing sessions, SessionGuard halted before further loss in ` +
      `${supHalted === n ? "every case" : `${supHalted} of ${n}`} ` +
      `(${sup.map((r) => r.scenario).join(", ")}); ` +
      `the unsupervised agent ${unsHalted === 0 ? "never halted" : `halted in only ${unsHalted}`} ` +
      `and kept trading through ${unsHalted === 0 ? `all ${n}` : `${n - unsHalted} of ${n}`}, ` +
      `executing ${extraTrades} more trade${extraTrades === 1 ? "" : "s"}`,
  ];
  if (avgRatio) parts.push(` and ending on average ${avgRatio}x deeper in drawdown where drawdown applied`);
  return parts.join("") + ".";
}

export async function runBaseline(opts: { evidenceDir?: string } = {}): Promise<{
  csv: string;
  headline: string;
  rows: RunReport[];
}> {
  const evidenceDir = opts.evidenceDir ?? "./evidence";
  const reports: RunReport[] = [];
  for (const name of LOSING_SCENARIOS) {
    const scenario = loadScenario(join(evidenceDir, "scenarios", `${name}.json`));
    reports.push(await runScenarioSupervised(scenario, { evidenceDir }));
    reports.push(await runScenarioUnsupervised(scenario));
  }
  const csv = [CSV_HEADER, ...reports.map(toCsvRow)].join("\n") + "\n";
  const headline = generateHeadline(parseCsv(csv));
  writeFileSync(join(evidenceDir, "results.csv"), csv);
  writeFileSync(join(evidenceDir, "headline.txt"), headline + "\n");
  return { csv, headline, rows: reports };
}

const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const { csv, headline } = await runBaseline();
  process.stdout.write(csv + "\n" + headline + "\n");
  process.exit(0);
}
