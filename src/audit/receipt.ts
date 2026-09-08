/**
 * Structured receipt returned to the agent on every decision. Read-only view of
 * session state + rule results — never the token, never a way to mutate state (P-6).
 */
import type { Decision } from "../domain/types.js";

export interface Receipt {
  sessionGuard: {
    outcome: Decision["outcome"];
    code: Decision["code"];
    refusal?: Decision["refusal"];
    ruleResults: Array<{ rule: string; pass: boolean; code: string | null; observed: string; threshold: string; detail: string }>;
    state: Decision["stateSnapshot"];
    decidedAt: string;
  };
}

export function buildReceipt(decision: Decision): Receipt {
  return {
    sessionGuard: {
      outcome: decision.outcome,
      code: decision.code,
      ...(decision.refusal ? { refusal: decision.refusal } : {}),
      ruleResults: decision.ruleResults.map((r) => ({
        rule: r.rule,
        pass: r.pass,
        code: r.code,
        observed: r.observed,
        threshold: r.threshold,
        detail: r.detail,
      })),
      state: decision.stateSnapshot,
      decidedAt: decision.decidedAt,
    },
  };
}

/** MCP error payload for a blocked call — the named code is the primary signal (P-4). */
export function blockedToolResult(decision: Decision): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  const primary = decision.code ?? decision.refusal ?? "BLOCKED";
  const detail =
    decision.ruleResults.find((r) => !r.pass)?.detail ??
    (decision.refusal ? `Refused: ${decision.refusal}` : "Blocked by SessionGuard");
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ code: primary, detail, receipt: buildReceipt(decision) }),
      },
    ],
  };
}
