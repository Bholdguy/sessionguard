/**
 * Append-only JSONL audit log (PRD Step 9). One row per decision; every row
 * carries a full StateSnapshot so a run reconstructs from rows alone (INV-11).
 * Never writes headers or the bearer token (SECURITY §3, §6).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type {
  AuditCallType,
  AuditLogEntry,
  Config,
  Decision,
  Session,
  StateSnapshot,
  ToolCatalog,
} from "../domain/types.js";

const BEARER_RE = /Bearer\s+[A-Za-z0-9._\-]+/g;

function redact(s: string): string {
  return s.replace(BEARER_RE, "Bearer [redacted]");
}

export function digestResponse(mcpResult: unknown, fills: Array<{ price: string; quantity: string }>): string {
  const h = createHash("sha256").update(redact(JSON.stringify(mcpResult ?? null))).digest("hex").slice(0, 16);
  const summary =
    fills.length > 0
      ? `${fills.length}fill@${fills[0]!.price}x${fills.reduce((a, f) => a + Number(f.quantity), 0)}`
      : "nofill";
  return `sha256:${h} ${summary}`;
}

export class AuditLog {
  private logId = 0;
  path: string;
  private sessionId: string;

  constructor(
    private readonly evidenceDir: string,
    sessionId: string,
  ) {
    this.sessionId = sessionId;
    this.path = join(evidenceDir, `audit-${sessionId}.jsonl`);
    if (!existsSync(dirname(this.path))) mkdirSync(dirname(this.path), { recursive: true });
  }

  /** Re-arm (D-8): new session id => new audit file, logId resets. */
  rebind(sessionId: string): void {
    this.sessionId = sessionId;
    this.logId = 0;
    this.path = join(this.evidenceDir, `audit-${sessionId}.jsonl`);
  }

  private append(row: AuditLogEntry): void {
    appendFileSync(this.path, redact(JSON.stringify(row)) + "\n");
  }

  private base(callType: AuditCallType, snapshot: StateSnapshot): AuditLogEntry {
    this.logId += 1;
    return {
      logId: this.logId,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      callType,
      toolName: null,
      outcome: null,
      code: null,
      ruleResults: [],
      stateSnapshot: snapshot,
      forwardedResponseDigest: null,
    };
  }

  sessionStart(session: Session, catalog: ToolCatalog): void {
    this.append({
      ...this.base("SESSION_START", emptySnapshot(session)),
      meta: {
        startingEquity: session.startingEquity,
        configVersion: session.configVersion,
        toolCatalog: { map: catalog.map, excluded: catalog.excluded },
      },
    });
  }

  toolCall(
    decision: Decision,
    toolName: string | null,
    digest: string | null,
  ): void {
    this.append({
      ...this.base("TOOL_CALL", decision.stateSnapshot),
      toolName,
      outcome: decision.outcome,
      code: decision.code,
      refusal: decision.refusal ?? null,
      ruleResults: decision.ruleResults,
      forwardedResponseDigest: digest,
    });
  }

  configChange(from: number, to: number, snapshot: StateSnapshot): void {
    this.append({ ...this.base("CONFIG_CHANGE", snapshot), meta: { from, to } });
  }

  reset(prevSessionId: string, newSession: Session): void {
    this.append({
      ...this.base("RESET", emptySnapshot(newSession)),
      meta: { prevSessionId, newSessionId: newSession.sessionId, startingEquity: newSession.startingEquity },
    });
  }
}

function emptySnapshot(session: Session): StateSnapshot {
  return {
    runningPnlUsdt: "0",
    realizedPnlUsdt: "0",
    unrealizedPnlUsdt: "0",
    drawdownPct: "0",
    tradeCountInWindow: 0,
    velocityWindowSeconds: session.config.velocityWindowSeconds,
    perSymbol: {},
    killSwitch: session.status,
    haltReason: session.haltReason,
    configVersion: session.configVersion,
  };
}

// ── reader / reconstruction ─────────────────────────────────────────────────

export function readAuditRows(path: string): AuditLogEntry[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as AuditLogEntry);
}

export interface ReconstructedRun {
  sessionId: string;
  points: Array<{ logId: number; outcome: string | null; code: string | null; drawdownPct: string }>;
  allowed: number;
  blocked: number;
  terminalCode: string | null;
  logIdGaps: number[];
}

export function reconstruct(rows: AuditLogEntry[]): ReconstructedRun {
  const toolCalls = rows.filter((r) => r.callType === "TOOL_CALL");
  const points = toolCalls.map((r) => ({
    logId: r.logId,
    outcome: r.outcome,
    code: r.code,
    drawdownPct: r.stateSnapshot.drawdownPct,
  }));
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.logId !== rows[i - 1]!.logId + 1) gaps.push(rows[i]!.logId);
  }
  const blockedRows = toolCalls.filter((r) => r.outcome === "BLOCKED" && r.code);
  return {
    sessionId: rows[0]?.sessionId ?? "",
    points,
    allowed: toolCalls.filter((r) => r.outcome === "ALLOWED").length,
    blocked: toolCalls.filter((r) => r.outcome === "BLOCKED").length,
    terminalCode: blockedRows.length > 0 ? (blockedRows[blockedRows.length - 1]!.code as string) : null,
    logIdGaps: gaps,
  };
}

export function auditPathFor(evidenceDir: string, sessionId: string): string {
  return join(evidenceDir, `audit-${sessionId}.jsonl`);
}

export type { Config };
