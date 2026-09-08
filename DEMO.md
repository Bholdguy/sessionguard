# SessionGuard — DEMO.md

The judge demo. **Deterministic**: every trade, fill, and price comes from **MockUpstream** replaying a scenario file (D-0, D-7). Nothing depends on live-market timing, token state, or Binance availability. Target runtime: **4–5 minutes** for the timed run; +40s for the optional B-roll.

Terminology: `PRD.md` §9, call flow in `ARCHITECTURE.md` §4–5.

---

## 0. Pre-flight (before recording)

| # | Check | Command / action |
|---|---|---|
| 0.1 | Node 20+, deps installed | `npm ci` |
| 0.2 | `config.json` set to demo values | `drawdownPctLimit: "5"`, `velocityWindowSeconds: 900`, `velocityMaxTrades: 5`, `ladderMultipleLimit: "1.5"`, `allowedSymbols: ["BTCUSDT","ETHUSDT","BNBUSDT"]`, `priceStalenessSeconds: 10`, `dataFetchTimeoutMs: 3000` |
| 0.3 | `.env` points upstream at MockUpstream | `BINANCE_AGENT_OS_MCP_URL=http://127.0.0.1:8790` (MockUpstream), `NODE_ENV=demo` |
| 0.4 | Scenario files present | `evidence/scenarios/{happy,drawdown,velocity,ladder,data-loss}.json` |
| 0.5 | All integration tests green | `npm test` — IT-1..IT-9, BL-1..BL-5 pass |
| 0.6 | Two terminal panes + one browser tab | Pane A: proxy + MockUpstream; Pane B: reference agent / scenario runner; Tab: `http://127.0.0.1:<inbound>/` dashboard |
| 0.7 | Baseline evidence regenerated | `npm run baseline` → fresh `evidence/results.csv` + `evidence/headline.txt` |
| 0.8 | (Live attempt only, post-submit) | confirm Agentic sub-account funded, trade scope = spot, decide autonomous vs per-order confirm (D-5). **Skip for the recorded run.** |

Reset before each take: `npm run demo:reset` (clears `evidence/audit-*.jsonl` for the demo session, re-arms).

---

## 1. The 11-step script

### Step 1 — Both systems visibly running
**Do:** In Pane A: `npm run start` (boots MockUpstream on :8790, then SessionGuard). Watch the boot sequence print: config validated → `tools/list` resolved (show the line `ToolCatalog resolved: 8/8 required capabilities` ) → starting equity snapshot `1000.00 USDT` → `session <id> ACTIVE` → `inbound MCP listening on 127.0.0.1:<port>`.
**Say:** "SessionGuard is a stateful MCP proxy. The agent connects to it instead of to Binance. It has no LLM — every decision is deterministic code."
**On screen:** boot log; dashboard tab showing `P&L 0.00 | drawdown 0.0% | trades 0/5 | kill-switch ACTIVE`.

### Step 2 — State the config on screen
**Do:** `cat config.json` in Pane B.
**Say:** "Two limits matter today: session drawdown capped at **−5%**, and **5 trades per 15 minutes**. These live in a config file. The agent cannot see or change them."
**On screen:** `config.json` with the two thresholds highlighted.

### Step 3 — Trade 1: allowed, forwarded, filled
**Do:** Pane B: `npm run agent -- --scenario drawdown --step 1` (or start the Claude Code agent; the scripted runner is the deterministic choice for recording).
**Expect:** Pane A logs `ticket <id> BTCUSDT BUY MARKET 0.01 → rules: DATA ✓ DRAWDOWN ✓ VELOCITY ✓ LADDER ✓ → ALLOWED → forwarded → fill 0.01 @ 60000`. Dashboard: `P&L -0.60 (fees) | drawdown -0.06% | trades 1/5`.
**Say:** "Trade one. All four rules pass in fixed order — data availability, drawdown, velocity, ladder — the call is forwarded to Binance unmodified, and the fill comes back into SessionGuard's own ledger."

### Step 4 — Trades 2 and 3: scripted small losses
**Do:** Pane B: `--step 2`, then `--step 3`.
**Expect:** both `ALLOWED` and forwarded. MockUpstream fills them at a loss (scripted marks). Dashboard drawdown ticks: `-2.1%` → `-3.8%`. Trades `3/5`.
**Say:** "Two more trades. Each one is small, each one is individually fine — a per-trade validator sees nothing wrong. But SessionGuard is adding them up. Drawdown is now −3.8%."

### Step 5 — Trade 4: scripted larger loss, crosses −5%
**Do:** Pane B: `--step 4`.
**Expect:** `ALLOWED` and forwarded (it is the *4th* trade — still under the velocity limit, and the breach is only realized *after* this fill lands). MockUpstream fills at the scripted larger loss. Dashboard: `drawdown -6.2%`, background turns red, `trades 4/5`, kill-switch still `ACTIVE` (the halt fires on the *next* evaluation).
**Say:** "Trade four is a bigger loss. It executes — nothing blocks a trade for being the last straw. But now cumulative session drawdown is −6.2%, past the −5% line."

### Step 6 — Trade 5: BLOCKED before it reaches Binance
**Do:** Pane B: `--step 5`.
**Expect:** Pane A logs:
```
ticket <id> BTCUSDT BUY MARKET 0.02 → rules: DATA ✓ DRAWDOWN ✗
DRAWDOWN_BREACH — session drawdown -6.2% exceeds -5.0% limit. Trading halted.
decision: BLOCKED (not forwarded)   session <id> → HALTED
```
Dashboard: `kill-switch HALTED | haltReason DRAWDOWN_BREACH`. MockUpstream call log shows **no** trade-5 entry.
**Say:** "Trade five. Data check passes, drawdown check fails. One named code — `DRAWDOWN_BREACH`. The call is not forwarded. The session is halted."

### Step 7 — Point out: Binance's own confirmation never saw it
**Do:** Show the MockUpstream call log (Pane A, `tail evidence/mockupstream-calls.log`) — trades 1–4 present, trade 5 absent.
**Say:** "Binance has its own confirm-before-execute step. It never even saw this trade — SessionGuard stopped it one layer earlier. The number that triggered the halt, −6.2%, was computed by SessionGuard's code from the fill ledger. No model produced it."

### Step 8 — The audit log: trade-by-trade P&L curve
**Do:** Pane B: `npm run audit:show -- --session <id>` — prints the ordered rows and an ASCII cumulative-P&L sparkline; or open `evidence/audit-<id>.jsonl`.
**Say:** "Every call is here — allowed and blocked — with the full state snapshot at each point. This is the curve that led to the halt. A human reads this and decides whether −5% was the right line."
**On screen:** the 5 `TOOL_CALL` rows, `outcome` column `ALLOWED ×4, BLOCKED ×1`, drawdown column `-0.06 → -2.1 → -3.8 → -6.2 → -6.2`.

### Step 9 — Same sequence, no supervisor
**Do:** Pane B: `npm run baseline:show` — prints `evidence/results.csv` and `evidence/headline.txt`.
**Expect CSV rows** (illustrative shape):
```
scenario,mode,halted,halt_trade_index,final_drawdown_pct,trades_executed,fee_to_gross_pnl
drawdown,supervised,true,5,-6.2,4,0.11
drawdown,unsupervised,false,,-14.9,8,0.19
velocity,supervised,true,6,-3.1,5,0.42
velocity,unsupervised,false,,-9.7,12,0.68
ladder,supervised,true,2,-4.0,1,0.09
ladder,unsupervised,false,,-22.5,6,0.14
data-loss,supervised,true,3,-3.2,2,0.10
data-loss,unsupervised,false,,-11.0,6,0.15
```
**Say (read the generated line verbatim):** "*Across 4 scripted losing sessions, SessionGuard halted before further loss in every case; the unsupervised agent kept trading through all 4, ending on average 2.4× deeper in drawdown.*" (Exact wording comes from `headline.txt`, not from me.)

### Step 10 — Loosen config live, re-arm, resume
**Do:** Pane B:
```
curl -s -H "x-admin-token: $SESSIONGUARD_ADMIN_TOKEN" -d '{"drawdownPctLimit":"15"}' 127.0.0.1:<admin>/admin/config
curl -s -H "x-admin-token: $SESSIONGUARD_ADMIN_TOKEN" -X POST 127.0.0.1:<admin>/admin/rearm
npm run agent -- --scenario happy --step 1
```
**Expect:** `CONFIG_CHANGE` row (`configVersion 1 → 2`), `RESET` row (new `sessionId`, fresh `1000.00` baseline), then the next trade `ALLOWED`. Dashboard: `kill-switch ACTIVE | drawdown 0.0% | configVersion 2`.
**Say:** "The operator decides −5% was too tight, sets −15%, re-arms. New session, fresh baseline, the config version is recorded in every row from here. The agent trades again."

### Step 11 — Close
**Say verbatim:** "Every guardrail built for this hackathon checks if one ticket is too big. The trades that actually blew up real accounts — the $31,000 Claude thread, the bot that lost $8,000 in seven seconds — were all individually legal. SessionGuard is the layer that remembers what happened five trades ago. That's the layer nobody else built."

---

## 2. Optional B-roll (after the timed run, ~40s)

Show the other two codes fire, same deterministic runner:

- `npm run agent -- --scenario velocity` → trades 1–5 allowed, trade 6 `BLOCKED VELOCITY_EXCEEDED — 6 trades in 900s exceeds 5`. (~15s)
- `npm run agent -- --scenario data-loss` → MockUpstream returns a 30-second-stale price on read 3 → `BLOCKED DATA_UNAVAILABLE — market price stale (32s > 10s limit). No data, no trade.` (~15s)
- One-line: "Four codes: `DRAWDOWN_BREACH`, `VELOCITY_EXCEEDED`, `LADDER_DETECTED`, `DATA_UNAVAILABLE`. Every rejection is exactly one of them."

---

## 3. Exact terminal lines to have on screen (for subtitles / thumbnail)

| Moment | Line |
|---|---|
| Boot | `ToolCatalog resolved: 8/8 required capabilities` |
| Boot | `session 7f3a… ACTIVE  starting equity 1000.00 USDT` |
| Trade 1 | `ALLOWED  BTCUSDT BUY 0.01 → forwarded → fill 0.01 @ 60000` |
| Trade 5 | `DRAWDOWN_BREACH — session drawdown -6.2% exceeds -5.0% limit. Trading halted.` |
| Trade 5 | `decision: BLOCKED (not forwarded)   session 7f3a… → HALTED` |
| Step 9 | the generated `headline.txt` sentence |
| Step 10 | `RESET  new session b21c…  baseline 1000.00 USDT  configVersion 2` |

---

## 4. Failure recovery during recording

| If… | Do |
|---|---|
| a scenario step hangs | Ctrl-C Pane B, `npm run demo:reset`, restart from Step 3 — MockUpstream is deterministic, the run is identical |
| dashboard shows stale numbers | it polls `/state` every 1s; refresh the tab; numbers are authoritative from `sessionStore` |
| audit sparkline looks wrong | `npm run audit:show` reconstructs purely from JSONL rows (INV-11) — if it disagrees with the live run, that is a bug, not a display glitch; do not ship |
| tempted to use the live endpoint to "make it real" | don't — D-0: live fill is post-submit only; MockUpstream evidence is the submission |

---

## 5. What the video must contain for Track A (cross-ref PRD §12)

- [ ] SessionGuard booting and resolving the Agent OS tool catalog (shows it is built on Agent OS's MCP surface).
- [ ] A trade forwarded through the proxy to the (mock) Agent OS endpoint and a fill returning.
- [ ] A trade **blocked** with a named code before forwarding.
- [ ] The audit log reconstructing the run.
- [ ] The supervised-vs-unsupervised headline sentence from `evidence/results.csv`.
- [ ] Live config change + re-arm + resume.
- [ ] Total length within the platform's video limit; GitHub URL shown in the final frame.
