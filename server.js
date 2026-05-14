import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(process.cwd(), 'data', 'positions.json');

function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ positions: [], cashflows: [] }, null, 2));
}

function readData() { ensureDataFile(); return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
function writeData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
const PANCAKE_V3_SUBGRAPH = 'https://api.thegraph.com/subgraphs/name/pancakeswap/exchange-v3-bsc';

function calcMetrics(position) {
  const start = Number(position.startAmount || 0), end = Number(position.endAmount || 0), days = Number(position.durationDays || 0);
  const profit = end - start;
  const apr = start > 0 && days > 0 ? ((profit / start) * (365 / days) * 100) : 0;
  return { ...position, profit: Number(profit.toFixed(2)), realApr: Number(apr.toFixed(8)) };
}

function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function notFound(res) { res.writeHead(404); res.end('Not found'); }

const KNOWN_TOKEN_BY_ADDRESS = {
  '0x55d398326f99059ff775485246999027b3197955': 'USDT',
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC',
  '0xe9e7cea3dedca5984780bafc599bd69add087d56': 'BUSD',
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8': 'ETH',
  '0x7130d2a12b9bcbaef4f2634d864a1ee1ce3ead9c': 'BTCB',
  '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82': 'CAKE',
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'WBNB',
  '0xe3478b0bb1a5084567c319096437924948be1964': 'SIREN'
};

const ALLOWED_PAIR_TOKENS = new Set(['USDT', 'USDC', 'BUSD', 'ETH', 'BTCB', 'CAKE', 'WBNB', 'SIREN']);
const PREFERRED_FUNDING_TOKENS = ['USDT', 'USDC', 'BUSD'];

function inferCoinPair(cashflows = []) {
  const symbols = new Map();
  for (const tx of cashflows) {
    const maybeSymbol = String(tx.assetSymbol || '').toUpperCase();
    const weightedAmount = Math.max(1, Number(tx.valueAmount || 0));
    if (ALLOWED_PAIR_TOKENS.has(maybeSymbol)) {
      symbols.set(maybeSymbol, (symbols.get(maybeSymbol) || 0) + weightedAmount);
    }
    for (const addr of [tx.from, tx.to]) {
      const key = String(addr || '').toLowerCase();
      const mapped = KNOWN_TOKEN_BY_ADDRESS[key];
      if (mapped && ALLOWED_PAIR_TOKENS.has(mapped)) {
        symbols.set(mapped, (symbols.get(mapped) || 0) + 0.2);
      }
    }
  }

  const ranked = [...symbols.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  const quote = PREFERRED_FUNDING_TOKENS.find((s) => ranked.includes(s)) || 'USDT';
  const base = ranked.find((s) => !PREFERRED_FUNDING_TOKENS.includes(s) && s !== quote && s !== 'WBNB')
    || ranked.find((s) => s === 'WBNB')
    || 'BNB';

  return `${base === 'WBNB' ? 'BNB' : base}/${quote}`;
}

function buildDerivedPosition(cashflows = [], address = '', coinPair = 'BNB') {
  if (!Array.isArray(cashflows) || cashflows.length === 0) return null;

  const normalizedAddress = String(address || '').toLowerCase();
  const sorted = [...cashflows].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const now = Date.now();
  const startMs = new Date(first.timestamp).getTime();
  const endMs = new Date(last.timestamp).getTime();
  const durationDaysExact = Math.max(1 / 1440, (endMs - startMs) / (24 * 60 * 60 * 1000));
  const durationDays = Number(durationDaysExact.toFixed(6));

  let investedBnb = 0;
  let withdrawnBnb = 0;
  let totalGasBnb = 0;
  let transferCount = 0;
  let internalTransfers = 0;
  let externalTransfers = 0;

  const tokenIn = new Map();
  const tokenOut = new Map();

  for (const tx of sorted) {
    const value = Number(tx.valueBnb || 0);
    const gas = Number(tx.gasFeeBnb || 0);
    const direction = tx.direction || (tx.to?.toLowerCase() === normalizedAddress ? 'in' : 'out');

    if (direction === 'out') investedBnb += value;
    else withdrawnBnb += value;

    const symbol = String(tx.assetSymbol || '').toUpperCase();
    const amount = Number(tx.valueAmount || 0);
    if (symbol && Number.isFinite(amount) && amount > 0) {
      const bucket = direction === 'out' ? tokenOut : tokenIn;
      bucket.set(symbol, Number(((bucket.get(symbol) || 0) + amount).toFixed(12)));
    }

    totalGasBnb += gas;
    transferCount += Number(tx.transferCount || 1);
    internalTransfers += Number(tx.internalTransferCount || 0);
    externalTransfers += Number(tx.externalTransferCount || 0);
  }

  const openingBalanceBnb = Number(sorted[0].balanceBeforeBnb || 0);
  const accountingSymbol = PREFERRED_FUNDING_TOKENS.find((s) => tokenIn.has(s) || tokenOut.has(s))
    || [...new Set([...tokenIn.keys(), ...tokenOut.keys()])][0]
    || 'BNB';
  const tokenInvested = Number(tokenOut.get(accountingSymbol) || 0);
  const tokenWithdrawn = Number(tokenIn.get(accountingSymbol) || 0);
  const startAmount = accountingSymbol === 'BNB' ? investedBnb + totalGasBnb : tokenInvested;
  const netProfit = accountingSymbol === 'BNB'
    ? withdrawnBnb - investedBnb - totalGasBnb
    : tokenWithdrawn - tokenInvested;
  const endAmount = startAmount + netProfit;
  const profit = netProfit;
  const apr = startAmount > 0 && durationDays > 0 ? ((profit / startAmount) * (365 / durationDays) * 100) : 0;

  return {
    date: first.timestamp,
    endDate: last.timestamp,
    durationDays,
    coin: coinPair,
    accountingSymbol,
    chain: 'BSC',
    startAmount: Number(startAmount.toFixed(8)),
    endAmount: Number(endAmount.toFixed(8)),
    investedBnb: Number(investedBnb.toFixed(8)),
    withdrawnBnb: Number(withdrawnBnb.toFixed(8)),
    openingBalanceBnb: Number(openingBalanceBnb.toFixed(8)),
    gasSpentBnb: Number(totalGasBnb.toFixed(8)),
    transferCount,
    internalTransfers,
    externalTransfers,
    uniqueTransactions: sorted.length,
    profit: Number(profit.toFixed(8)),
    realApr: Number(apr.toFixed(8))
  };
}

async function fetchPancakePoolMeta(symbols = []) {
  if (!Array.isArray(symbols) || symbols.length < 2) return null;
  const [a, b] = symbols.map(x => String(x || '').toUpperCase());
  if (!a || !b) return null;

  const query = `
    query Pools($a: String!, $b: String!) {
      pools(
        first: 5,
        orderBy: totalValueLockedUSD,
        orderDirection: desc,
        where: {
          token0_: {symbol_in: [$a, $b]},
          token1_: {symbol_in: [$a, $b]}
        }
      ) {
        id
        feeTier
        sqrtPrice
        token0 { symbol decimals }
        token1 { symbol decimals }
        totalValueLockedUSD
      }
    }
  `;

  try {
    const response = await fetch(PANCAKE_V3_SUBGRAPH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { a, b } })
    });
    const json = await response.json();
    const pools = json?.data?.pools;
    if (!Array.isArray(pools) || pools.length === 0) return null;
    const pool = pools[0];
    return {
      dex: 'PancakeSwap V3',
      poolId: pool.id,
      feeTier: Number(pool.feeTier || 0),
      tvlUsd: Number(pool.totalValueLockedUSD || 0),
      token0: pool.token0?.symbol || null,
      token1: pool.token1?.symbol || null,
      token0Decimals: Number(pool.token0?.decimals || 18),
      token1Decimals: Number(pool.token1?.decimals || 18),
      sqrtPrice: pool.sqrtPrice || null,
      rangeFrom: null,
      rangeTo: null,
      startPrice: null,
    };
  } catch {
    return null;
  }
}


function toPriceFromSqrt(sqrtPrice, token0Decimals, token1Decimals) {
  const sqrt = Number(sqrtPrice || 0);
  if (!sqrt) return null;
  const ratio = (sqrt / (2 ** 96)) ** 2;
  return ratio * (10 ** (Number(token0Decimals || 18) - Number(token1Decimals || 18)));
}

function enrichPriceFields(position, meta) {
  if (!meta?.token0 || !meta?.token1) return position;
  const p01 = toPriceFromSqrt(meta.sqrtPrice, meta.token0Decimals, meta.token1Decimals);
  if (!p01 || !Number.isFinite(p01)) return position;

  const [base, quote] = String(position.coin || '').split('/');
  let startPrice = null;
  if (meta.token0 === base && meta.token1 === quote) startPrice = p01;
  else if (meta.token1 === base && meta.token0 === quote) startPrice = 1 / p01;

  if (!startPrice || !Number.isFinite(startPrice)) return position;
  const band = 0.1;
  return {
    ...position,
    startPrice: Number(startPrice.toFixed(8)),
    rangeFrom: Number((startPrice * (1 - band)).toFixed(8)),
    rangeTo: Number((startPrice * (1 + band)).toFixed(8))
  };
}

async function buildDerivedPositions(cashflows = [], address = '') {
  if (!Array.isArray(cashflows) || cashflows.length === 0) return [];

  const sorted = [...cashflows].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const segments = [];
  let current = [];
  let netOut = 0;
  for (const tx of sorted) {
    current.push(tx);
    const value = Number(tx.valueBnb || 0);
    if (tx.direction === 'out') netOut += value;
    else netOut -= value;

    const currentDurationMs = new Date(current[current.length - 1].timestamp) - new Date(current[0].timestamp);
    const isSettled = netOut <= 0.000001;
    const longEnough = currentDurationMs >= 5 * 60 * 1000;
    if (isSettled && longEnough) {
      segments.push(current);
      current = [];
      netOut = 0;
    }
  }
  if (current.length) segments.push(current);

  const raw = segments
    .map(segment => buildDerivedPosition(segment, address, inferCoinPair(segment)))
    .filter(Boolean)
    .filter(p => p.investedBnb > 0.000001 || p.withdrawnBnb > 0.000001);

  const enriched = await Promise.all(raw.map(async (position) => {
    const symbols = String(position.coin || '').split('/').filter(Boolean);
    const meta = await fetchPancakePoolMeta(symbols.slice(0, 2));
    return meta ? enrichPriceFields({ ...position, ...meta }, meta) : position;
  }));

  return enriched.sort((a, b) => new Date(b.date) - new Date(a.date));
}

function serveStatic(res, pathname) {
  const file = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(process.cwd(), 'public', file);

  if (!full.startsWith(path.join(process.cwd(), 'public')) || !fs.existsSync(full)) return false;

  const ext = path.extname(full);
  const type = ext === '.html' ? 'text/html' : 'text/plain';

  res.writeHead(200, { 'Content-Type': type });
  res.end(fs.readFileSync(full));
  
  return true;
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (pathname === '/api/positions' && req.method === 'GET') {
    const data = readData();
    const manual = (data.positions || []).map(calcMetrics);
    const derived = await buildDerivedPositions(data.cashflows || [], data.lastScrapedAddress || '');
    return sendJson(res, 200, [...derived, ...manual]);
  }
  else if (pathname === '/api/cashflows' && req.method === 'GET') return sendJson(res, 200, readData().cashflows || []);
  else if (pathname === '/api/scrape' && req.method === 'POST') {

    const { address } = await readBody(req);

    if (!address) return sendJson(res, 400, { error: 'address is required' });

    const api = `https://bsc-mainnet.nodereal.io/v1/0ff69eec2396484fb92903b68c23c026`;
    
    try {
      const makePayload = (direction, pageKey) => ({
        jsonrpc: '2.0',
        method: 'nr_getAssetTransfers',
        params: [{
          [direction === 'in' ? 'toAddress' : 'fromAddress']: address,
          category: ['external', 'internal', '20'],
          withMetadata: true,
          excludeZeroValue: false,
          maxCount: '0x12c',
          order: 'desc',
          ...(pageKey ? { pageKey } : {})
        }],
        id: direction === 'in' ? 1 : 2
      });

      const loadTransfers = async (direction) => {
        const transfers = [];
        let pageKey;

        do {
          const response = await fetch(api, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(makePayload(direction, pageKey))
          });
          const json = await response.json();
          if (!response.ok) {
            return { error: { status: response.status, body: json } };
          }

          const batch = json?.result?.transfers;
          if (!Array.isArray(batch)) return { error: { status: 502, body: json } };

          transfers.push(...batch);
          pageKey = json?.result?.pageKey;
        } while (pageKey);

        return { transfers };
      };

      const [inResult, outResult] = await Promise.all([loadTransfers('in'), loadTransfers('out')]);
      if (inResult.error || outResult.error) {
        return sendJson(res, 502, {
          error: 'BSCTrace request failed',
          details: { in: inResult.error || null, out: outResult.error || null }
        });
      }

      const inTransfers = inResult.transfers;
      const outTransfers = outResult.transfers;

      const txs = [...inTransfers, ...outTransfers];
      const parseTimestamp = (value) => {
        if (typeof value === 'string' && value.includes('T')) return new Date(value).toISOString();

        const n = Number(value || 0);
        const ms = n > 1e12 ? n : n * 1000;
        return new Date(ms || 0).toISOString();
      };

      const parsed = txs.filter(t => t && t.hash).map(t => {
        const decimals = Number(t.rawContract?.decimal || (t.asset ? 18 : 18));
        const valueRaw = Number(t.value || 0);
        const valueAmount = decimals >= 0 ? valueRaw / (10 ** decimals) : 0;
        const symbol = String(t.asset || t.rawContract?.symbol || '').toUpperCase();
        const isNativeBnb = !t.asset || symbol === 'BNB' || symbol === 'WBNB';
        const valueBnb = isNativeBnb ? valueAmount : 0;
        const direction = t.to?.toLowerCase() === address.toLowerCase() ? 'in' : 'out';
        const gasUsed = Number(t.gasUsed || t.receipt?.gasUsed || 0);
        const gasPriceWei = Number(t.gasPrice || t.effectiveGasPrice || 0);
        const gasFeeBnb = gasUsed > 0 && gasPriceWei > 0 ? (gasUsed * gasPriceWei) / 1e18 : 0;
        const rawTimestamp = t.blockTimeStamp || t.metadata?.blockTimestamp || t.timeStamp || t.blockTimestamp;

        return {
          txHash: t.hash, timestamp: parseTimestamp(rawTimestamp),
          from: t.from, to: t.to, valueBnb: Number(valueBnb.toFixed(8)),
          assetSymbol: symbol || null,
          valueAmount: Number(valueAmount.toFixed(12)),
          tokenDecimals: decimals,
          direction,
          gasPriceWei,
          gasUsed,
          gasFeeBnb: Number(gasFeeBnb.toFixed(8)),
          transferCount: 1,
          internalTransferCount: t.category === 'internal' ? 1 : 0,
          externalTransferCount: t.category === 'external' ? 1 : 0,
          actionType: direction === 'in' ? 'in' : 'out'
        };
      });
      parsed.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      let runningBalance = 0;
      for (const row of parsed) {
        row.balanceBeforeBnb = Number(runningBalance.toFixed(8));
        runningBalance += row.direction === 'in' ? row.valueBnb : -row.valueBnb - row.gasFeeBnb;
      }

      const data = readData();
      const existingKeys = new Set((data.cashflows || []).map(x => `${x.txHash}:${x.direction || 'unknown'}`));
      const incomingByHash = new Map();
      for (const row of parsed) {
        const key = `${row.txHash}:${row.direction}`;
        const current = incomingByHash.get(key);
        if (!current) incomingByHash.set(key, { ...row });
        else {
          current.valueBnb = Number((current.valueBnb + row.valueBnb).toFixed(8));
          current.gasFeeBnb = Number((current.gasFeeBnb + row.gasFeeBnb).toFixed(8));
          current.valueAmount = Number((current.valueAmount + row.valueAmount).toFixed(12));
          current.transferCount += row.transferCount;
          current.internalTransferCount += row.internalTransferCount;
          current.externalTransferCount += row.externalTransferCount;
          if (new Date(row.timestamp) < new Date(current.timestamp)) current.timestamp = row.timestamp;
        }
      }

      const unique = [...incomingByHash.values()].filter(x => !existingKeys.has(`${x.txHash}:${x.direction}`));
      
      data.cashflows = [...(data.cashflows || []), ...unique];
      data.lastScrapedAddress = address;
      data.positions = await buildDerivedPositions(data.cashflows, address);
      writeData(data);

      return sendJson(res, 200, { imported: unique.length, totalParsed: parsed.length, cashflows: data.cashflows });
    } catch (e) { return sendJson(res, 500, { error: 'scrape failed', details: String(e) }); }
  }

  if (serveStatic(res, pathname)) return;
  return notFound(res);
});

server.listen(PORT, () => console.log(`App running on http://localhost:${PORT}`));
