// Grid-Suitability Screener
// Reads the collector's market_data.db and scores a symbol on 5 metrics
// that determine whether a grid bot is viable: volatility, trend, liquidity,
// funding cost, and range behavior. Pure read-only analysis. Node >= 22.
'use strict';

const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || './market_data.db';
const SYMBOL = process.env.SYMBOL || 'BTWUSDT';
const INTERVAL = process.env.INTERVAL || '15m';

const db = new DatabaseSync(DB_PATH, { readOnly: true });

// ---------- load candles ----------
function loadCandles() {
  const rows = db.prepare(
    `SELECT open_time, open, high, low, close FROM klines
     WHERE symbol=? AND interval=? ORDER BY open_time ASC`
  ).all(SYMBOL, INTERVAL);
  return rows.map(r => ({
    t: r.open_time, o: +r.open, h: +r.high, l: +r.low, c: +r.close
  }));
}

// ---------- indicators ----------
function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0], out = [e];
  for (let i = 1; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
  return out;
}

function atr(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  // Wilder's smoothing
  const out = [];
  let a = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  out[period - 1] = a;
  for (let i = period; i < trs.length; i++) { a = (a * (period - 1) + trs[i]) / period; out[i] = a; }
  return out; // aligned to trs index (candle i+1)
}

function adx(candles, period = 14) {
  if (candles.length < period * 2) return null;
  let plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const down = candles[i - 1].l - candles[i].l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const smooth = arr => {
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s); }
    return out;
  };
  const strP = smooth(plusDM), strM = smooth(minusDM), strTR = smooth(tr);
  const dx = [];
  for (let i = 0; i < strTR.length; i++) {
    const pdi = 100 * strP[i] / strTR[i];
    const mdi = 100 * strM[i] / strTR[i];
    dx.push(100 * Math.abs(pdi - mdi) / (pdi + mdi || 1));
  }
  // ADX = smoothed DX
  const adxArr = [];
  let a = dx.slice(0, period).reduce((x, y) => x + y, 0) / period;
  adxArr[period - 1] = a;
  for (let i = period; i < dx.length; i++) { a = (a * (period - 1) + dx[i]) / period; adxArr[i] = a; }
  return adxArr.filter(x => x !== undefined);
}

function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((s.length - 1) * p);
  return s[idx];
}

// ---------- metrics ----------
function analyze() {
  const candles = loadCandles();
  const report = { symbol: SYMBOL, interval: INTERVAL, candles: candles.length };

  if (candles.length < 40) {
    report.warning = `Only ${candles.length} candles — too little history for reliable metrics. Need ~100+.`;
  }

  // 1. Volatility: ATR% of price, and its stability
  const atrArr = atr(candles, 14);
  const closes = candles.map(c => c.c);
  const atrPct = [];
  for (let i = 0; i < atrArr.length; i++) {
    if (atrArr[i] !== undefined) atrPct.push(100 * atrArr[i] / candles[i + 1].c);
  }
  const medAtrPct = percentile(atrPct, 0.5);
  const atrStability = percentile(atrPct, 0.9) / (percentile(atrPct, 0.1) || 1e-9); // lower = steadier
  report.volatility = {
    median_atr_pct: +medAtrPct.toFixed(3),
    p10: +percentile(atrPct, 0.1).toFixed(3),
    p90: +percentile(atrPct, 0.9).toFixed(3),
    stability_ratio: +atrStability.toFixed(2),
  };

  // 2. Trend: ADX, and % of time ranging (ADX<20)
  const adxArr = adx(candles, 14) || [];
  const pctRanging = adxArr.length ? 100 * adxArr.filter(x => x < 20).length / adxArr.length : null;
  report.trend = {
    median_adx: adxArr.length ? +percentile(adxArr, 0.5).toFixed(1) : null,
    pct_time_ranging: pctRanging !== null ? +pctRanging.toFixed(1) : null,
  };

  // 3. Liquidity: spread in ticks, depth notional
  const book = db.prepare(`SELECT spread_ticks FROM book WHERE symbol=? AND spread_ticks IS NOT NULL`).all(SYMBOL);
  const spreads = book.map(b => b.spread_ticks);
  const depth = db.prepare(`SELECT bid_notional_05, ask_notional_05 FROM depth WHERE symbol=?`).all(SYMBOL);
  const avgDepth = depth.length
    ? depth.reduce((s, d) => s + (d.bid_notional_05 + d.ask_notional_05) / 2, 0) / depth.length : null;
  report.liquidity = {
    median_spread_ticks: spreads.length ? +percentile(spreads, 0.5).toFixed(1) : null,
    avg_depth_usd_pm05pct: avgDepth ? +avgDepth.toFixed(0) : null,
    spread_samples: spreads.length,
  };

  // 4. Funding cost
  const fund = db.prepare(`SELECT funding_rate FROM funding WHERE symbol=?`).all(SYMBOL);
  const rates = fund.map(f => Math.abs(+f.funding_rate)).filter(x => !isNaN(x));
  report.funding = {
    avg_abs_rate: rates.length ? +(rates.reduce((s, x) => s + x, 0) / rates.length).toFixed(6) : null,
    avg_abs_rate_pct_per_8h: rates.length ? +((rates.reduce((s, x) => s + x, 0) / rates.length) * 100).toFixed(4) : null,
    samples: rates.length,
  };

  // 5. Range behavior: net travel vs total path (lower = more range-bound = better)
  if (candles.length > 1) {
    const hi = Math.max(...candles.map(c => c.h)), lo = Math.min(...candles.map(c => c.l));
    const net = Math.abs(candles[candles.length - 1].c - candles[0].c);
    let path = 0;
    for (let i = 1; i < candles.length; i++) path += Math.abs(candles[i].c - candles[i - 1].c);
    report.range = {
      band_pct: +(100 * (hi - lo) / candles[0].c).toFixed(1),
      net_move_pct: +(100 * net / candles[0].c).toFixed(1),
      efficiency: +(net / (path || 1e-9)).toFixed(3), // ~0 chops a lot (good), ~1 straight trend (bad)
    };
  }

  return report;
}

// ---------- scoring ----------
function score(r) {
  const notes = [];
  let s = 0, max = 0;

  // Volatility (want moderate & steady): ideal median ATR% ~0.3-1.5 on 15m
  max += 25;
  if (r.volatility) {
    const v = r.volatility.median_atr_pct;
    if (v >= 0.3 && v <= 1.5) { s += 15; notes.push(`✓ volatility in good range (${v}%)`); }
    else if (v > 1.5) { s += 6; notes.push(`⚠ high volatility (${v}%) — price may escape grids`); }
    else { s += 6; notes.push(`⚠ low volatility (${v}%) — few fills`); }
    if (r.volatility.stability_ratio < 4) { s += 10; notes.push(`✓ volatility is steady`); }
    else { notes.push(`⚠ volatility unstable (ratio ${r.volatility.stability_ratio})`); }
  }

  // Trend (want low ADX, lots of ranging time)
  max += 25;
  if (r.trend && r.trend.pct_time_ranging !== null) {
    const pr = r.trend.pct_time_ranging;
    if (pr >= 60) { s += 25; notes.push(`✓ ranges ${pr}% of the time — grid-friendly`); }
    else if (pr >= 40) { s += 15; notes.push(`~ ranges ${pr}% of the time`); }
    else { s += 5; notes.push(`✗ only ranges ${pr}% — trends too often for a static grid`); }
  }

  // Liquidity (want tight spread, decent depth)
  max += 30;
  if (r.liquidity && r.liquidity.median_spread_ticks !== null) {
    const sp = r.liquidity.median_spread_ticks;
    if (sp <= 2) { s += 20; notes.push(`✓ tight spread (${sp} ticks)`); }
    else if (sp <= 5) { s += 10; notes.push(`⚠ moderate spread (${sp} ticks) — needs wider grids`); }
    else { s += 2; notes.push(`✗ wide spread (${sp} ticks) — fees will hurt`); }
    const d = r.liquidity.avg_depth_usd_pm05pct;
    if (d && d > 50000) { s += 10; notes.push(`✓ deep book (~$${d})`); }
    else if (d && d > 10000) { s += 5; notes.push(`~ moderate depth (~$${d})`); }
    else if (d) { notes.push(`✗ thin book (~$${d}) — hard to fill size`); }
  }

  // Funding (want near zero)
  max += 10;
  if (r.funding && r.funding.avg_abs_rate_pct_per_8h !== null) {
    const f = r.funding.avg_abs_rate_pct_per_8h;
    if (f < 0.01) { s += 10; notes.push(`✓ low funding cost (${f}%/8h)`); }
    else if (f < 0.05) { s += 5; notes.push(`~ moderate funding (${f}%/8h)`); }
    else { notes.push(`✗ high funding (${f}%/8h) — drains biased grids`); }
  }

  // Range efficiency (want low = choppy)
  max += 10;
  if (r.range) {
    const e = r.range.efficiency;
    if (e < 0.1) { s += 10; notes.push(`✓ very choppy (efficiency ${e}) — ideal for grids`); }
    else if (e < 0.3) { s += 6; notes.push(`~ somewhat choppy (efficiency ${e})`); }
    else { s += 1; notes.push(`✗ directional (efficiency ${e}) — trending, not ranging`); }
  }

  return { score: s, max, pct: +(100 * s / max).toFixed(0), notes };
}

// ---------- output ----------
const r = analyze();
const sc = score(r);

console.log('\n===== GRID-SUITABILITY SCREEN =====');
console.log(`Symbol: ${r.symbol}   Interval: ${r.interval}   Candles: ${r.candles}`);
if (r.warning) console.log(`\n⚠ ${r.warning}`);
console.log('\n--- Metrics ---');
console.log('Volatility :', JSON.stringify(r.volatility));
console.log('Trend      :', JSON.stringify(r.trend));
console.log('Liquidity  :', JSON.stringify(r.liquidity));
console.log('Funding    :', JSON.stringify(r.funding));
console.log('Range      :', JSON.stringify(r.range));
console.log('\n--- Assessment ---');
for (const n of sc.notes) console.log('  ' + n);
console.log(`\nSCORE: ${sc.score}/${sc.max}  (${sc.pct}%)`);
let verdict;
if (sc.pct >= 70) verdict = 'GOOD grid candidate';
else if (sc.pct >= 50) verdict = 'MARGINAL — tune carefully or wait for better conditions';
else verdict = 'POOR grid candidate — high risk of losing to fees/trends';
console.log(`VERDICT: ${verdict}`);
console.log('\nNote: scores reflect recent collected data only. More history = more reliable.\n');

db.close();

