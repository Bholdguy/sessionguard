/**
 * config.json schema (PRD Step 8). Validated at boot — invalid config => one
 * error, exit non-zero. Grounded in r/algotrading (a silent config revert
 * re-enabled old symbols and wiped 453 winning trades): config must be
 * explicit, schema-checked, and versioned in every audit row.
 */
import { z } from "zod";
import { isDecimalString } from "../domain/decimal.js";

const decimalString = (min?: number) =>
  z
    .string()
    .refine((s) => isDecimalString(s), { message: "must be a finite decimal string" })
    .refine((s) => min === undefined || Number(s) >= min, {
      message: `must be >= ${min}`,
    });

export const DEMO_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT"] as const;

export const ConfigSchema = z
  .object({
    drawdownPctLimit: decimalString().refine((s) => Number(s) > 0, "must be > 0"),
    velocityWindowSeconds: z.number().int().positive(),
    velocityMaxTrades: z.number().int().positive(),
    ladderMultipleLimit: decimalString(1),
    allowedSymbols: z.array(z.enum(DEMO_SYMBOLS)).min(1),
    priceStalenessSeconds: z.number().int().positive(),
    dataFetchTimeoutMs: z.number().int().positive(),
    priceSanityMaxDeviationPct: decimalString(0),
  })
  .strict();

export type ValidatedConfig = z.infer<typeof ConfigSchema>;
