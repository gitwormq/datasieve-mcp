#!/usr/bin/env node
/**
 * DataSieve MCP server — buy standing watches (on-chain conditions on Base,
 * or dead-man switches for your own agents) over x402, from any MCP client.
 *
 * Config (env):
 *   DATASIEVE_PRIVATE_KEY  0x… EVM key holding USDC on Base (payments are
 *                          gasless EIP-3009 transfers; the key never leaves
 *                          this process). Omit to use only the free tools.
 *   DATASIEVE_API_URL      default https://api.datasieve.xyz
 *                          (sandbox: https://staging.datasieve.xyz, faucet USDC)
 *   DATASIEVE_STATE_FILE   default ~/.datasieve/watches.json — remembers watch
 *                          secrets so later tool calls don't need them.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = (process.env.DATASIEVE_API_URL ?? 'https://api.datasieve.xyz').replace(/\/$/, '');
const STATE_FILE = process.env.DATASIEVE_STATE_FILE ?? join(homedir(), '.datasieve', 'watches.json');

// `npx datasieve-mcp --install-skill` copies the bundled Claude Code skill to
// ~/.claude/skills/datasieve/ so Claude proactively reaches for standing
// infrastructure (dead-man switches before long tasks, schedules, watches).
if (process.argv.includes('--install-skill')) {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'skill', 'SKILL.md');
  const dest = join(homedir(), '.claude', 'skills', 'datasieve', 'SKILL.md');
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`Installed the DataSieve skill to ${dest}`);
  process.exit(0);
}

// ---- local state: watchId -> secret (never sent anywhere but the API) -------

type WatchMemo = { secret: string; tier?: string; pingUrls?: string[] };
type CoordMemo = { secret: string; arriveUrls?: Record<string, string> };

function loadState(): Record<string, WatchMemo> {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Record<string, WatchMemo>;
  } catch {
    return {};
  }
}

function saveState(state: Record<string, WatchMemo>): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function rememberWatch(id: string, memo: WatchMemo): void {
  const s = loadState();
  s[id] = memo;
  saveState(s);
}

function secretFor(id: string, provided?: string): string | undefined {
  return provided ?? loadState()[id]?.secret;
}

function rememberCoord(id: string, memo: CoordMemo): void {
  rememberWatch(id, memo as WatchMemo);
}

// ---- x402-paying fetch (lazy: free tools work with no key) -------------------

/**
 * The buying key, from an env var or (preferred) a file so it never lands in a
 * config JSON or shell history. Only the two paid tools need it; everything
 * else works with no key at all.
 */
function buyingKey(): string | undefined {
  const file = process.env.DATASIEVE_PRIVATE_KEY_FILE;
  if (file) {
    try {
      const k = readFileSync(file, 'utf8').trim();
      if (/^0x[0-9a-fA-F]{64}$/.test(k)) return k;
    } catch {
      /* fall through to env */
    }
  }
  const env = process.env.DATASIEVE_PRIVATE_KEY?.trim();
  return env && /^0x[0-9a-fA-F]{64}$/.test(env) ? env : undefined;
}

const NO_KEY_HELP =
  'No buying key configured, so paid tools are disabled (every free tool still works: ' +
  'service_health, watch_status, drain_events, ping_heartbeat, delete_watch).\n\n' +
  'To enable purchases, use a DEDICATED BURNER WALLET holding a few dollars of USDC on Base — ' +
  'never your main wallet. Then either:\n' +
  '  DATASIEVE_PRIVATE_KEY_FILE=/path/to/key.txt   (recommended: keeps the key out of config files)\n' +
  '  DATASIEVE_PRIVATE_KEY=0x...\n\n' +
  'The key never leaves this process: payments are gasless EIP-3009 signatures for the exact ' +
  'route price (a few cents), authorized one at a time. Rehearse for free first with ' +
  'DATASIEVE_API_URL=https://staging.datasieve.xyz and Base Sepolia faucet USDC.';

let payFetchPromise: Promise<typeof fetch> | null = null;
function payFetch(): Promise<typeof fetch> {
  if (!payFetchPromise) {
    payFetchPromise = (async () => {
      const key = buyingKey();
      if (!key) throw new Error(NO_KEY_HELP);
      const [{ privateKeyToAccount }, { wrapFetchWithPayment, x402Client }, { ExactEvmScheme }] =
        await Promise.all([
          import('viem/accounts'),
          import('@x402/fetch'),
          import('@x402/evm/exact/client'),
        ]);
      const account = privateKeyToAccount(key as `0x${string}`);
      const scheme = new ExactEvmScheme(account);
      // Register mainnet and Sepolia: the wrapper pays whichever the server asks for.
      const client = new x402Client()
        .register('eip155:8453', scheme)
        .register('eip155:84532', scheme);
      return wrapFetchWithPayment(fetch, client) as typeof fetch;
    })();
    payFetchPromise.catch(() => (payFetchPromise = null));
  }
  return payFetchPromise;
}

// ---- helpers ------------------------------------------------------------------

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${message}` }], isError: true };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

const conditionShape = z
  .object({
    type: z.enum(['wallet-activity', 'token-transfers', 'price-cross', 'new-pairs', 'heartbeat', 'schedule', 'url-change']),
  })
  .passthrough()
  .describe(
    'One condition. Shapes: {type:"wallet-activity",address,direction?,minEth?} | ' +
      '{type:"token-transfers",token,minAmount} | {type:"price-cross",pool,direction,threshold} | ' +
      '{type:"new-pairs",minQuoteLiquidity?} | {type:"heartbeat",intervalSeconds,graceSeconds?,label?} | ' +
      '{type:"schedule",everySeconds|at|cron,tz?,payload?,label?} | ' +
      '{type:"url-change",url,selector?,regex?,pollSeconds?,label?} ' +
      '(heartbeat = dead-man switch: silence fires the alert. schedule = cron for agents: fire a webhook/mailbox event every N seconds, at a time, or on a cron expression. ' +
      'url-change = watch a public web page: fires when content scoped by CSS selector/regex actually changes, poll floor 300s)',
  );

// ---- server ---------------------------------------------------------------------

const server = new McpServer({ name: 'datasieve', version: '0.4.0' });

server.registerTool(
  'create_watch',
  {
    title: 'Create a watch (paid via x402)',
    description:
      `Buy a standing watch from DataSieve (${API}). standard = $0.10/7d, 1 condition, 50 triggers; ` +
      'composite = $0.25/7d, up to 5 any-match conditions (e.g. 5 heartbeat dead-man switches), 200 triggers; ' +
      'standard30 = $0.35/30d and composite30 = $0.85/30d — one payment covers the month, for agents that ' +
      'will not be awake to renew weekly. ' +
      'Payment is a gasless USDC transfer signed locally. Events go to your webhookUrl (HMAC-signed) if set, ' +
      'and always to a server-side mailbox drained with drain_events; every event carries a signed Ed25519 ' +
      'observation receipt you can replay to third parties. Failed calls are never billed. ' +
      'The watch id + secret are remembered locally so later calls need only the id.',
    inputSchema: {
      tier: z.enum(['standard', 'composite', 'standard30', 'composite30']).default('standard'),
      conditions: z.array(conditionShape).min(1).max(5),
      webhookUrl: z.string().url().optional(),
    },
  },
  async ({ tier, conditions, webhookUrl }) => {
    try {
      const fetchPay = await payFetch();
      const body = tier.startsWith('standard')
        ? { condition: conditions[0], ...(webhookUrl ? { webhookUrl } : {}) }
        : { conditions, ...(webhookUrl ? { webhookUrl } : {}) };
      const res = await fetchPay(`${API}/watch/${tier}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await json(res);
      if (res.status !== 201) return fail(`create failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
      const heartbeats = (data.heartbeats as Array<{ pingUrl?: string }> | undefined) ?? [];
      rememberWatch(String(data.id), {
        secret: String(data.secret),
        tier,
        pingUrls: heartbeats.map((h) => h.pingUrl).filter((u): u is string => !!u),
      });
      return ok(data);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  'watch_status',
  {
    title: 'Watch status (free)',
    description:
      'State, heartbeat lastCheckedAt, triggersUsed/cap, expiry, delivery stats, and for dead-man ' +
      'switches: up/down, lastPingAt, nextDeadline, pingUrl. Secret is looked up from local state if omitted.',
    inputSchema: { watchId: z.string(), secret: z.string().optional() },
  },
  async ({ watchId, secret }) => {
    const s = secretFor(watchId, secret);
    if (!s) return fail(`no secret known for ${watchId}; pass it explicitly`);
    const res = await fetch(`${API}/watch/${watchId}`, { headers: { authorization: `Bearer ${s}` } });
    const data = await json(res);
    return res.ok ? ok(data) : fail(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  },
);

server.registerTool(
  'drain_events',
  {
    title: 'Drain held events (free)',
    description:
      'Collect everything the watch caught — works with zero infrastructure (the mailbox pattern). ' +
      'Pass `since` = last seen event id for incremental drains.',
    inputSchema: { watchId: z.string(), since: z.string().optional(), secret: z.string().optional() },
  },
  async ({ watchId, since, secret }) => {
    const s = secretFor(watchId, secret);
    if (!s) return fail(`no secret known for ${watchId}; pass it explicitly`);
    const q = since ? `?since=${encodeURIComponent(since)}` : '';
    const res = await fetch(`${API}/watch/${watchId}/events${q}`, {
      headers: { authorization: `Bearer ${s}` },
    });
    const data = await json(res);
    return res.ok ? ok(data) : fail(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  },
);

server.registerTool(
  'renew_watch',
  {
    title: 'Renew a watch (paid via x402)',
    description:
      'Extends the watch one more period (7 days, or 30 on the *30 tiers) at its tier price and ' +
      'resets the trigger budget. Renewing a paused watch also reactivates it.',
    inputSchema: { watchId: z.string(), tier: z.enum(['standard', 'composite', 'standard30', 'composite30']).optional() },
  },
  async ({ watchId, tier }) => {
    try {
      const t = tier ?? loadState()[watchId]?.tier ?? 'standard';
      const fetchPay = await payFetch();
      const res = await fetchPay(`${API}/watch/${t}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ renew: watchId }),
      });
      const data = await json(res);
      return res.ok ? ok(data) : fail(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  'delete_watch',
  {
    title: 'Cancel a watch (free, no refund)',
    inputSchema: { watchId: z.string(), secret: z.string().optional() },
  },
  async ({ watchId, secret }) => {
    const s = secretFor(watchId, secret);
    if (!s) return fail(`no secret known for ${watchId}; pass it explicitly`);
    const res = await fetch(`${API}/watch/${watchId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${s}` },
    });
    const data = await json(res);
    return res.ok ? ok(data) : fail(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  },
);

const pauseResume = (action: 'pause' | 'resume') =>
  async ({ watchId, secret }: { watchId: string; secret?: string | undefined }) => {
    const s = secretFor(watchId, secret);
    if (!s) return fail(`no secret known for ${watchId}; pass it explicitly`);
    const res = await fetch(`${API}/watch/${watchId}/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s}` },
    });
    const data = await json(res);
    return res.ok ? ok(data) : fail(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  };

server.registerTool(
  'pause_watch',
  {
    title: 'Pause a watch (free)',
    description:
      'Stop a watch firing (chain, web, heartbeat, schedule) without deleting it. The expiry ' +
      'clock keeps running. Use before a planned agent shutdown so your dead-man switch does not ' +
      'cry wolf.',
    inputSchema: { watchId: z.string(), secret: z.string().optional() },
  },
  pauseResume('pause'),
);

server.registerTool(
  'resume_watch',
  {
    title: 'Resume a paused watch (free)',
    description:
      'Backlog-free resume: heartbeat deadlines restart from now and schedules jump to their next ' +
      'FUTURE slot — nothing that elapsed during the pause replays.',
    inputSchema: { watchId: z.string(), secret: z.string().optional() },
  },
  pauseResume('resume'),
);

server.registerTool(
  'cron_next',
  {
    title: 'Parse a cron expression (paid via x402, $0.001)',
    description:
      'Next N run times for a cron expression in any IANA timezone, plus seconds-until-next. ' +
      'If the goal is for something to HAPPEN at those times, create_watch with a schedule ' +
      'condition instead — DataSieve fires the cron as signed webhooks for the life of the watch.',
    inputSchema: {
      cron: z.string().describe('5- or 6-field cron expression, e.g. "0 9 * * 1-5"'),
      tz: z.string().default('UTC'),
      count: z.number().int().min(1).max(20).default(5),
    },
  },
  async ({ cron, tz, count }) => {
    try {
      const fetchPay = await payFetch();
      const res = await fetchPay(`${API}/utils/cron-next`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cron, tz, count }),
      });
      const data = await json(res);
      return res.ok ? ok(data) : fail(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  'x402_ping',
  {
    title: 'Test the payment stack end-to-end (paid via x402, $0.001)',
    description:
      'The cheapest possible real x402 purchase: proves this wallet + client can pay a production ' +
      'seller before you point it at anything expensive. Returns payer + network; failed calls are ' +
      'never billed.',
    inputSchema: {},
  },
  async () => {
    try {
      const fetchPay = await payFetch();
      const res = await fetchPay(`${API}/utils/x402-ping`);
      const data = await json(res);
      return res.ok ? ok(data) : fail(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  'verify_receipt',
  {
    title: 'Verify a signed observation receipt (free)',
    description:
      'Every DataSieve event carries receipt {alg, keyId, statement, sig} — an Ed25519 attestation ' +
      'that DataSieve observed the event. This checks it against the service key, so an agent can ' +
      'validate evidence handed to it by ANOTHER agent without trusting that agent.',
    inputSchema: { receipt: z.object({}).passthrough().describe('the receipt object from an event') },
  },
  async ({ receipt }) => {
    const res = await fetch(`${API}/receipts/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receipt }),
    });
    const data = await json(res);
    return res.ok ? ok(data) : fail(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  },
);

server.registerTool(
  'ping_heartbeat',
  {
    title: 'Heartbeat check-in (free)',
    description:
      'Keep a dead-man switch alive. Pass the pingUrl from create_watch (or a watchId whose ping ' +
      'URLs are in local state). Call this at least once per intervalSeconds.',
    inputSchema: { pingUrl: z.string().optional(), watchId: z.string().optional() },
  },
  async ({ pingUrl, watchId }) => {
    const urls = pingUrl ? [pingUrl] : (watchId && loadState()[watchId]?.pingUrls) || [];
    if (urls.length === 0) return fail('pass pingUrl, or a watchId with known ping URLs');
    const results = await Promise.all(
      urls.map(async (u) => ({ url: u, ...(await json(await fetch(u, { method: 'POST' }))) })),
    );
    return ok(results.length === 1 ? results[0] : results);
  },
);

server.registerTool(
  'service_health',
  {
    title: 'DataSieve service heartbeat (free, public)',
    description: 'Scanner cursor lag vs chain head — verify the watcher is alive before you buy.',
    inputSchema: {},
  },
  async () => {
    const res = await fetch(`${API}/health`);
    return ok(await json(res));
  },
);

server.registerTool(
  'payment_status',
  {
    title: 'Can I buy? (free) — wallet, balance, prices',
    description:
      'Check whether a buying key is configured and whether it can afford a watch. Reports the ' +
      'wallet address, its USDC balance on the configured network, and what each tier costs. ' +
      'Call this before create_watch; it never spends anything.',
    inputSchema: {},
  },
  async () => {
    const key = buyingKey();
    const prices = {
      standard: '$0.10 / 7 days (1 condition, 50 triggers)',
      composite: '$0.25 / 7 days (up to 5 conditions or 5 monitored agents, 200 triggers)',
      standard30: '$0.35 / 30 DAYS on one payment (1 condition, 200 triggers)',
      composite30: '$0.85 / 30 DAYS on one payment (up to 5 conditions, 800 triggers)',
      coordination: '$0.25 / 7 days (1000 ops; barriers + locks free after purchase)',
      utilities: '$0.001 each: cron_next, x402_ping',
      free: ['watch_status', 'drain_events', 'ping_heartbeat', 'pause_watch', 'resume_watch', 'verify_receipt', 'delete_watch', 'service_health'],
    };
    if (!key) return ok({ canBuy: false, reason: 'no buying key configured', help: NO_KEY_HELP, prices });
    try {
      const [{ privateKeyToAccount }, viem, chains] = await Promise.all([
        import('viem/accounts'),
        import('viem'),
        import('viem/chains'),
      ]);
      const account = privateKeyToAccount(key as `0x${string}`);
      const isMainnet = !/staging|sepolia/i.test(API);
      const client = viem.createPublicClient({
        chain: isMainnet ? chains.base : chains.baseSepolia,
        transport: viem.http(),
      });
      const usdc = isMainnet
        ? '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
        : '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
      const raw = await client.readContract({
        address: usdc as `0x${string}`,
        abi: viem.parseAbi(['function balanceOf(address) view returns (uint256)']),
        functionName: 'balanceOf',
        args: [account.address],
      });
      const balance = Number(raw) / 1e6;
      return ok({
        canBuy: balance >= 0.5,
        wallet: account.address,
        network: isMainnet ? 'Base mainnet' : 'Base Sepolia (sandbox)',
        usdcBalance: balance,
        prices,
        ...(balance < 0.5
          ? {
              fundIt: isMainnet
                ? `Send USDC on Base to ${account.address} (a few dollars is plenty; payments are gasless — no ETH needed).`
                : `Get free Base Sepolia USDC at https://faucet.circle.com for ${account.address}.`,
            }
          : {}),
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---- coordination: the multi-agent primitives -----------------------------------

server.registerTool(
  'coord_workspace',
  {
    title: 'Buy a coordination workspace (paid via x402)',
    description:
      'Buy a coordination workspace ($0.25 / 7 days, 1000 ops) — the only x402 seller of ' +
      'multi-agent primitives. After this ONE payment, every barrier and lock operation is ' +
      'FREE and FAST (no per-op settlement). Use it to fan-in sub-agents (coord_barrier) and ' +
      'to stop two agents doing the same irreversible thing (coord_lock).',
    inputSchema: {
      webhookUrl: z.string().url().optional().describe('default webhook for coordination events'),
    },
  },
  async ({ webhookUrl }) => {
    try {
      const fetchPay = await payFetch();
      const res = await fetchPay(`${API}/coord/workspace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(webhookUrl ? { webhookUrl } : {}),
      });
      const data = await json(res);
      if (res.status !== 201) return fail(`HTTP ${res.status}: ${JSON.stringify(data)}`);
      rememberCoord(String(data.id), { secret: String(data.secret) });
      return ok(data);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  'coord_barrier',
  {
    title: 'Create a barrier / fan-in (free — workspace op)',
    description:
      'BARRIER: "wake me when all N of my sub-agents finish." Returns an arriveUrl — hand it to ' +
      'each sub-agent (it is a capability: they can arrive but cannot read or delete your ' +
      'workspace). When the N-th part arrives we fire ONE webhook carrying every part\'s ' +
      'collected context. If the TTL passes first you get a "partial" event naming exactly who ' +
      'never showed. Timeout is a feature, not an error.',
    inputSchema: {
      workspaceId: z.string(),
      parts: z.number().int().min(2).max(100).describe('how many sub-agents must arrive'),
      ttlSeconds: z.number().int().min(10).max(86400).default(3600),
      label: z.string().optional(),
      webhookUrl: z.string().url().optional(),
      secret: z.string().optional(),
    },
  },
  async ({ workspaceId, parts, ttlSeconds, label, webhookUrl, secret }) => {
    const s = secretFor(workspaceId, secret);
    if (!s) return fail(`no secret known for ${workspaceId}`);
    const res = await fetch(`${API}/coord/${workspaceId}/barrier`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s}`, 'content-type': 'application/json' },
      body: JSON.stringify({ parts, ttlSeconds, ...(label ? { label } : {}), ...(webhookUrl ? { webhookUrl } : {}) }),
    });
    const data = await json(res);
    return res.status === 201 ? ok(data) : fail(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  },
);

server.registerTool(
  'coord_arrive',
  {
    title: 'Arrive at a barrier (free, no auth — the URL is the capability)',
    description:
      'Report that this part is done. Pass the arriveUrl from coord_barrier plus a part name and ' +
      'optional ctx (whatever you want handed to whoever consumes the released barrier). ' +
      'Idempotent per part: a retrying agent cannot inflate the count.',
    inputSchema: {
      arriveUrl: z.string().url(),
      part: z.string().describe('unique name for this part, e.g. "scout"'),
      ctx: z.unknown().optional().describe('this part\'s result, collected into the release event'),
    },
  },
  async ({ arriveUrl, part, ctx }) => {
    const res = await fetch(arriveUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ part, ...(ctx !== undefined ? { ctx } : {}) }),
    });
    const data = await json(res);
    return res.ok ? ok(data) : fail(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  },
);

server.registerTool(
  'coord_lock',
  {
    title: 'Acquire a lock / lease (free — workspace op)',
    description:
      'LOCK: "only one agent does this irreversible thing." Returns a leaseId, or 409 with who ' +
      'holds it. The lease AUTO-EXPIRES after ttlSeconds, so a crashed agent can never deadlock ' +
      'your fleet. Call coord_release when done (or just let it expire).',
    inputSchema: {
      workspaceId: z.string(),
      key: z.string().describe('what you are locking, e.g. "deploy" or "wallet:0xabc"'),
      ttlSeconds: z.number().int().min(10).max(86400).default(300),
      holder: z.string().optional().describe('who you are — echoed in 409s so debugging works'),
      secret: z.string().optional(),
    },
  },
  async ({ workspaceId, key, ttlSeconds, holder, secret }) => {
    const s = secretFor(workspaceId, secret);
    if (!s) return fail(`no secret known for ${workspaceId}`);
    const res = await fetch(`${API}/coord/${workspaceId}/lock/${encodeURIComponent(key)}/acquire`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttlSeconds, ...(holder ? { holder } : {}) }),
    });
    const data = await json(res);
    // A 409 is a legitimate answer ("someone else holds it"), not an error.
    return ok({ acquired: res.status === 200, status: res.status, ...data });
  },
);

server.registerTool(
  'coord_release',
  {
    title: 'Release a lock (free — workspace op)',
    inputSchema: {
      workspaceId: z.string(),
      key: z.string(),
      leaseId: z.string(),
      secret: z.string().optional(),
    },
  },
  async ({ workspaceId, key, leaseId, secret }) => {
    const s = secretFor(workspaceId, secret);
    if (!s) return fail(`no secret known for ${workspaceId}`);
    const res = await fetch(`${API}/coord/${workspaceId}/lock/${encodeURIComponent(key)}/release`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s}`, 'content-type': 'application/json' },
      body: JSON.stringify({ leaseId }),
    });
    const data = await json(res);
    return res.ok ? ok(data) : fail(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  },
);

server.registerTool(
  'coord_events',
  {
    title: 'Drain coordination events (free) — the mailbox for agents with no server',
    description:
      'Collect barrier releases/partials that happened while nothing of yours was running.',
    inputSchema: {
      workspaceId: z.string(),
      since: z.string().optional(),
      secret: z.string().optional(),
    },
  },
  async ({ workspaceId, since, secret }) => {
    const s = secretFor(workspaceId, secret);
    if (!s) return fail(`no secret known for ${workspaceId}`);
    const q = since ? `?since=${encodeURIComponent(since)}` : '';
    const res = await fetch(`${API}/coord/${workspaceId}/events${q}`, {
      headers: { authorization: `Bearer ${s}` },
    });
    const data = await json(res);
    return res.ok ? ok(data) : fail(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
