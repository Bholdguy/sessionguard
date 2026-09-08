/**
 * Session lifecycle + kill-switch (PRD §9.7). Lives entirely in SessionGuard's
 * process (P-6). arm() takes a fresh starting-equity snapshot; halt() stores the
 * BlockCode; rearm() starts a clean session (D-8).
 */
import { randomUUID } from "node:crypto";
import type { BlockCode } from "../domain/blockCode.js";
import type { Config, Session } from "../domain/types.js";

export class SessionStore {
  private session: Session | null = null;
  private _configVersion: number;

  constructor(
    private config: Config,
    configVersion: number,
  ) {
    this._configVersion = configVersion;
  }

  get configVersion(): number {
    return this._configVersion;
  }

  current(): Session {
    if (!this.session) throw new Error("sessionStore: no armed session");
    return this.session;
  }

  isArmed(): boolean {
    return this.session !== null;
  }

  arm(startingEquity: string): Session {
    this.session = {
      sessionId: randomUUID(),
      startedAt: new Date().toISOString(),
      startingEquity,
      status: "ACTIVE",
      haltReason: null,
      haltedAt: null,
      haltDetail: null,
      config: this.config,
      configVersion: this._configVersion,
      tradeTimestamps: [],
    };
    return this.session;
  }

  /** Re-arm: brand-new session id, fresh baseline, cleared window (D-8). */
  rearm(startingEquity: string): Session {
    return this.arm(startingEquity);
  }

  halt(code: BlockCode, detail: string): void {
    const s = this.current();
    if (s.status === "HALTED") return; // first halt wins; keep the original code
    s.status = "HALTED";
    s.haltReason = code;
    s.haltedAt = new Date().toISOString();
    s.haltDetail = detail;
  }

  /** Record an allowed + forwarded trade for the velocity window. */
  recordTrade(atIso: string): void {
    this.current().tradeTimestamps.push(atIso);
  }

  swapConfig(next: Config, nextVersion: number): void {
    this._configVersion = nextVersion;
    this.config = next;
    if (this.session) {
      this.session.config = next;
      this.session.configVersion = nextVersion;
    }
  }
}
