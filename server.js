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
    const key = process.env.ROUTESCAN_API_KEY || process.env.BSCSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '';
    const params = new URLSearchParams({
      chainid: '56',
      module: 'account',
      action: 'txlist',
      address,
      sort: 'desc'
    });
    if (key) params.set('apikey', key);
    const api = `https://api.routescan.io/v2/network/mainnet/evm/56/etherscan/api?${params.toString()}`;
    try {
      const response = await fetch(api);
      const json = await response.json();
      if (!response.ok) {
        return sendJson(res, 502, { error: 'routescan request failed', status: response.status });
      }

      if (!Array.isArray(json.result)) {
        const details = json.result || json.message || 'unknown error';
        const deprecatedV1 = typeof details === 'string' && details.toUpperCase().includes('NOTOK');
        return sendJson(res, 502, {
          error: deprecatedV1
            ? 'RouteScan returned an error payload. Set a valid ROUTESCAN_API_KEY if required.'
            : 'routescan returned unexpected payload',
          details
        });
      }

      const txs = json.result.slice(0, 300);
      const parsed = txs.filter(t => t && t.isError === '0').map(t => {
        const valueBnb = Number(t.value) / 1e18;
        const direction = t.to?.toLowerCase() === address.toLowerCase() ? 'in' : 'out';
        return {
          txHash: t.hash, timestamp: new Date(Number(t.timeStamp) * 1000).toISOString(),
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
