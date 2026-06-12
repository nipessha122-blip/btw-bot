// BTWUSDT Data Collector — Phase 0
// Records: 1m/15m/1h klines, funding rate, open interest, spread, ±0.5% depth
// Storage: SQLite (node:sqlite, built-in). Run with Node >= 22.
'use strict';

const { DatabaseSync } = require('node:sqlite');
const WebSocket = require('ws');

// ---------- config ----------
const SYMBOL = process.env.SYMBOL || 'BTWUSDT';
const DB_PATH = process.env.DB_PATH || './market_data.db';
const REST = 'https://fapi.binance.com';
const WS_URL = `wss://fstream.binance.com/stream?streams=` +
  ['kline_1m', 'kline_15m', 'kline_1h', 'markPrice@1s', 'bookTicker']
    .map(s => `${SYMBOL.toLowerCase()}@${s}`).join('/');
const INTERVALS = ['1m', '15m', '1h'];
const OI_POLL_MS = 5 * 60 * 1000;      // open interest every 5 min
const DEPTH_POLL_MS = 5 * 60 * 1000;   // order book depth every 5 min
const SAMPLE_MS = 60 * 1000;           // funding + spread samples every 60s
const WS_SILENCE_LIMIT_MS = 60 * 1000; // reconnect if stream silent
const BACKFILL_DEFAULT_MS = { '1m': 3 * 864e5, '15m': 14 * 864e5, '1h': 30 * 864e5 };

// ---------- database ----------
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS klines (
    symbol TEXT NOT NULL, interval TEXT NOT NULL, open_time INTEGER NOT NULL,
    open TEXT, high TEXT, low TEXT, close TEXT, volume TEXT, quote_volume TEXT,
    trades INTEGER, close_time INTEGER,
    PRIMARY KEY (symbol, interval, open_time)
  );
  CREATE TABLE IF NOT EXISTS funding (
    symbol TEXT NOT NULL, ts INTEGER NOT NULL,
    mark_price TEXT, index_price TEXT, funding_rate TEXT, next_funding_time INTEGER,
    PRIMARY KEY (symbol, ts)
  );
  CREATE TABLE IF NOT EXISTS open_interest (
    symbol TEXT NOT NULL, ts INTEGER NOT NULL, oi TEXT,
    PRIMARY KEY (symbol, ts)
  );
  CREATE TABLE IF NOT EXISTS book (
    symbol TEXT NOT NULL, ts INTEGER NOT NULL,
    bid TEXT, ask TEXT, bid_qty TEXT, ask_qty TEXT, spread_ticks REAL,
    PRIMARY KEY (symbol, ts)
  );
  CREATE TABLE IF NOT EXISTS depth (
    symbol TEXT NOT NULL, ts INTEGER NOT NULL,
    bid_notional_05 REAL, ask_notional_05 REAL, levels_bid INTEGER, levels_ask INTEGER,
    PRIMARY KEY (symbol, ts)
  );
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`);

const stmt = {
  kline: db.prepare(`INSERT OR REPLACE INTO klines VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
  funding: db.prepare(`INSERT OR REPLACE INTO funding VALUES (?,?,?,?,?,?)`),
  oi: db.prepare(`INSERT OR REPLACE INTO open_interest VALUES (?,?,?)`),
  book: db.prepare(`INSERT OR REPLACE INTO book VALUES (?,?,?,?,?,?,?)`),
  depth: db.prepare(`INSERT OR REPLACE INTO depth VALUES (?,?,?,?,?,?)`),
  lastKline: db.prepare(`SELECT MAX(open_time) AS t FROM klines WHERE symbol=? AND interval=?`),
  metaSet: db.prepare(`INSERT OR REPLACE INTO meta VALUES (?,?)`),
};

// ---------- helpers ----------
const log = (...a) => console.log(new Date().toISOString(), ...a);
const logErr = (...a) => console.error(new Date().toISOString(), 'ERROR', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rest(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${REST}${path}${qs ? '?' + qs : ''}`);
  if (!res.ok) throw new Error(`REST ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---------- tick size (for spread in ticks) ----------
let tickSize = null;
async function loadTickSize() {
  try {
    const info = await rest('/fapi/v1/exchangeInfo');
    const sym = (info.symbols || []).find(s => s.symbol === SYMBOL);
    if (!sym) { logErr(`symbol ${SYMBOL} not found in exchangeInfo`); return; }
    const pf = (sym.filters || []).find(f => f.filterType === 'PRICE_FILTER');
    if (pf) { tickSize = parseFloat(pf.tickSize); stmt.metaSet.run('tickSize', pf.tickSize); }
    stmt.metaSet.run('contractStatus', sym.status || 'UNKNOWN');
    log(`exchangeInfo: status=${sym.status} tickSize=${tickSize}`);
  } catch (e) { logErr('loadTickSize:', e.message); }
}

// ---------- kline backfill (startup + gap repair on reconnect) ----------
async function backfill(interval) {
  try {
    const last = stmt.lastKline.get(SYMBOL, interval).t;
    let start = last ? last + 1 : Date.now() - BACKFILL_DEFAULT_MS[interval];
    let total = 0;
    for (let i = 0; i < 30; i++) { // safety cap per run
      const rows = await rest('/fapi/v1/klines',
        { symbol: SYMBOL, interval, startTime: start, limit: 1000 });
      if (!rows.length) break;
      for (const k of rows) {
        // skip the still-open candle (close_time in the future)
        if (k[6] > Date.now()) continue;
        stmt.kline.run(SYMBOL, interval, k[0], k[1], k[2], k[3], k[4], k[5], k[7], k[8], k[6]);
        total++;
      }
      start = rows[rows.length - 1][0] + 1;
      if (rows.length < 1000) break;
      await sleep(300); // be polite to rate limits
    }
    if (total) log(`backfill ${interval}: +${total} candles`);
  } catch (e) { logErr(`backfill ${interval}:`, e.message); }
}

// ---------- pollers ----------
async function pollOpenInterest() {
  try {
    const d = await rest('/fapi/v1/openInterest', { symbol: SYMBOL });
    stmt.oi.run(SYMBOL, Date.now(), String(d.openInterest));
  } catch (e) { logErr('openInterest:', e.message); }
}

async function pollDepth() {
  try {
    const d = await rest('/fapi/v1/depth', { symbol: SYMBOL, limit: 500 });
    const bestBid = parseFloat(d.bids?.[0]?.[0]), bestAsk = parseFloat(d.asks?.[0]?.[0]);
    if (!bestBid || !bestAsk) return;
    const mid = (bestBid + bestAsk) / 2, lo = mid * 0.995, hi = mid * 1.005;
    let bidN = 0, askN = 0, lb = 0, la = 0;
    for (const [p, q] of d.bids) { const pf = parseFloat(p); if (pf < lo) break; bidN += pf * parseFloat(q); lb++; }
    for (const [p, q] of d.asks) { const pf = parseFloat(p); if (pf > hi) break; askN += pf * parseFloat(q); la++; }
    stmt.depth.run(SYMBOL, Date.now(), bidN, askN, lb, la);
  } catch (e) { logErr('depth:', e.message); }
}

// ---------- websocket ----------
let ws = null, lastMsgAt = Date.now(), reconnectDelay = 1000;
let latestMark = null, latestBook = null;

const streamCounts = {};
function handleMessage(raw) {
  lastMsgAt = Date.now();
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  const d = msg.data; if (!d) return;
  const key = msg.stream || d.e || 'unknown';
  streamCounts[key] = (streamCounts[key] || 0) + 1;
  try {
    if (d.e === 'kline' && d.k && d.k.x === true) {
      const k = d.k;
      stmt.kline.run(SYMBOL, k.i, k.t, k.o, k.h, k.l, k.c, k.v, k.q, k.n, k.T);
    } else if (d.e === 'markPriceUpdate' || (d.p !== undefined && d.r !== undefined && d.T !== undefined)) {
      // markPrice stream: p=mark, i=index, r=funding rate, T=next funding time
      latestMark = d;
    } else if (d.e === 'bookTicker' || (d.b && d.a)) {
      latestBook = d;
    }
  } catch (e) { logErr('handleMessage:', e.message); }
}

function sampleLatest() {
  const now = Date.now();
  try {
    if (latestMark) stmt.funding.run(SYMBOL, now, latestMark.p, latestMark.i, latestMark.r, latestMark.T);
    if (latestBook) {
      const bid = parseFloat(latestBook.b), ask = parseFloat(latestBook.a);
      const spreadTicks = tickSize ? (ask - bid) / tickSize : null;
      stmt.book.run(SYMBOL, now, latestBook.b, latestBook.a, latestBook.B, latestBook.A, spreadTicks);
    }
  } catch (e) { logErr('sampleLatest:', e.message); }
}

function connect() {
  log('WS connecting...');
  ws = new WebSocket(WS_URL);
  ws.on('open', () => {
    log('WS connected');
    reconnectDelay = 1000;
    lastMsgAt = Date.now();
    for (const iv of INTERVALS) backfill(iv); // repair any gap from downtime
  });
  ws.on('message', handleMessage);
  ws.on('error', e => logErr('WS:', e.message));
  ws.on('close', async () => {
    logErr(`WS closed; reconnecting in ${reconnectDelay}ms`);
    await sleep(reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    connect();
  });
}

// watchdog: silent stream => force reconnect (Binance also drops conns ~24h)
setInterval(() => {
  if (Date.now() - lastMsgAt > WS_SILENCE_LIMIT_MS && ws) {
    logErr('WS silent > 60s, terminating for reconnect');
    try { ws.terminate(); } catch {}
  }
}, 15000);

// ---------- heartbeat ----------
function heartbeat() {
  try {
    const counts = {};
    for (const t of ['klines', 'funding', 'open_interest', 'book', 'depth'])
      counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    log('heartbeat', JSON.stringify(counts), `streams=${JSON.stringify(streamCounts)}`, `rssMB=${(process.memoryUsage().rss / 1048576).toFixed(0)}`);
  } catch (e) { logErr('heartbeat:', e.message); }
}

// ---------- lifecycle ----------
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
function shutdown() { log('shutting down'); try { ws?.terminate(); db.close(); } catch {} process.exit(0); }
process.on('unhandledRejection', e => logErr('unhandledRejection:', e?.message || e));
process.on('uncaughtException', e => { logErr('uncaughtException:', e?.message || e); process.exit(1); });

// ---------- smoke test mode (no network) ----------
if (process.env.SMOKE_TEST) {
  stmt.kline.run(SYMBOL, '1m', 1, '0.04', '0.041', '0.039', '0.0405', '1000', '40', 5, 60001);
  stmt.funding.run(SYMBOL, 2, '0.0405', '0.0404', '0.0001', 99999);
  stmt.oi.run(SYMBOL, 3, '123456');
  stmt.book.run(SYMBOL, 4, '0.0404', '0.0406', '100', '90', 2);
  stmt.depth.run(SYMBOL, 5, 5000, 4800, 10, 9);
  heartbeat();
  console.log('SMOKE_TEST passed');
  process.exit(0);
}

// ---------- start ----------
(async () => {
  log(`collector starting for ${SYMBOL}, db=${DB_PATH}`);
  await loadTickSize();
  for (const iv of INTERVALS) await backfill(iv);
  connect();
  setInterval(sampleLatest, SAMPLE_MS);
  setInterval(pollOpenInterest, OI_POLL_MS);
  setInterval(pollDepth, DEPTH_POLL_MS);
  setInterval(loadTickSize, 6 * 3600 * 1000); // refresh contract status 4x/day
  setInterval(heartbeat, 10 * 60 * 1000);
  pollOpenInterest(); pollDepth();
})();

