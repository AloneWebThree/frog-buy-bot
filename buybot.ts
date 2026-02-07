// buybot.ts  (Option 1: log-style power bar + tier badge)
// - Log bar doesn't instantly max: each block doubles (100, 200, 400, ...)
// - Tight, hype-friendly message formatting + clickable links

import "dotenv/config";
import {
  createPublicClient,
  http,
  parseAbiItem,
  getAddress,
  formatUnits,
  type Address,
} from "viem";

// ---- env ----
const RPC_URL = process.env.RPC_URL!;
const PAIR_ADDRESS = getAddress(process.env.PAIR_ADDRESS!);
const FROG_ADDRESS = getAddress(process.env.FROG_ADDRESS!);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

// ---- settings ----
const POLL_MS = 6000;
const CONFIRMATIONS = 2;

// Explorer base (Sei EVM)
const EXPLORER = "https://seiscan.io";

// Log bar settings (10 blocks, doubling thresholds)
const LOG_BAR_BLOCKS = 10;
const LOG_BAR_BASE = 100; // first block at 100 FROG, then doubles
const BAR_FILLED = "🟩";
const BAR_EMPTY = "⬜";

// ---- ABIs ----
const pairAbi = [
  {
    type: "function",
    name: "token0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "token1",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

const erc20Abi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

// UniswapV2-style Swap event
const swapEvent = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"
);

const client = createPublicClient({ transport: http(RPC_URL) });

// ---- helpers ----
function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function sendTelegram(html: string) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!r.ok) {
    const body = await r.text();
    console.error("Telegram sendMessage failed:", r.status, body);
  }
}

function prettyAmount(amountStr: string, maxFrac = 4) {
  const n = Number(amountStr);
  if (!Number.isFinite(n)) return amountStr;
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}

function compact(n: number) {
  if (!Number.isFinite(n)) return "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return `${Math.floor(n)}`;
}

/**
 * Log-style bar: thresholds double each block.
 * Block i is "earned" if amount >= base * 2^i.
 * Example with base=100:
 * 100, 200, 400, 800, 1.6k, 3.2k, 6.4k, 12.8k, 25.6k, 51.2k
 */
function buildLogBar(amountFrog: number) {
  if (!Number.isFinite(amountFrog) || amountFrog <= 0) {
    return BAR_EMPTY.repeat(LOG_BAR_BLOCKS);
  }

  let filled = 0;
  for (let i = 0; i < LOG_BAR_BLOCKS; i++) {
    const threshold = LOG_BAR_BASE * Math.pow(2, i);
    if (amountFrog >= threshold) filled++;
    else break;
  }

  return `${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(LOG_BAR_BLOCKS - filled)}`;
}

function maxLogThreshold() {
  // last block threshold (base * 2^(blocks-1))
  return LOG_BAR_BASE * Math.pow(2, LOG_BAR_BLOCKS - 1);
}

// Tier badge aligned with the log thresholds (feel free to rename)
function tierBadge(amountFrog: number) {
  if (!Number.isFinite(amountFrog) || amountFrog <= 0) return "💧 Splash";
  if (amountFrog >= 50_000) return "👑 Frog King";
  if (amountFrog >= 10_000) return "🐊 Swamp Boss";
  if (amountFrog >= 1_000) return "🐸 Big Frog";
  if (amountFrog >= 100) return "🐣 Tadpole";
  return "💧 Splash";
}

// ---- main ----
async function main() {
  const token0 = (await client.readContract({
    address: PAIR_ADDRESS,
    abi: pairAbi,
    functionName: "token0",
  })) as Address;

  const token1 = (await client.readContract({
    address: PAIR_ADDRESS,
    abi: pairAbi,
    functionName: "token1",
  })) as Address;

  const frogIs0 = token0.toLowerCase() === FROG_ADDRESS.toLowerCase();
  const frogIs1 = token1.toLowerCase() === FROG_ADDRESS.toLowerCase();

  if (!frogIs0 && !frogIs1) {
    throw new Error(
      `FROG_ADDRESS is not token0/token1 for this pair. token0=${token0} token1=${token1}`
    );
  }

  const frogDecimals = Number(
    (await client.readContract({
      address: FROG_ADDRESS,
      abi: erc20Abi,
      functionName: "decimals",
    })) as number
  );

  const frogSymbol = (await client
    .readContract({
      address: FROG_ADDRESS,
      abi: erc20Abi,
      functionName: "symbol",
    })
    .catch(() => "FROG")) as string;

  let lastProcessed = await client.getBlockNumber();

  console.log("RPC:", RPC_URL);
  console.log("Pair:", PAIR_ADDRESS);
  console.log("token0:", token0, "token1:", token1);
  console.log("FROG:", FROG_ADDRESS, `(${frogSymbol}, decimals=${frogDecimals})`);
  console.log("Starting from block:", lastProcessed);

  await sendTelegram(
    `✅ <b>Bot online</b>\n` +
      `Pair: <a href="${EXPLORER}/address/${PAIR_ADDRESS}">${escapeHtml(
        shortAddr(PAIR_ADDRESS)
      )}</a>\n` +
      `Token: <b>${escapeHtml(frogSymbol)}</b>\n` +
      `Scale: ${escapeHtml(compact(LOG_BAR_BASE))} → ${escapeHtml(
        compact(maxLogThreshold())
      )} (log bar)`
  );

  while (true) {
    try {
      const head = await client.getBlockNumber();
      const toBlock =
        head > BigInt(CONFIRMATIONS) ? head - BigInt(CONFIRMATIONS) : head;
      const fromBlock = lastProcessed + 1n;

      if (fromBlock <= toBlock) {
        const logs = await client.getLogs({
          address: PAIR_ADDRESS,
          event: swapEvent,
          fromBlock,
          toBlock,
        });

        for (const log of logs) {
          const { amount0Out, amount1Out } = log.args;

          // BUY = FROG goes OUT of the pool
          const frogOut = frogIs0 ? amount0Out : amount1Out;

          if (frogOut && frogOut > 0n) {
            const frogHuman = formatUnits(frogOut, frogDecimals);
            const frogPretty = prettyAmount(frogHuman, 4);

            const frogNum = Number(frogHuman);
            const amountFrog = Number.isFinite(frogNum) ? frogNum : 0;

            const badge = tierBadge(amountFrog);
            const bar = buildLogBar(amountFrog);

            const tx = log.transactionHash;
            const txShort = `${tx.slice(0, 10)}…${tx.slice(-8)}`;
            const pairShort = `${PAIR_ADDRESS.slice(0, 10)}…${PAIR_ADDRESS.slice(
              -4
            )}`;

            // Tighter message: badge + bar on one line
            const msg =
              `New <b>${escapeHtml(frogSymbol)} BUY</b>\n` +
              `Amount: <b>${escapeHtml(frogPretty)}</b> ${escapeHtml(
                frogSymbol
              )}\n` +
              `<b>${escapeHtml(badge)}</b>  ${escapeHtml(bar)} <i>(${escapeHtml(
                compact(amountFrog)
              )})</i>\n` +
              `Tx: <a href="${EXPLORER}/tx/${tx}">${escapeHtml(
                txShort
              )}</a>\n` +
              `Pair: <a href="${EXPLORER}/address/${PAIR_ADDRESS}">${escapeHtml(
                pairShort
              )}</a>`;

            await sendTelegram(msg);
          }
        }

        lastProcessed = toBlock;
      }
    } catch (e) {
      console.error("Loop error:", e);
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});