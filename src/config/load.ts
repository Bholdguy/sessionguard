import { readFileSync } from "node:fs";
import type { Config } from "../domain/types.js";
import { ConfigSchema } from "./schema.js";

export interface LoadedConfig {
  config: Config;
  version: number;
  path: string;
}

/** SG_* env overrides for quick demo tweaks (config.json stays source of truth). */
function applyEnvOverrides(raw: Record<string, unknown>): Record<string, unknown> {
  const e = process.env;
  const out = { ...raw };
  if (e["SG_DRAWDOWN_PCT_LIMIT"]) out["drawdownPctLimit"] = e["SG_DRAWDOWN_PCT_LIMIT"];
  if (e["SG_VELOCITY_WINDOW_SECONDS"]) out["velocityWindowSeconds"] = Number(e["SG_VELOCITY_WINDOW_SECONDS"]);
  if (e["SG_VELOCITY_MAX_TRADES"]) out["velocityMaxTrades"] = Number(e["SG_VELOCITY_MAX_TRADES"]);
  if (e["SG_LADDER_MULTIPLE_LIMIT"]) out["ladderMultipleLimit"] = e["SG_LADDER_MULTIPLE_LIMIT"];
  if (e["SG_ALLOWED_SYMBOLS"]) out["allowedSymbols"] = e["SG_ALLOWED_SYMBOLS"].split(",").map((s) => s.trim());
  if (e["SG_PRICE_STALENESS_SECONDS"]) out["priceStalenessSeconds"] = Number(e["SG_PRICE_STALENESS_SECONDS"]);
  if (e["SG_DATA_FETCH_TIMEOUT_MS"]) out["dataFetchTimeoutMs"] = Number(e["SG_DATA_FETCH_TIMEOUT_MS"]);
  if (e["SG_PRICE_SANITY_MAX_DEVIATION_PCT"]) out["priceSanityMaxDeviationPct"] = e["SG_PRICE_SANITY_MAX_DEVIATION_PCT"];
  return out;
}

/** Parse + validate. Throws with a readable message on invalid config. */
export function parseConfig(rawJson: string): Config {
  let obj: unknown;
  try {
    obj = JSON.parse(rawJson);
  } catch (e) {
    throw new Error(`config: not valid JSON: ${(e as Error).message}`);
  }
  const withEnv = applyEnvOverrides(obj as Record<string, unknown>);
  const parsed = ConfigSchema.safeParse(withEnv);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`config: invalid:\n${issues}`);
  }
  return parsed.data as Config;
}

let versionCounter = 0;

export function loadConfig(path: string): LoadedConfig {
  const config = parseConfig(readFileSync(path, "utf8"));
  versionCounter += 1;
  return { config, version: versionCounter, path };
}

/** Validate a candidate config for the live-swap endpoint; returns the next version. */
export function nextConfigVersion(): number {
  versionCounter += 1;
  return versionCounter;
}
