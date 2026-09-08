/**
 * PRD P-2 / TESTING.md §6 — flags `number` arithmetic on money/price/qty fields.
 * Heuristic: an identifier containing a money-ish word directly adjacent to a
 * bare arithmetic operator, not part of a Decimal call chain. Expected: zero.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const MONEY = /\b(price|markPrice|avgEntryPrice|quantity|qty|netQuantity|equity|startingEquity|pnl|realized|unrealized|drawdown|commission|quoteQuantity|quoteOrderQty)\w*\s*[-+*/]\s*(?!=)/i;
const DECIMAL_OK = /new Decimal|\.plus\(|\.minus\(|\.times\(|\.div\(|\.mul\(|\.cmp\(|\.lte\(|\.gte\(|\.lt\(|\.gt\(|parse\(|format\(/;
// identifiers that contain a money word but are config ints / names, not money
const NOT_MONEY = /priceStalenessSeconds|priceSanityMaxDeviationPct|priceTool|priceBySymbol|drawdownPctLimit|commissionUsdtRate|commissionAsset|qtyStr|realizedClose|realizedDelta\b/;

let hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (!p.endsWith(".ts") || p.endsWith(".test.ts")) continue;
    const lines = readFileSync(p, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      // strip trailing line comments and JSDoc before matching — we only care about real code
      let code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      // strip regex literals and string literals — `/x/i` delimiters and quoted text
      // are not arithmetic even though they contain `/` `*` `+`
      code = code
        .replace(/\/(?![*/])(?:\\.|[^/\n])+\/[gimsuy]*/g, " RE ")
        .replace(/"(?:\\.|[^"\n])*"|'(?:\\.|[^'\n])*'|`(?:\\.|[^`\n])*`/g, " STR ");
      if (MONEY.test(code) && !DECIMAL_OK.test(code) && !NOT_MONEY.test(code)) {
        hits.push(`${p}:${i + 1}: ${trimmed}`);
      }
    });
  }
}

walk(ROOT);

if (hits.length > 0) {
  console.error("lint-money FAILED — suspected float arithmetic on money/qty:");
  for (const h of hits) console.error("  " + h);
  process.exit(1);
}
console.log("lint-money OK — no bare number arithmetic on money/qty fields in src/");
