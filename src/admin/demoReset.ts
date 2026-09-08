/** `npm run demo:reset` — clear per-run evidence for the demo session. */
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = process.env["SESSIONGUARD_EVIDENCE_DIR"] ?? "./evidence";
let n = 0;
for (const f of readdirSync(dir)) {
  if (/^audit-.*\.jsonl$/.test(f) || /^fills-.*\.jsonl$/.test(f) || f === "mockupstream-calls.log") {
    rmSync(join(dir, f));
    n++;
  }
}
console.log(`demo:reset removed ${n} per-run evidence file(s) from ${dir}`);
