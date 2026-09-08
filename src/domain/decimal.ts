/**
 * Decimal-safe arithmetic for all money / price / quantity / P&L values (PRD P-2).
 *
 * Rule enforced by scripts/lint-money.mjs: no `number` arithmetic ever touches a
 * currency or quantity value. Values are decimal STRINGS at rest, parsed to
 * Decimal at use, formatted back to string for storage and transport.
 */
import { Decimal } from "decimal.js";

Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };

/** A branded-ish alias to make intent obvious in interfaces. It is a plain string. */
export type DecimalString = string;

/** True iff `s` is a finite decimal literal we are willing to parse. */
export function isDecimalString(s: unknown): s is DecimalString {
  if (typeof s !== "string" || s.trim() === "") return false;
  try {
    const d = new Decimal(s);
    return d.isFinite();
  } catch {
    return false;
  }
}

/**
 * Parse a decimal string. Throws (never coerces, never defaults) on anything
 * that is not a finite decimal literal — a missing/garbage value must fail
 * closed at the call site, not silently become 0 (PRD P-3, INV-3).
 */
export function parse(s: DecimalString | number, ctx?: string): Decimal {
  if (typeof s === "number") {
    // Guardrail: numbers are only acceptable for small integer counts, never money.
    if (!Number.isSafeInteger(s)) {
      throw new Error(
        `decimal.parse: refusing non-integer number${ctx ? ` (${ctx})` : ""}: ${s}`,
      );
    }
    return new Decimal(s);
  }
  if (!isDecimalString(s)) {
    throw new Error(
      `decimal.parse: not a finite decimal string${ctx ? ` (${ctx})` : ""}: ${JSON.stringify(s)}`,
    );
  }
  return new Decimal(s);
}

/** Format a Decimal (or decimal string) back to a canonical string for storage/transport. */
export function format(d: Decimal | DecimalString): DecimalString {
  const dec = d instanceof Decimal ? d : parse(d);
  // toFixed() with no arg gives full precision without exponent notation.
  return dec.toFixed();
}

/** Convenience: is `a` <= `b` (both decimal strings / Decimals). */
export function lte(a: Decimal | DecimalString, b: Decimal | DecimalString): boolean {
  return (a instanceof Decimal ? a : parse(a)).lte(b instanceof Decimal ? b : parse(b));
}

/** Convenience: is `a` > `b`. */
export function gt(a: Decimal | DecimalString, b: Decimal | DecimalString): boolean {
  return (a instanceof Decimal ? a : parse(a)).gt(b instanceof Decimal ? b : parse(b));
}

export const ZERO = "0";
