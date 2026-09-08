import { describe, it, expect } from "vitest";
import { parse, format, isDecimalString, lte, gt, Decimal } from "../src/domain/decimal.js";
import { BlockCode, RefusalCode, ALL_BLOCK_CODES } from "../src/domain/blockCode.js";

describe("domain/decimal", () => {
  it("parses and formats without float error", () => {
    expect(format(parse("0.1").plus(parse("0.2")))).toBe("0.3");
  });

  it("refuses non-decimal strings (no coercion — INV-3)", () => {
    expect(isDecimalString("")).toBe(false);
    expect(isDecimalString("abc")).toBe(false);
    expect(isDecimalString(undefined)).toBe(false);
    expect(() => parse("" as unknown as string)).toThrow();
    expect(() => parse(undefined as unknown as string)).toThrow();
  });

  it("refuses non-integer numbers (money must be strings — P-2)", () => {
    expect(() => parse(1.5)).toThrow();
    expect(parse(5).toFixed()).toBe("5");
  });

  it("exact comparison at the boundary", () => {
    // -5.0 <= -5 must be true; -4.9999 <= -5 must be false
    expect(lte(new Decimal("-5.0"), "-5")).toBe(true);
    expect(lte(new Decimal("-4.9999"), "-5")).toBe(false);
    expect(gt("2", "1.5")).toBe(true);
    expect(gt("1.5", "1.5")).toBe(false);
  });
});

describe("domain/blockCode", () => {
  it("has exactly the four codes, distinct from refusals", () => {
    expect(ALL_BLOCK_CODES).toHaveLength(4);
    expect(new Set(ALL_BLOCK_CODES).size).toBe(4);
    const overlap = ALL_BLOCK_CODES.filter((c) =>
      (Object.values(RefusalCode) as string[]).includes(c),
    );
    expect(overlap).toHaveLength(0);
    expect(BlockCode.DATA_UNAVAILABLE).toBe("DATA_UNAVAILABLE");
  });
});
