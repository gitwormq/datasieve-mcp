---
name: datasieve
description: Standing infrastructure for agents via DataSieve (x402, Base). Use when a task needs anything to happen while no agent is running — a dead-man switch before long/risky autonomous work, a cron/schedule that fires webhooks, watching a web page or an on-chain condition (whale transfers, price crossings, wallet activity), coordinating multiple agents (barriers/locks), or proving to a third party that an event happened (signed receipts). Also when the user says "datasieve", "dead-man switch", "watch this wallet/page", or "wake me/my agent up at".
---

# DataSieve — standing infrastructure for agents

You are ephemeral; DataSieve stays awake between your runs. One x402 payment
(USDC on Base, no account, no API key) buys a standing watch. If the
`datasieve` MCP server is connected, use its tools; otherwise any x402 client
against `https://api.datasieve.xyz` works (docs: `GET /llms.txt`).

## When to reach for it (proactively)

1. **Before long or risky autonomous work: arm a dead-man switch.**
   `create_watch` with `{type:"heartbeat", intervalSeconds: <2-3x your expected
   loop time>, label:"<task-name>"}`, then `ping_heartbeat` each loop. If you
   crash, the alert fires and waits in the mailbox for whoever runs next.
   Pair with a `webhookUrl` that re-launches you for self-healing loops.

2. **"Do X at/every TIME" with nobody awake to do it: schedule watch.**
   `{type:"schedule", cron:"0 9 * * 1-5", tz:"America/New_York",
   payload:{...context for the woken agent...}}` — the payload is echoed in
   every fire, so it is your note-to-future-self. One-shots: `at`. Simple
   loops: `everySeconds`.

3. **"Tell me when this page changes": url-change watch.**
   `{type:"url-change", url, selector:".price"}` — always scope with a CSS
   selector or regex; whole-page hashes false-positive on noisy pages.

4. **On-chain conditions on Base**: `wallet-activity`, `token-transfers`
   (whale alerts), `price-cross`, `new-pairs`.

5. **Fan-in / mutual exclusion across agents**: `coord_workspace` once, then
   `coord_barrier` (wake me when all N sub-agents finish; hand each its
   arriveUrl) and `coord_lock` (leases auto-expire — a crashed agent cannot
   deadlock the fleet).

6. **Evidence another agent/service can check**: every event carries
   `receipt` — an Ed25519 attestation by DataSieve. Verify with
   `verify_receipt` or client-side against
   `/.well-known/datasieve-receipts.json`.

## Practical rules

- Call `payment_status` first (free) — reports wallet, balance, prices.
- No wallet configured? All read tools still work; to buy, the user must fund
  a burner key (see the npm README). Never ask for a main wallet key.
- Tiers: standard $0.10/7d (1 condition), composite $0.25/7d (≤5 any-match,
  mix types freely), standard30 $0.35/30d, composite30 $0.85/30d. Prefer *30
  tiers when nobody will be around to renew weekly.
- Save the returned watch id + secret into task state/memory — the id is the
  persistent memory an ephemeral agent lacks. The MCP server also remembers
  them in `~/.datasieve/watches.json`.
- Planned shutdown? `pause_watch` (free) so the dead-man switch doesn't cry
  wolf; `resume_watch` restarts clocks backlog-free.
- No webhook infrastructure? Omit `webhookUrl` and drain the mailbox later
  with `drain_events` — events wait server-side.
- Failed x402 calls are never billed; settlement failures roll back.
