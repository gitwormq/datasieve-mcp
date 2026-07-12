# datasieve-mcp

MCP server for [DataSieve](https://datasieve.xyz) — standing infrastructure for
AI agents, paid over x402. On-chain conditions on Base (wallet activity, whale
transfers, price crossings, new pools), **url-change web monitoring** (CSS
selector / regex scoped), **dead-man switches for your own agents** (your agent
pings a URL; silence fires the alert), **cron schedules** (fire a webhook every
N seconds, at a time, or on a cron expression), and **multi-agent coordination**
(barriers + locks). Every event carries a signed Ed25519 observation receipt.
No account, no API key: one gasless USDC payment per watch, signed locally —
your key never leaves your machine. Failed calls are never billed.

## Setup — no key required to start

```sh
claude mcp add datasieve -- npx -y datasieve-mcp
```

Most tools work with **no wallet at all** — check our scanner's health, read
watch status, drain events, ping dead-man switches, pause/resume, verify
receipts, cancel watches. Only the buying tools spend money.

### The Claude Code skill (recommended)

```sh
npx -y datasieve-mcp --install-skill
```

Installs a skill into `~/.claude/skills/datasieve/` that teaches Claude when to
reach for standing infrastructure proactively: arm a dead-man switch before
long autonomous work, schedule wake-ups, watch pages and wallets, coordinate
sub-agents.

### When you want to buy

x402 means paying is a signature, so purchases need a key. Two rules:

1. **Use a dedicated burner wallet** holding a few dollars of USDC on Base —
   never your main wallet. Payments are gasless (EIP-3009), so it needs no ETH.
2. **Keep the key out of config files** — point at a file instead:

```sh
echo '0xYOUR_BURNER_KEY' > ~/.datasieve/key.txt && chmod 600 ~/.datasieve/key.txt
claude mcp add datasieve -e DATASIEVE_PRIVATE_KEY_FILE=$HOME/.datasieve/key.txt -- npx -y datasieve-mcp
```

(`DATASIEVE_PRIVATE_KEY=0x...` inline also works if you prefer.)

The key never leaves the process: each payment is a signature authorizing
**exactly** the route price — one at a time, nothing standing. Run
`payment_status` to see the wallet, its balance, and prices before spending
anything.

### Rehearse for free

```sh
claude mcp add datasieve-sandbox -e DATASIEVE_API_URL=https://staging.datasieve.xyz \
  -e DATASIEVE_PRIVATE_KEY_FILE=$HOME/.datasieve/key.txt -- npx -y datasieve-mcp
```

Same API, Base Sepolia, [faucet USDC](https://faucet.circle.com). Sandbox
watches last 1 hour.

## Tools

| tool | cost | what |
|---|---|---|
| `create_watch` | $0.10 (standard/7d) · $0.25 (composite/7d, ≤5 conditions) · $0.35 (standard30/30d) · $0.85 (composite30/30d) | buy a watch; returns id, secret, ping URLs |
| `renew_watch` | tier price | one more period, trigger budget reset |
| `coord_workspace` | $0.25 / 7d | multi-agent barriers + locks; every op after is free |
| `cron_next` | $0.001 | parse a cron expression: next N run times, any timezone |
| `x402_ping` | $0.001 | end-to-end payment stack self-test |
| `watch_status` | free | heartbeat, triggers, expiry, up/down per dead-man switch |
| `drain_events` | free | collect everything caught while you weren't running |
| `pause_watch` / `resume_watch` | free | stop firing without deleting; backlog-free resume |
| `ping_heartbeat` | free | keep your dead-man switch alive |
| `verify_receipt` | free | check the Ed25519 receipt on any delivered event |
| `coord_barrier` / `coord_arrive` / `coord_lock` / `coord_release` / `coord_events` | free | workspace ops |
| `delete_watch` | free | cancel |
| `service_health` | free | verify our scanner is alive before you pay |
| `payment_status` | free | wallet address, USDC balance, prices — "can I buy?" |

Watch ids and secrets are remembered in `~/.datasieve/watches.json` (mode 600),
so follow-up calls only need the watch id — the persistent memory your
ephemeral agent lacks.
