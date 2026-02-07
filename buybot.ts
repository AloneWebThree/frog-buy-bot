// buybot.ts
// Adds:
// - Spent (token in) using Swap event amounts
// - Buyer address via transaction "from" (tx parsing)
// - Emoji meter: 🐸 per 100 FROG bought (max 100)
// - Displays WSEI as "SEI" in messages (alias only; math unchanged)
// - If buyer can't be resolved, show Recipient (Swap `to`) instead of claiming Buyer

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

// Emoji meter settings
const FROG_PER_EMOJI = 1000; // 1 🐸 per 1000 FROG
const EMOJI_MAX = 100; // max 🐸 to avoid spam

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

function displaySymbol(sym: string) {
  const s = sym.trim();
  if (s.toUpperCase() === "WSEI") return "SEI";
  return s;
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

function tierBadge(amountFrog: number) {
  if (!Number.isFinite(amountFrog) || amountFrog <= 0) return "💧 Splash";
  if (amountFrog >= 50_000) return "👑 Frog King";
  if (amountFrog >= 10_000) return "🐊 Swamp Boss";
  if (amountFrog >= 2_000) return "🦎 Small Guy";
  if (amountFrog >= 100) return "🐣 Tadpole";
  return "💧 Splash";
}

function frogMeter(amountFrog: number) {
  if (!Number.isFinite(amountFrog) || amountFrog <= 0) return "";
  const count = Math.min(EMOJI_MAX, Math.floor(amountFrog / FROG_PER_EMOJI));
  if (count <= 0) return "";
  return "🐸".repeat(count);
}

async function readTokenMeta(address: Address) {
  const [decimals, symbol] = await Promise.all([
    client
      .readContract({ address, abi: erc20Abi, functionName: "decimals" })
      .then((x) => Number(x as number))
      .catch(() => 18),
    client
      .readContract({ address, abi: erc20Abi, functionName: "symbol" })
      .then((x) => String(x))
      .catch(() => "TOKEN"),
  ]);
  return { decimals, symbol };
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

  const frogMeta = await readTokenMeta(FROG_ADDRESS);
  const otherToken = frogIs0 ? token1 : token0;
  const otherMeta = await readTokenMeta(otherToken);
  const otherDisplay = displaySymbol(otherMeta.symbol);

  let lastProcessed = await client.getBlockNumber();

  console.log("RPC:", RPC_URL);
  console.log("Pair:", PAIR_ADDRESS);
  console.log("token0:", token0, "token1:", token1);
  console.log(
    "FROG:",
    FROG_ADDRESS,
    `(${frogMeta.symbol}, decimals=${frogMeta.decimals})`
  );
  console.log(
    "Other:",
    otherToken,
    `(${otherMeta.symbol}, decimals=${otherMeta.decimals})`
  );
  console.log("Starting from block:", lastProcessed);

  await sendTelegram(
    `✅ <b>Bot online</b>\n` +
      `Pair: <a href="${EXPLORER}/address/${PAIR_ADDRESS}">${escapeHtml(
        shortAddr(PAIR_ADDRESS)
      )}</a>\n` +
      `Token: <b>${escapeHtml(frogMeta.symbol)}</b>\n` +
      `Tracking spent: <b>${escapeHtml(otherDisplay)}</b>\n` +
      `Meter: 🐸 per ${FROG_PER_EMOJI} (max ${EMOJI_MAX})`
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
          const { amount0In, amount1In, amount0Out, amount1Out, to } = log.args;

          // BUY = FROG goes OUT of the pool
          const frogOut = frogIs0 ? amount0Out : amount1Out;
          if (!frogOut || frogOut <= 0n) continue;

          // Spent = other token "in" to the pool
          const spentRaw = frogIs0 ? amount1In : amount0In;

          const frogHuman = formatUnits(frogOut, frogMeta.decimals);
          const frogPretty = prettyAmount(frogHuman, 4);

          const spentHuman = spentRaw
            ? formatUnits(spentRaw, otherMeta.decimals)
            : "0";
          const spentPretty = prettyAmount(spentHuman, 4);

          const frogNum = Number(frogHuman);
          const amountFrog = Number.isFinite(frogNum) ? frogNum : 0;

          const badge = tierBadge(amountFrog);
          const meter = frogMeter(amountFrog);

          const tx = log.transactionHash;
          const txShort = `${tx.slice(0, 10)}…${tx.slice(-8)}`;

          // Buyer address: use transaction "from" (initiator)
          let buyer: Address | null = null;
          try {
            const t = await client.getTransaction({ hash: tx });
            buyer = t.from as Address;
          } catch {
            buyer = null;
          }

          const buyerLink = buyer
            ? `<a href="${EXPLORER}/address/${buyer}">${escapeHtml(
                shortAddr(buyer)
              )}</a>`
            : null;

          const recipientLink = `<a href="${EXPLORER}/address/${to as Address}">${escapeHtml(
            shortAddr(String(to))
          )}</a>`;

          const msg =
            `Brand NEW <b>${escapeHtml(frogMeta.symbol)} BUY</b>\n` +
            `Bought: <b>${escapeHtml(frogPretty)}</b> ${escapeHtml(
              frogMeta.symbol
            )}\n` +
            (meter ? `${meter}\n` : "") +
            `<b>${escapeHtml(badge)}</b>\n` +
            `Spent: <b>${escapeHtml(spentPretty)}</b> ${escapeHtml(
              otherDisplay
            )}\n` +
            `${buyerLink ? `Buyer: ${buyerLink}\n` : `Recipient: ${recipientLink}\n`}` +
            `Tx: <a href="${EXPLORER}/tx/${tx}">${escapeHtml(txShort)}</a>`;

          await sendTelegram(msg);
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