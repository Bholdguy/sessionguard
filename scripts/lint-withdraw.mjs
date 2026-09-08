/**
 * SECURITY.md §5 / TESTING.md §6 — fails the build if any withdrawal or
 * external-transfer surface appears in src/. Expected: zero matches.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const PATTERN =
  /withdraw|external.?address|universalTransfer|sapi\/v1\/capital|\/wallet\/withdraw|transfer(To|From)?Master|withdrawApply/i;

/** Lines that are allowed to mention the words because they are the guard itself. */
const ALLOW = /toolCatalog|EXCLUDE|excluded|SECURITY|lint-withdraw|no withdrawal|never/i;

let hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (!p.endsWith(".ts")) continue;
    const lines = readFileSync(p, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      if (PATTERN.test(code) && !ALLOW.test(code)) {
        hits.push(`${p}:${i + 1}: ${trimmed}`);
      }
    });
  }
}

walk(ROOT);

if (hits.length > 0) {
  console.error("lint-withdraw FAILED — withdrawal/transfer surface found in src/:");
  for (const h of hits) console.error("  " + h);
  process.exit(1);
}
console.log("lint-withdraw OK — no withdrawal or external-transfer path in src/");
