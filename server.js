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

  if (pathname === '/api/positions' && req.method === 'GET') {
    return sendJson(res, 200, readData().positions.map(calcMetrics));
  }
  if (pathname === '/api/positions' && req.method === 'POST') {
    const body = await readBody(req);
    const data = readData();
    const row = { id: Date.now().toString(), ...body };
    data.positions.push(row); writeData(data);
    return sendJson(res, 201, calcMetrics(row));
  }
  if (pathname.startsWith('/api/positions/') && req.method === 'DELETE') {
    const id = pathname.split('/').pop();
    const data = readData();
    data.positions = data.positions.filter(p => p.id !== id); writeData(data);
    res.writeHead(204); return res.end();
  }
  if (pathname === '/api/cashflows' && req.method === 'GET') return sendJson(res, 200, readData().cashflows || []);

  if (pathname === '/api/scrape' && req.method === 'POST') {
    const { address } = await readBody(req);
    if (!address) return sendJson(res, 400, { error: 'address is required' });
    const key = process.env.MEGANODE_API_KEY || process.env.BSCTRACE_API_KEY || '';
    if (!key) return sendJson(res, 400, { error: 'MEGANODE_API_KEY (or BSCTRACE_API_KEY) is required' });
    const api = `https://bsc-mainnet.nodereal.io/v1/${key}`;
    try {
      const makePayload = (direction) => ({
        jsonrpc: '2.0',
        method: 'nr_getAssetTransfers',
        params: [{
          [direction === 'in' ? 'toAddress' : 'fromAddress']: address,
          category: ['external'],
          withMetadata: true,
          excludeZeroValue: true,
          maxCount: '0x12c',
          order: 'desc'
        }],
        id: direction === 'in' ? 1 : 2
      });

      const [inResponse, outResponse] = await Promise.all([
        fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(makePayload('in')) }),
        fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(makePayload('out')) })
      ]);

      const inJson = await inResponse.json();
      const outJson = await outResponse.json();
      if (!inResponse.ok || !outResponse.ok) {
        return sendJson(res, 502, { error: 'BSCTrace request failed', status: { in: inResponse.status, out: outResponse.status } });
      }

      const inTransfers = inJson?.result?.transfers;
      const outTransfers = outJson?.result?.transfers;
      if (!Array.isArray(inTransfers) || !Array.isArray(outTransfers)) {
        return sendJson(res, 502, {
          error: 'BSCTrace returned unexpected payload',
          details: { in: inJson?.error || inJson?.result || inJson, out: outJson?.error || outJson?.result || outJson }
        });
      }

      const txs = [...inTransfers, ...outTransfers].slice(0, 300);
      const parsed = txs.filter(t => t && t.hash).map(t => {
        const valueBnb = Number(t.value || 0) / 1e18;
        const direction = t.to?.toLowerCase() === address.toLowerCase() ? 'in' : 'out';
        return {
          txHash: t.hash, timestamp: new Date(Number(t.metadata?.blockTimestamp || t.timeStamp || 0) * 1000).toISOString(),
          from: t.from, to: t.to, valueBnb: Number(valueBnb.toFixed(8)),
          action: direction === 'in' ? 'collect/reward/withdraw' : 'invest/reinvest/fee',
          note: 'Auto-imported. Verify LP operation type manually.'
        };
      });
      const data = readData();
      const seen = new Set((data.cashflows || []).map(x => x.txHash));
      const unique = parsed.filter(x => !seen.has(x.txHash));
      data.cashflows = [...(data.cashflows || []), ...unique]; writeData(data);
      return sendJson(res, 200, { imported: unique.length, totalParsed: parsed.length, cashflows: unique.slice(0, 50) });
    } catch (e) { return sendJson(res, 500, { error: 'scrape failed', details: String(e) }); }
  }

  if (serveStatic(res, pathname)) return;
  return notFound(res);
});

server.listen(PORT, () => console.log(`App running on http://localhost:${PORT}`));
