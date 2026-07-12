# datasieve-mcp — installation guide for AI agents

This file is for an AI assistant (Cline, Claude, Cursor, …) installing the
DataSieve MCP server on a user's behalf. Follow it top to bottom; every step is
non-interactive.

## What this server does

DataSieve is standing infrastructure for agents, paid per use over x402 (HTTP
402 + USDC on Base — no account, no API key, the wallet is the identity):

- **Watch the chain** — wallet activity, whale transfers, price crossings, new pools (Base)
- **Watch the web** — url-change monitoring, scoped by CSS selector or regex
- **Dead-man switches** — the user's agent pings a URL; silence fires an alert
- **Cron schedules** — fire a webhook every N seconds, at a time, or on a cron expression
- **Multi-agent coordination** — barriers (fan-in) and locks with auto-expiring leases

Most tools are **free** (status, event drain, heartbeat pings, receipt
verification, health). Only the buying tools spend money, and failed calls are
never billed.

## Step 1 — install with no wallet (always works)

Requires Node 22+. No build step, no clone needed — the package is on npm.

```json
{
  "mcpServers": {
    "datasieve": {
      "command": "npx",
      "args": ["-y", "datasieve-mcp"]
    }
  }
}
```

For Claude Code: `claude mcp add datasieve -- npx -y datasieve-mcp`

Verify: call the `service_health` tool. It is free and returns the live
scanner state. If it succeeds, installation is complete.

## Step 2 (optional) — enable purchases

Only needed when the user wants to buy watches. Ask the user for a **dedicated
burner wallet key** holding a few dollars of USDC on Base (payments are gasless
EIP-3009 — no ETH needed). Never accept their main wallet key.

Write the key to a file rather than embedding it in config:

```sh
echo '0xTHEIR_BURNER_KEY' > ~/.datasieve/key.txt && chmod 600 ~/.datasieve/key.txt
```

Then add the environment variable to the server config:

```json
{
  "mcpServers": {
    "datasieve": {
      "command": "npx",
      "args": ["-y", "datasieve-mcp"],
      "env": { "DATASIEVE_PRIVATE_KEY_FILE": "/home/USER/.datasieve/key.txt" }
    }
  }
}
```

Verify: call `payment_status` — it reports the wallet address, USDC balance,
and all prices without spending anything.

## Step 3 (optional) — sandbox rehearsal

To test purchases with free faucet USDC (https://faucet.circle.com, Base
Sepolia), add a second server entry with
`"DATASIEVE_API_URL": "https://staging.datasieve.xyz"`. Sandbox watches last
1 hour.

## Troubleshooting

- **`npx` cannot find the package** — ensure Node ≥ 22 (`node --version`).
- **`payment_status` shows no wallet** — the key file path in `env` must be
  absolute; `~` is not expanded.
- **A paid call returned 402 repeatedly** — the wallet lacks USDC on Base
  (mainnet) or Base Sepolia (sandbox). Check `payment_status.balance`.
- **Purchases fail but the user was not charged** — correct behavior: failed
  settlements roll back their side effects and are never billed. Retry with a
  fresh request.

## Tool inventory

Free: `service_health`, `payment_status`, `watch_status`, `drain_events`,
`ping_heartbeat`, `pause_watch`, `resume_watch`, `verify_receipt`,
`delete_watch`, `coord_barrier`, `coord_arrive`, `coord_lock`, `coord_release`,
`coord_events`.

Paid: `create_watch` ($0.10–$0.85 by tier), `renew_watch` (tier price),
`coord_workspace` ($0.25), `cron_next` ($0.001), `x402_ping` ($0.001).
