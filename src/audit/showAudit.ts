/** `npm run audit:show -- --session <id>|--path <file>` — reconstruct a run. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readAuditRows, reconstruct } from "./auditLog.js";

const args = process.argv.slice(2);
const dir = process.env["SESSIONGUARD_EVIDENCE_DIR"] ?? "./evidence";
/** value that follows `--flag`, or undefined if the flag is absent (indexOf -1 must not read args[0]) */
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
let path = flag("--path");
const session = flag("--session");
if (!path && session) path = join(dir, `audit-${session}.jsonl`);
if (!path) {
  const files = readdirSync(dir).filter((f) => /^audit-.*\.jsonl$/.test(f));
  path = files.length ? join(dir, files[files.length - 1]!) : undefined;
}
if (!path) {
  console.error("no audit file found");
  process.exit(1);
}

const rows = readAuditRows(path);
const rec = reconstruct(rows);
console.log(`session ${rec.sessionId}   allowed ${rec.allowed}  blocked ${rec.blocked}  terminal ${rec.terminalCode ?? "-"}`);
console.log("trade-by-trade cumulative drawdown %:");
const maxAbs = Math.max(1, ...rec.points.map((p) => Math.abs(Number(p.drawdownPct))));
for (const p of rec.points) {
  const v = Number(p.drawdownPct);
  const bars = Math.round((Math.abs(v) / maxAbs) * 40);
  console.log(
    `  #${String(p.logId).padStart(3)}  ${(p.outcome ?? "").padEnd(8)} ${(p.code ?? "").padEnd(18)} ` +
      `${v.toFixed(2).padStart(8)}%  ${"█".repeat(bars)}`,
  );
}
if (rec.logIdGaps.length) console.log(`WARN logId gaps: ${rec.logIdGaps.join(", ")}`);
