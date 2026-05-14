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

  if (pathname === '/api/positions' && req.method === 'GET') return sendJson(res, 200, readData().positions.map(calcMetrics));
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

        return {
          txHash: t.hash, timestamp: parseTimestamp(t.metadata?.blockTimestamp || t.timeStamp || t.blockTimestamp),
          from: t.from, to: t.to, valueBnb: Number(valueBnb.toFixed(8)),
          action: direction === 'in' ? 'collect/reward/withdraw' : 'invest/reinvest/fee',
          note: 'Auto-imported. Verify LP operation type manually.'
        };
      });

      const data = readData();
      const seen = new Set((data.cashflows || []).map(x => x.txHash));
      const unique = parsed.filter((x, idx, arr) => !seen.has(x.txHash) && arr.findIndex(y => y.txHash === x.txHash) === idx);
      
      data.cashflows = [...(data.cashflows || []), ...unique];
      writeData(data);

      return sendJson(res, 200, { imported: unique.length, totalParsed: parsed.length, cashflows: data.cashflows });
    } catch (e) { return sendJson(res, 500, { error: 'scrape failed', details: String(e) }); }
  }

  if (serveStatic(res, pathname)) return;
  return notFound(res);
});

server.listen(PORT, () => console.log(`App running on http://localhost:${PORT}`));
