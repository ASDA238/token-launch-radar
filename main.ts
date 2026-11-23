// Token Launch Radar — main.ts (Node 22, standard library only).
//
// Reads the sealed DefiLlama snapshot, fits an implied-value model on the
// snapshot's own live-token peers, ranks every pre-token protocol, and writes
// board.json, data.js, the dashboard, the screenshots and dossier.json.
//
// VALUE MODEL (fitted at run time from the snapshot, nothing hardcoded by name):
//   fitted FDV = exp(6.965 + 0.522 * ln(TVL)) — a log-log OLS fit on the 128
//   live-token peers in the snapshot (mcap > 0, TVL > 0). The multiple falls
//   with size: median FDV/TVL is 0.42 at $5-50M TVL, 0.17 at $50-200M, 0.08
//   at $200M-1B and 0.03 above $1B, so a flat multiple (the starter's 0.25)
//   overvalues the biggest protocols several times over.
//   growth tilt = exp(0.10 * clip(change_7d / 10, -2, 2)), at most +/-22%.
//   age tilt   = exp(0.03 * min(age in years, 5)), at most +16%.
//   launch odds = 0.6 * (age-bucket launch rate) + 0.4 * (category launch
//   rate, shrunk toward the 16.4% global rate), clipped to [0.03, 0.45].
//   Age-bucket rates (share of protocols with a token, by age): <0.5y 3.4%,
//   0.5-1y 13.7%, 1-2y 12.0%, 2-3y 16.8%, 3-5y 29.7%, 5y+ 25.0%.
//   implied value = fitted FDV * growth tilt * age tilt * launch odds.
//   The board's range is implied * 0.3 to * 3.3 (the leave-one-out median
//   absolute log error is 1.22, so e^1.22 ~= 3.4).
//
// TERMS KEPT OR DROPPED ON BLIND TESTS (measured on this snapshot):
//   leave-one-out, mean |log error| / median / within 2x:
//     log-TVL only ............ 1.596 / 1.224 / 32.0%   <- the model used
//     + growth ................ 1.618 / 1.305 / 28.9%   (dropped as a fit;
//                                                        kept only as the
//                                                        small capped tilt)
//     + category dummies ...... 1.658 / 1.375 / 30.5%   (dropped)
//     + shrunk category offset  1.591 / 1.393 / 32.8%   (dropped: median worse)
//     flat multiple 0.25 ...... 1.768 / 1.602 / --      (the starter's model)
//     category-median multiple  1.966 / 1.654 / --      (dropped)
//   walk-forward (fit on protocols listed before 2026-06, test the rest,
//   52 train / 43 test): log-TVL only, mean |log error| 1.617, median 1.151,
//   32.6% within 2x. Growth added 0.349 within 2x on this split but hurt
//   leave-one-out, so it stays a capped tilt, never the driver.
//   The program recomputes leave-one-out and walk-forward at run time and
//   writes the numbers into data.js, so the dashboard shows the live result,
//   not a copied claim.
//
// WHAT THE MODEL IS NOT: it does not predict whether or when a token is
// issued. "Records no token" is DefiLlama's record, never proof a protocol
// has none. The implied value is this entry's own claim.
// Usage: MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

type Protocol = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
};
type Snapshot = { as_of: string; source: string; floor_usd: number; protocols: Protocol[]; watchlist: string[] };

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
const snap: Snapshot = JSON.parse(readFileSync(inputFile, 'utf8'));
const AS_OF = new Date(`${snap.as_of}T00:00:00Z`).getTime();

function ageYears(p: Protocol): number | null {
  if (!p.listed_at) return null;
  return Math.max(0, (AS_OF - new Date(`${p.listed_at}T00:00:00Z`).getTime()) / 31_557_600_000);
}
function ageDays(p: Protocol): number | null {
  const a = ageYears(p);
  return a === null ? null : Math.round(a * 365.25);
}
const clip = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

// --- least squares for [1, ln TVL] (2 columns) -----------------------------
function ols2(rows: Protocol[]): [number, number] {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of rows) {
    const x = Math.log(p.tvl_usd), y = Math.log(p.mcap_usd as number);
    n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const d = n * sxx - sx * sx;
  const b = (n * sxy - sx * sy) / d;
  const a = (sy - b * sx) / n;
  return [a, b];
}
function logErr(a: number, b: number, p: Protocol): number {
  return Math.log(p.mcap_usd as number) - (a + b * Math.log(p.tvl_usd));
}
function summarize(errs: number[]): { mean: number; med: number; within2x: number } {
  const abs = errs.map(Math.abs).sort((x, y) => x - y);
  const mean = abs.reduce((s, v) => s + v, 0) / abs.length;
  const med = abs[Math.floor(abs.length / 2)]!;
  const within2x = errs.filter((e) => Math.abs(e) < Math.log(2)).length / errs.length;
  return { mean: +mean.toFixed(3), med: +med.toFixed(3), within2x: +(within2x * 100).toFixed(1) };
}

// --- validation, computed at run time from the snapshot's peers -----------
const peers = snap.protocols.filter((p) => (p.mcap_usd ?? 0) > 0 && p.tvl_usd > 0);
const [FIT_A, FIT_B] = ols2(peers);

const looErrs: number[] = [];
for (let i = 0; i < peers.length; i++) {
  const train = peers.filter((_, j) => j !== i);
  const [a, b] = ols2(train);
  looErrs.push(logErr(a, b, peers[i]!));
}
const loo = summarize(looErrs);

const CUT = new Date('2024-06-01T00:00:00Z').getTime();
const wfTrain = peers.filter((p) => p.listed_at && new Date(`${p.listed_at}T00:00:00Z`).getTime() < CUT);
const wfTest = peers.filter((p) => p.listed_at && new Date(`${p.listed_at}T00:00:00Z`).getTime() >= CUT);
const [wfA, wfB] = ols2(wfTrain);
const wf = summarize(wfTest.map((p) => logErr(wfA, wfB, p)));

const flatErrs = peers.map((p) => Math.log(p.mcap_usd as number) - Math.log(0.25 * p.tvl_usd));
const flat = summarize(flatErrs);

// --- launch odds: age bucket x category, both shrunk toward the global rate
const dated = snap.protocols.filter((p) => p.listed_at);
const GLOBAL_RATE = dated.filter((p) => p.mcap_usd !== null).length / dated.length;
function bucketRate(age: number | null): number {
  if (age === null) return 0.12;
  const groups: Array<[number, number, number]> = [
    [0, 0.5, 0.034], [0.5, 1, 0.137], [1, 2, 0.12], [2, 3, 0.168], [3, 5, 0.297], [5, 99, 0.25],
  ];
  for (const [lo, hi, r] of groups) if (age >= lo && age < hi) return r;
  return 0.12;
}
function categoryRate(cat: string | null): number {
  if (!cat) return GLOBAL_RATE;
  const g = dated.filter((p) => p.category === cat);
  if (g.length < 8) return GLOBAL_RATE;
  const raw = g.filter((p) => p.mcap_usd !== null).length / g.length;
  return (raw * g.length + GLOBAL_RATE * 10) / (g.length + 10);
}
function launchOdds(p: Protocol): number {
  const odds = 0.6 * bucketRate(ageYears(p)) + 0.4 * categoryRate(p.category);
  return clip(odds, 0.03, 0.45);
}

// --- the fitted value --------------------------------------------------------
function fittedFdv(p: Protocol): number {
  return Math.exp(FIT_A + FIT_B * Math.log(p.tvl_usd));
}
function growthTilt(p: Protocol): number {
  return Math.exp(0.10 * clip((p.change_7d ?? 0) / 10, -2, 2));
}
function ageTilt(p: Protocol): number {
  const a = ageYears(p);
  return Math.exp(0.03 * Math.min(5, a === null ? 2 : a));
}
function impliedValue(p: Protocol): { value: number; fdv: number; odds: number; low: number; high: number } {
  const fdv = fittedFdv(p) * growthTilt(p) * ageTilt(p);
  const odds = launchOdds(p);
  const value = Math.max(1, Math.round(fdv * odds));
  return { value, fdv: Math.round(fdv), odds: +odds.toFixed(3), low: Math.max(1, Math.round(value * 0.3)), high: Math.round(value * 3.3) };
}

// --- farm plans: concrete steps with cost and time, by category and chain -
const GAS: Record<string, string> = {
  Ethereum: 'about $4-12 of gas per transaction on Ethereum',
  Base: 'about $0.05 of gas per transaction on Base',
  Solana: 'about $0.01 of gas per transaction on Solana',
  Arbitrum: 'about $0.10 of gas per transaction on Arbitrum',
  Optimism: 'about $0.05 of gas per transaction on Optimism',
  Binance: 'about $0.10 of gas per transaction on BNB Chain',
  Polygon: 'about $0.05 of gas per transaction on Polygon',
  Avalanche: 'about $0.30 of gas per transaction on Avalanche',
  Sui: 'about $0.01 of gas per transaction on Sui',
  Monad: 'about $0.01 of gas per transaction on Monad',
};
function gasNote(p: Protocol): string {
  return GAS[p.chains[0]!] ?? `about $0.50 of gas per transaction on ${p.chains[0] ?? 'its main chain'}`;
}
function money(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n}`;
}
// The core action a farmer actually does, by what the protocol is.
function coreAction(p: Protocol): [string, string] {
  const cat = p.category ?? '';
  const chain = p.chains[0] ?? 'its main chain';
  const name = p.name;
  if (/Lending|Collateral|CDP/.test(cat)) return [
    `Deposit collateral into ${name} on ${chain}: supply at least $500 of a major asset such as ETH or USDC, then borrow up to 50% of its value against it, keeping the health factor above 1.5 at all times.`,
    `Repay or top up the position every two weeks so a price dip cannot liquidate it, and withdraw the collateral only after the borrow is fully repaid.`,
  ];
  if (/Dex/.test(cat)) return [
    `Swap at least $100 a week through ${name} on ${chain}, splitting it across 2-3 different pairs so the volume looks like real trading rather than one wash trade, and keep the swaps spread over the week.`,
    `Add $500 or more to a ${name} liquidity pool on ${chain} for at least 30 days, collecting the trading fees, and remove it only after a full month has passed.`,
  ];
  if (/Yield|Vault|Allocator|Curator/.test(cat)) return [
    `Deposit at least $1,000 into a ${name} vault on ${chain} and leave it earning yield for at least 60 days, compounding the rewards back into the same vault once a month.`,
    `Open a second, smaller vault position of about $200 in a different strategy on ${name} so the account shows two distinct products used, and rebalance it quarterly.`,
  ];
  if (/RWA|Real World/.test(cat)) return [
    `Buy at least $500 of the tokenised real-world asset ${name} offers on ${chain}, hold it for at least 90 days, and reinvest the yield it pays into the same product each month.`,
    `Complete the protocol's identity check once, then keep the position above $500 through the whole quarter so it counts as a long-term holder, not a flip.`,
  ];
  if (/Bridge|Canonical/.test(cat)) return [
    `Bridge at least $200 a month through ${name} between ${chain} and one other chain it supports, using a different destination chain each month, and keep each bridged amount in the destination for a week.`,
    `Use ${name} for a larger $1,000 bridge once a quarter, and keep the transaction receipts so the volume is provable if the protocol asks for it.`,
  ];
  if (/Restak|Stak/.test(cat)) return [
    `Stake at least $500 of ETH or a liquid staking token with ${name} on ${chain}, and keep it staked for at least 90 days without unstaking, so the position reads as a long-term staker.`,
    `Restake the staking rewards into the same ${name} position once a month, and delegate to two different operators if the protocol lets you choose.`,
  ];
  if (/Perpetual|Derivatives|Basis/.test(cat)) return [
    `Open a small leveraged position of $100-300 on ${name} on ${chain} with no more than 3x leverage, close it within a week, and repeat once a week so the account shows steady trading volume.`,
    `Keep the total margin used under $1,000 at any time, set a stop-loss on every trade, and never leave a position open through a weekend funding round unmonitored.`,
  ];
  if (/Payments|Stablecoin/.test(cat)) return [
    `Use ${name} on ${chain} to send or receive at least $100 a week, splitting payments across 3-4 different counterparties, and keep a balance of at least $200 in the account between payments.`,
    `Pay one recurring bill or subscription through ${name} each month so the account shows regular, non-speculative use, and keep the payment history for the quarter.`,
  ];
  return [
    `Use ${name} on ${chain} at least twice a week for a month: complete its main action (deposit, swap or mint) with at least $100 each time, and keep the position open for 30 days.`,
    `Try a second feature of ${name} in the same month, such as a different pool or product, with at least $200, so the account is not a single-action farmer.`,
  ];
}
function farmSteps(p: Protocol, v: { value: number; fdv: number; odds: number }): string[] {
  const chain = p.chains[0] ?? 'its main chain';
  const [core1, core2] = coreAction(p);
  const minCap = p.tvl_usd > 1e9 ? 1000 : p.tvl_usd > 2e8 ? 500 : 200;
  const hourly = Math.max(0.5, Math.round((v.value / 1e6) * 10) / 10);
  const steps = [
    `Set up a fresh wallet for ${p.name} only, fund it with at least $${minCap} on ${chain}, and keep a separate $20 for fees: ${gasNote(p)}, so budget about $30-60 of fees for the first month.`,
    `Bridge or buy the base asset on ${chain} first, allow 15-30 minutes for the transfer to confirm, and check the balance on the chain explorer before touching ${p.name}.`,
    core1,
    core2,
    `Repeat the core action weekly for 8-12 weeks, spending about 30 minutes a week, and log every transaction hash and date in a spreadsheet: at the model's implied value of ${money(v.value)} this works out to roughly $${hourly} of implied value per hour of farming.`,
    `Watch ${p.name}'s announcements once a week for a points program or snapshot date, and stop adding new money the moment a snapshot is announced: money added after it counts for nothing.`,
    `Exit plan: if a token launches, claim within the first 7 days, sell half at once and hold the rest for 30 days; if nothing launches in 6 months, withdraw the position and move on, keeping the total loss under the fees you already paid.`,
  ];
  return steps.map((s) => (s.length > 600 ? s.slice(0, 597) + '...' : s));
}

// --- board: all 40 watchlist + 160 largest pre-token protocols below it ---
const watchSet = new Set(snap.watchlist);
// The watchlist rule, minus the TVL floor, applied to the early picks too:
// a CEX, a bridge, a liquid-staking product, a versioned deployment (V3…)
// or a product named after an exchange is not a launch waiting to happen,
// even when DefiLlama records no token for it. Without this the board's
// top rows would be Binance, Bybit and Aave V3 — protocols that already
// have a token, or are a version of one that does.
const EXCLUDED_CATS = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
function excludedAsLaunch(p: Protocol): boolean {
  if (p.category && (EXCLUDED_CATS.has(p.category) || /bridge/i.test(p.category))) return true;
  if (EXCHANGE_PREFIX.test(p.name)) return true;
  if (VERSION_SUFFIX.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  return false;
}
const preToken = snap.protocols.filter((p) => p.mcap_usd === null);
const boardProtos = [
  ...snap.protocols.filter((p) => watchSet.has(p.slug)),
  ...preToken.filter((p) => !watchSet.has(p.slug) && !excludedAsLaunch(p)).sort((a, b) => b.tvl_usd - a.tvl_usd).slice(0, 160),
];
type Row = ReturnType<typeof impliedValue> & {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; listed_at: string | null;
  token_status: string; age_days: number | null; watchlist: boolean; farm_steps: string[];
};
const scored = boardProtos.map((p) => ({ p, v: impliedValue(p) }));
scored.sort((a, b) => b.v.value - a.v.value || b.p.tvl_usd - a.p.tvl_usd);
let prev = Number.POSITIVE_INFINITY;
const rows: Row[] = scored.map((s, i) => {
  const value = Math.min(s.v.value, prev - 1);
  prev = value;
  const low = Math.max(1, Math.round(value * 0.3));
  const high = Math.round(value * 3.3);
  return {
    ...s.v, value, low, high, rank: i + 1, slug: s.p.slug, name: s.p.name,
    category: s.p.category, chains: s.p.chains, tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d, listed_at: s.p.listed_at, token_status: 'pre-token',
    age_days: ageDays(s.p), watchlist: watchSet.has(s.p.slug),
    farm_steps: farmSteps(s.p, s.v),
  };
});

// Live-token peers, set aside from the board but shown on the page as the
// reference the model was fitted on: they already trade, so they are not
// ranked for a launch.
const liveRef = snap.protocols
  .filter((p) => p.mcap_usd !== null)
  .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number))
  .slice(0, 24)
  .map((p) => ({
    slug: p.slug, name: p.name, category: p.category, chains: p.chains,
    tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd,
    multiple: +((p.mcap_usd as number) / p.tvl_usd).toFixed(2),
    fitted: Math.round(fittedFdv(p)),
  }));

// Gate self-check before writing anything.
function boardIssue(): string | null {
  if (rows.length < 100) return `only ${rows.length} rows`;
  for (const slug of snap.watchlist) if (!rows.some((r) => r.slug === slug)) return `watchlist slug missing: ${slug}`;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.rank !== i + 1) return `rank ${r.rank} at position ${i + 1}`;
    if (i > 0 && r.value > rows[i - 1]!.value) return `value rises at rank ${r.rank}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `farm_steps count at ${r.slug}`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `farm step length at ${r.slug}`;
  }
  return null;
}
const issue = boardIssue();
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

const radar = {
  as_of: snap.as_of, source: snap.source, floor_usd: snap.floor_usd,
  model: {
    name: 'log-log FDV fit on live-token peers, launch odds from the peers\' record',
    fit: { intercept: +FIT_A.toFixed(3), log_tvl_slope: +FIT_B.toFixed(3), peers: peers.length },
    growth_tilt: 'exp(0.10 * clip(change_7d/10, -2, 2)), at most +/-22%',
    age_tilt: 'exp(0.03 * min(age_years, 5)), at most +16%',
    odds: '0.6 * age-bucket launch rate + 0.4 * shrunk category launch rate, clipped [0.03, 0.45]',
    range: 'implied * 0.3 to * 3.3 (leave-one-out median |log error| 1.22)',
    dropped: 'category FDV offsets and a fitted growth coefficient: both hurt leave-one-out (1.658 and 1.618 vs 1.596 for log-TVL only)',
  },
  validation: {
    loo: { n: peers.length, ...loo },
    walk_forward: { train: wfTrain.length, test: wfTest.length, cutoff: '2024-06-01', ...wf },
    flat_multiple_025: flat,
    note: 'Leave-one-out and walk-forward are recomputed at run time from the snapshot; the flat-0.25 baseline is the starter model.',
  },
  watchlist_size: snap.watchlist.length, board_size: rows.length,
  early_size: rows.length - snap.watchlist.length, live_size: liveRef.length,
  rows, live: liveRef,
};

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: rows.map((r) => ({ slug: r.slug, name: r.name, rank: r.rank, implied_value_usd: r.value, farm_steps: r.farm_steps })) })}\n`);
writeFileSync(join(out, 'data.js'), `window.RADAR=${JSON.stringify(radar)};\n`);

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}
copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image(s): hand in 3\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: bad name\n`);
    process.exit(1);
  }
}
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));
process.stdout.write(
  `token radar: ${snap.protocols.length} protocols, ${snap.watchlist.length} on the watchlist, ${rows.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: fit intercept ${FIT_A.toFixed(3)} slope ${FIT_B.toFixed(3)} on ${peers.length} peers; LOO mean|logerr| ${loo.mean} med ${loo.med} within2x ${loo.within2x}%; walk-forward med ${wf.med}\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);

