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

function calcMetrics(position) {
  const start = Number(position.startAmount || 0), end = Number(position.endAmount || 0), days = Number(position.durationDays || 0);
  const profit = end - start;
  const apr = start > 0 && days > 0 ? ((profit / start) * (365 / days) * 100) : 0;
  return { ...position, profit: Number(profit.toFixed(2)), realApr: Number(apr.toFixed(8)) };
}

function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function notFound(res) { res.writeHead(404); res.end('Not found'); }

function buildDerivedPosition(cashflows = [], address = '') {
  if (!Array.isArray(cashflows) || cashflows.length === 0) return null;

  const normalizedAddress = String(address || '').toLowerCase();
  const sorted = [...cashflows].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const now = Date.now();
  const startMs = new Date(first.timestamp).getTime();
  const endMs = new Date(last.timestamp).getTime();
  const durationDays = Math.max(1, Math.ceil((Math.max(endMs, now) - startMs) / (24 * 60 * 60 * 1000)));

  let investedBnb = 0;
  let withdrawnBnb = 0;
  let totalGasBnb = 0;
  let transferCount = 0;
  let internalTransfers = 0;
  let externalTransfers = 0;

  for (const tx of sorted) {
    const value = Number(tx.valueBnb || 0);
    const gas = Number(tx.gasFeeBnb || 0);
    const direction = tx.direction || (tx.to?.toLowerCase() === normalizedAddress ? 'in' : 'out');

    if (direction === 'out') investedBnb += value;
    else withdrawnBnb += value;

    totalGasBnb += gas;
    transferCount += Number(tx.transferCount || 1);
    internalTransfers += Number(tx.internalTransferCount || 0);
    externalTransfers += Number(tx.externalTransferCount || 0);
  }

  const startAmount = investedBnb + totalGasBnb;
  const endAmount = withdrawnBnb;
  const profit = endAmount - startAmount;
  const apr = startAmount > 0 && durationDays > 0 ? ((profit / startAmount) * (365 / durationDays) * 100) : 0;

  return {
    date: first.timestamp,
    endDate: last.timestamp,
    durationDays,
    coin: 'BNB',
    chain: 'BSC',
    startAmount: Number(startAmount.toFixed(8)),
    endAmount: Number(endAmount.toFixed(8)),
    investedBnb: Number(investedBnb.toFixed(8)),
    withdrawnBnb: Number(withdrawnBnb.toFixed(8)),
    gasSpentBnb: Number(totalGasBnb.toFixed(8)),
    transferCount,
    internalTransfers,
    externalTransfers,
    uniqueTransactions: sorted.length,
    notes: 'Auto-derived from aggregated wallet cashflows including recurring internal/external LP transfers and gas.',
    profit: Number(profit.toFixed(8)),
    realApr: Number(apr.toFixed(8))
  };
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
    const derived = buildDerivedPosition(data.cashflows || [], data.lastScrapedAddress || '');
    return sendJson(res, 200, derived ? [derived, ...manual] : manual);
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
          category: ['external', 'internal'],
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
        const valueBnb = Number(t.value || 0) / 1e18;
        const direction = t.to?.toLowerCase() === address.toLowerCase() ? 'in' : 'out';
        const gasUsed = Number(t.gasUsed || t.receipt?.gasUsed || 0);
        const gasPriceWei = Number(t.gasPrice || t.effectiveGasPrice || 0);
        const gasFeeBnb = gasUsed > 0 && gasPriceWei > 0 ? (gasUsed * gasPriceWei) / 1e18 : 0;
        const rawTimestamp = t.blockTimeStamp || t.metadata?.blockTimestamp || t.timeStamp || t.blockTimestamp;

        return {
          txHash: t.hash, timestamp: parseTimestamp(rawTimestamp),
          from: t.from, to: t.to, valueBnb: Number(valueBnb.toFixed(8)),
          direction,
          gasPriceWei,
          gasUsed,
          gasFeeBnb: Number(gasFeeBnb.toFixed(8)),
          transferCount: 1,
          internalTransferCount: t.category === 'internal' ? 1 : 0,
          externalTransferCount: t.category === 'external' ? 1 : 0,
          action: direction === 'in' ? 'collect/reward/withdraw' : 'invest/reinvest/fee',
          note: 'Auto-imported. Verify LP operation type manually.'
        };
      });

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
          current.transferCount += row.transferCount;
          current.internalTransferCount += row.internalTransferCount;
          current.externalTransferCount += row.externalTransferCount;
          if (new Date(row.timestamp) < new Date(current.timestamp)) current.timestamp = row.timestamp;
        }
      }

      const unique = [...incomingByHash.values()].filter(x => !existingKeys.has(`${x.txHash}:${x.direction}`));
      
      data.cashflows = [...(data.cashflows || []), ...unique];
      data.lastScrapedAddress = address;
      writeData(data);

      return sendJson(res, 200, { imported: unique.length, totalParsed: parsed.length, cashflows: data.cashflows });
    } catch (e) { return sendJson(res, 500, { error: 'scrape failed', details: String(e) }); }
  }

  if (serveStatic(res, pathname)) return;
  return notFound(res);
});

server.listen(PORT, () => console.log(`App running on http://localhost:${PORT}`));
