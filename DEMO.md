# SessionGuard — DEMO.md

The judge demo. **Deterministic**: every trade, fill, and price comes from **MockUpstream**
replaying a scenario file (D-0, D-7). Nothing depends on live-market timing, token state, or
Binance availability.

Every command, terminal line, and number below is **exactly what the current build emits** — pulled
from a live run of this repo, not illustrative. If a run disagrees with this document, the run is
authoritative and this document is stale; re-capture it.

Terminology: `PRD.md` §9; call flow in `ARCHITECTURE.md` §4–5.

---

## 0. How the demo is actually wired (read this first)

Two things both called "SessionGuard" run in the demo, and they are **separate processes**:

| Pane | Command | What it is |
|---|---|---|
| **A — the proxy** | `npm run mock` then `npm run dev` | The long-running SessionGuard MCP proxy. Boots, resolves the Agent OS tool catalog from MockUpstream's `tools/list`, arms a session, serves the inbound MCP surface on `127.0.0.1:8788/mcp`, the admin + `/state` surface on `127.0.0.1:8789`, and repaints a terminal dashboard every 1 s. This is what a live MCP agent (Claude Code, post-submit) would connect to. |
| **B — the scripted harness** | `npm run agent -- --scenario <name>` | The deterministic scenario runner (`1b`, PRD §5.1). It builds SessionGuard's **real rule pipeline** in-process against its **own** ephemeral MockUpstream, drives the scripted `trade.placeOrder` sequence to completion, prints a JSON `RunReport`, and writes `evidence/audit-<sessionId>.jsonl`. It does **not** connect to Pane A. |

The scripted scenarios (drawdown / velocity / ladder / data-loss / happy) run entirely through Pane B
and carry the evidence. Pane A is shown to prove the proxy boots, resolves the Agent OS MCP surface,
and exposes live state. The config-swap + re-arm beat (Step 10) operates on Pane A.

> `npm run start` is **broken** on Node ≥ 20.6 (`node --loader` was removed). Use `npm run dev`.

---

## 1. Pre-flight (before recording)

| # | Check | Command / expected |
|---|---|---|
| 0.1 | Node 20+, deps installed | `npm ci` |
| 0.2 | `config.json` at demo values | `drawdownPctLimit: "5"`, `velocityWindowSeconds: 900`, `velocityMaxTrades: 5`, `ladderMultipleLimit: "1.5"`, `allowedSymbols: ["BTCUSDT","ETHUSDT","BNBUSDT"]`, `priceStalenessSeconds: 10`, `dataFetchTimeoutMs: 3000`, `priceSanityMaxDeviationPct: "20"` (8 keys; the schema is `.strict()` and rejects any config missing `priceSanityMaxDeviationPct`) |
| 0.3 | `.env` upstream points at MockUpstream | `BINANCE_AGENT_OS_MCP_URL=http://127.0.0.1:8790/mcp`, `MOCK_UPSTREAM_PORT=8790`, `NODE_ENV=demo`. The live `https://agent.binance.com/mcp/agentic` line stays commented (D-0). |
| 0.4 | Scenario files present | `evidence/scenarios/{happy,drawdown,velocity,ladder,data-loss}.json` |
| 0.5 | Suite green | `npm test` → `Test Files 11 passed (11)`, `Tests 81 passed (81)` |
| 0.6 | Two terminal panes | Pane A: MockUpstream + proxy. Pane B: the scenario runner + `audit:show` + `baseline`. No browser tab — the dashboard is terminal-only and `GET /state` is JSON (D-10 T4). |
| 0.7 | Baseline evidence regenerated | `npm run baseline` → rewrites `evidence/results.csv` + `evidence/headline.txt` (re-running reproduces them byte-for-byte) |

Reset between takes: `npm run demo:reset` (deletes `evidence/audit-*.jsonl`, `evidence/fills-*.jsonl`,
`evidence/mockupstream-calls.log`; it does **not** re-arm — restart Pane A for a fresh session).

---

## 2. The script (10 beats)

### Beat 1 — The proxy boots and resolves the Agent OS catalog
**Do:** Pane A, first terminal:
```
MOCK_LOG_FILE=evidence/mockupstream-calls.log npm run mock
```
→ `MockUpstream listening on http://127.0.0.1:8790/mcp`

Pane A, second terminal:
```
npm run dev
```
**Expect** (boot lines, in order):
```
ToolCatalog resolved: 8/8 capabilities (3/3 required). Excluded 2 transfer/withdraw/futures/margin tools.
session <uuid> ACTIVE  starting equity 1000 USDT
inbound MCP proxy listening on http://127.0.0.1:8788/mcp
admin + /state listening on http://127.0.0.1:8789
```
then, repainting every second:
```
┌─ SessionGuard ─────────────────────────────────
│ kill-switch : ● ACTIVE
│ P&L         : 0 USDT  (real 0 / unreal 0)
│ drawdown    : 0%   limit -5%
│ velocity    : 0/5 in 900s
│ config ver  : 1
└────────────────────────────────────────────────
```
**Say:** "SessionGuard is a stateful MCP proxy. It resolved eight logical capabilities from Binance's
Agent OS `tools/list` — three required, all present — and it excluded the two withdrawal/futures
tools the mock advertised. It has no LLM; every decision is deterministic code."

### Beat 2 — State the config on screen
**Do:** Pane B: `cat config.json`
**Say:** "Two limits carry the demo: session drawdown capped at **−5%**, and **5 trades per
15 minutes**. They live in `config.json`. The agent cannot see or change them."

### Beat 3 — Run the drawdown scenario end-to-end
**Do:** Pane B:
```
npm run agent -- --scenario drawdown
```
This runs the whole 7-ticket sequence (BTCUSDT BUY MARKET 0.1 each, scripted losing marks,
`startingEquity` 10000) in one command and prints a `RunReport`:
```json
{
  "name": "drawdown",
  "mode": "supervised",
  "outcomes": ["ALLOWED","ALLOWED","ALLOWED","ALLOWED","DRAWDOWN_BREACH","DRAWDOWN_BREACH","DRAWDOWN_BREACH"],
  "halted": true,
  "haltAtIndex": 4,
  "terminalCode": "DRAWDOWN_BREACH",
  "drawdownAtHalt": "-7.6374",
  "finalDrawdownPct": "-29.6374",
  "tradesExecuted": 4,
  "feeToGrossPnl": "0.008074829931972789115646258503401361",
  "auditPath": "evidence\\audit-<sessionId>.jsonl"
}
```
**Say:** "Four trades allowed and forwarded. Each one is small and individually fine — a per-trade
validator sees nothing wrong. But SessionGuard is adding them up."

### Beat 4 — The block, with one named code
**Do:** Pane B: open the audit file from `auditPath`, or jump ahead to Beat 5's reconstruction.
The 5th ticket's row carries:
```
rule DRAWDOWN  pass:false  observed:-7.6374  threshold:-5
detail: "Session drawdown -7.6374% exceeds -5% limit. Trading halted."
outcome: BLOCKED   code: DRAWDOWN_BREACH
```
`outcomes[4] = "DRAWDOWN_BREACH"`; the session flips to `HALTED`. Tickets 6 and 7 are rejected at the
kill-switch short-circuit with the same stored code (that is why `outcomes` ends with three
`DRAWDOWN_BREACH` entries, and the audit shows `blocked 3`).
**Say:** "Trade five. Data check passes, drawdown check fails. One named code — `DRAWDOWN_BREACH`.
`observed`, −7.6374, is computed by SessionGuard's code from the fill ledger. No model produced it.
The call is not forwarded. The session is halted."

### Beat 5 — The audit log: trade-by-trade drawdown curve
**Do:** Pane B (`--session` and `--path` both resolve the same file):
```
npm run audit:show -- --session <sessionId>
```
**Expect:**
```
session <sessionId>   allowed 4  blocked 3  terminal DRAWDOWN_BREACH
trade-by-trade cumulative drawdown %:
  #  2  ALLOWED                         0.00%
  #  3  ALLOWED                        -0.46%  ██
  #  4  ALLOWED                        -1.32%  ███████
  #  5  ALLOWED                        -3.18%  █████████████████
  #  6  BLOCKED  DRAWDOWN_BREACH       -7.64%  ████████████████████████████████████████
  #  7  BLOCKED  DRAWDOWN_BREACH        0.00%
  #  8  BLOCKED  DRAWDOWN_BREACH        0.00%
```
Rows `#2`–`#8` are the seven `TOOL_CALL` rows (`#1` is `SESSION_START`). The two trailing `0.00%`
rows are the post-halt kill-switch rejections — they never reached the rule pipeline, so their state
snapshot is empty.
**Say:** "Every call is here, allowed and blocked, reconstructed from the JSONL alone. This is the
curve that led to the halt. A human reads it and decides whether −5% was the right line."

### Beat 6 — Binance's own confirmation never saw the blocked trade
**Do:** Pane A: `cat evidence/mockupstream-calls.log` (written because Beat 1 set `MOCK_LOG_FILE`).
The scripted harness in Pane B uses its **own** in-process mock, so its blocked ticket is proven by
`RunReport.tradesExecuted: 4` and the audit `outcome: BLOCKED` row — the forward never happened. On
Pane A's proxy, a blocked trade returns a structured MCP error **before** `passthrough.forward` is
called.
**Say:** "Binance has its own confirm-before-execute step. A trade SessionGuard blocks never reaches
it — it is stopped one layer earlier."

### Beat 7 — Same three losing patterns, all four codes
**Do:** Pane B, one command each:
```
npm run agent -- --scenario velocity
npm run agent -- --scenario ladder
npm run agent -- --scenario data-loss
```
**Expect** (the halting facts from each `RunReport`):

| scenario | `outcomes` | `haltAtIndex` | `terminalCode` | blocking rule `detail` |
|---|---|---|---|---|
| velocity | `ALLOWED ×5, VELOCITY_EXCEEDED` | 5 | `VELOCITY_EXCEEDED` | `5 trades in 900s exceeds 5. Trading halted.` (`observed 5`, `threshold 5`) |
| ladder | `ALLOWED ×2, LADDER_DETECTED ×3` | 2 | `LADDER_DETECTED` | `Size 3x the prior losing trade on BTCUSDT exceeds 1.5x. Trading halted.` (`observed 3`, `threshold 1.5`) |
| data-loss | `ALLOWED ×2, DATA_UNAVAILABLE` | 2 | `DATA_UNAVAILABLE` | `Market price for BTCUSDT unavailable (stale: upstream timestamp older than priceStalenessSeconds). No data, no trade.` |

**Say:** "Four codes: `DRAWDOWN_BREACH`, `VELOCITY_EXCEEDED`, `LADDER_DETECTED`, `DATA_UNAVAILABLE`.
Every rejection is exactly one of them. Velocity blocks the call that would be the sixth in the
window. Ladder blocks a 3× size-up after a realised loss on the same symbol. Data-loss fails closed
on a stale price — no data, no trade."

### Beat 8 — Same sequences, no supervisor
**Do:** Pane B:
```
npm run baseline
npm run baseline:show
```
**Expect** `evidence/results.csv`:
```
scenario,mode,halted,halt_trade_index,final_drawdown_pct,trades_executed,fee_to_gross_pnl
drawdown,supervised,true,4,-7.64,4,0.0081
drawdown,unsupervised,false,,-38.3,7,0.0106
velocity,supervised,true,5,0,5,inf
velocity,unsupervised,false,,0,6,inf
ladder,supervised,true,2,-1.12,2,0.119
ladder,unsupervised,false,,-35.29,5,0.0378
```
and `evidence/headline.txt` (generated from the CSV, not typed):
> Across 3 scripted losing sessions, SessionGuard halted before further loss in every case
> (drawdown, velocity, ladder); the unsupervised agent never halted and kept trading through all 3,
> executing 7 more trades and ending on average 18.3x deeper in drawdown where drawdown applied.

**Say (read the generated line verbatim):** the sentence above. "Three losing sessions. SessionGuard
halted every one. The unsupervised agent halted none, ran seven extra trades, and where drawdown
applied it ended on average 18× deeper." (The baseline covers `drawdown`, `velocity`, `ladder`; the
`velocity` rows sit at 0% drawdown because that scenario's churn is fee-bleed, not directional loss —
`fee_to_gross_pnl` is `inf`.)

### Beat 9 — Loosen config live, re-arm, resume
**Do:** Pane B, against Pane A's admin port:
```
curl -s -H "x-admin-token: $SESSIONGUARD_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"drawdownPctLimit":"15"}' 127.0.0.1:8789/admin/config
curl -s -H "x-admin-token: $SESSIONGUARD_ADMIN_TOKEN" -X POST 127.0.0.1:8789/admin/rearm
curl -s 127.0.0.1:8789/state
```
**Expect:**
```
{"configChanged":true,"from":1,"to":2,"config":{ ... }}
{"rearmed":true,"prevSessionId":"<old>","sessionId":"<new>","startingEquity":"1000"}
{"runningPnlUsdt":"0","realizedPnlUsdt":"0","unrealizedPnlUsdt":"0","drawdownPct":"0",
 "tradeCountInWindow":0,"velocityWindowSeconds":900,"perSymbol":{},"killSwitch":"ACTIVE",
 "haltReason":null,"configVersion":2}
```
A `CONFIG_CHANGE` row (`from 1`, `to 2`) and a `RESET` row (new `sessionId`, fresh `1000` baseline)
are appended to the proxy's audit file; `/state` and the dashboard show `configVersion 2` and
`kill-switch ● ACTIVE`.
**Say:** "The operator version-bumps the config and re-arms. New session, fresh baseline, the config
version is stamped into every row from here."
> Note for the presenter: in this build the `SG_*` lines in `.env` mirror every threshold and take
> precedence over `config.json` and over a live `/admin/config` body, so the *value* of
> `drawdownPctLimit` stays `5` unless you also edit `SG_DRAWDOWN_PCT_LIMIT` (or remove it) and
> restart. What Beat 9 demonstrates is the versioning + audit-row + re-arm mechanics. The scripted
> `npm run agent` harness uses its own fixed config and is independent of both.

### Beat 10 — Close
**Say verbatim:** "Every guardrail built for this hackathon checks if one ticket is too big. The
trades that actually blew up real accounts — the $31,000 Claude thread, the bot that lost $8,000 in
seven seconds — were all individually legal. SessionGuard is the layer that remembers what happened
five trades ago. That's the layer nobody else built."

---

## 3. B-roll (optional, ~30 s)

The `happy` scenario, to show the allow path is unremarkable:
```
npm run agent -- --scenario happy
```
→ `outcomes: ["ALLOWED","ALLOWED","ALLOWED"]`, `halted: false`, `terminalCode: null`,
`finalDrawdownPct: "0.109825"`, `tradesExecuted: 3`. Three small BTCUSDT buys on a mild upward
drift, all forwarded, session stays `ACTIVE`.

---

## 4. Exact terminal lines to have on screen (subtitles / thumbnail)

| Moment | Line |
|---|---|
| Boot | `ToolCatalog resolved: 8/8 capabilities (3/3 required). Excluded 2 transfer/withdraw/futures/margin tools.` |
| Boot | `session <uuid> ACTIVE  starting equity 1000 USDT` |
| Boot | `inbound MCP proxy listening on http://127.0.0.1:8788/mcp` |
| drawdown RunReport | `"terminalCode": "DRAWDOWN_BREACH"`, `"haltAtIndex": 4`, `"drawdownAtHalt": "-7.6374"` |
| drawdown block detail | `Session drawdown -7.6374% exceeds -5% limit. Trading halted.` |
| audit:show | `session <id>   allowed 4  blocked 3  terminal DRAWDOWN_BREACH` |
| Beat 8 | the generated `headline.txt` sentence ("Across 3 scripted losing sessions … 18.3x deeper …") |
| Beat 9 | `{"rearmed":true,"prevSessionId":"<old>","sessionId":"<new>","startingEquity":"1000"}` |

---

## 5. Failure recovery during recording

| If… | Do |
|---|---|
| a scenario command errors | `npm run agent` is a single self-contained process — re-run it; MockUpstream is deterministic and the `RunReport` is identical. |
| the proxy dashboard looks stale | it repaints every 1 s; `curl 127.0.0.1:8789/state` is the authoritative JSON. |
| `audit:show` disagrees with the `RunReport` | that is a bug, not a display glitch — do not ship. |
| `npm run start` errors with `--loader` | expected on Node ≥ 20.6; use `npm run dev`. |
| port 8790 already bound | a previous `npm run mock` is still running — kill it, or set `MOCK_UPSTREAM_PORT` and `BINANCE_AGENT_OS_MCP_URL` to a free port. |
| tempted to use the live endpoint | don't — D-0: the live fill is post-submit only; MockUpstream evidence is the submission. |

---

## 6. What the video must contain for Track A (cross-ref PRD §12)

- [ ] SessionGuard booting and resolving the Agent OS tool catalog (`ToolCatalog resolved: 8/8 capabilities (3/3 required)`).
- [ ] A scripted trade sequence run through SessionGuard's rule pipeline against the (mock) Agent OS surface, with fills returning (`RunReport.tradesExecuted`).
- [ ] A trade **blocked** with a named code before forwarding (`terminalCode: "DRAWDOWN_BREACH"`, and the B-roll codes).
- [ ] The audit log reconstructing the run (`npm run audit:show`).
- [ ] The supervised-vs-unsupervised headline sentence from `evidence/results.csv` (3 losing scenarios).
- [ ] Live config version-bump + re-arm + resume against the running proxy.
- [ ] Total length within the platform's video limit; GitHub URL shown in the final frame.
