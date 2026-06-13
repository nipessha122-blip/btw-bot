// Regime Engine — Analysis Mode
// Reads the collector DB and classifies each closed candle into one of:
//   RANGING / TRENDING_UP / TRENDING_DOWN / CHAOS
// using ADX, ATR%, EMA structure, funding, and spread, with hysteresis.
// Prints a timeline + summary. Read-only. Node >= 22.
//
// Usage: SYMBOL=LTCUSDT DB_PATH=./ltc_data.db node regime.js
//        add TAIL=50 to print only the last 50 classified candles
'use strict';

const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || './ltc_data.db';
const SYMBOL = process.env.SYMBOL || 'LTCUSDT';
const INTERVAL = process.env.INTERVAL || '15m';
const TAIL = Number(process.env.TAIL || 60);

// ---- tunable thresholds (we adjust these after seeing output) ----
const TH = {
  adxRange: 20,        // ADX below this = ranging
  adxTrend: 25,        // ADX at/above this = trending
  atrChaosPct: 0.90,   // ATR% above this percentile of history = chaos candidate
  atrChaosFloor: 2.0,  // ...but only if ATR% also exceeds this absolute % (avoids calling calm coins chaotic)
  fundingPanic: 0.05,  // |funding rate| %/8h above this = chaos
  spreadChaosTicks: 10,// spread above this many ticks = chaos
  candleShockAtrMult: 3, // single candle range > this * ATR = chaos
  hysteresis: 2,       // regime must persist this many candles to switch
};

const db = new DatabaseSync(DB_PATH, { readOnly: true });

// ---- load data ----
const candles = db.prepare(
  `SELECT open_time, open, high, low, close FROM klines
   WHERE symbol=? AND interval=? ORDER BY open_time ASC`
).all(SYMBOL, INTERVAL).map(r => ({ t:r.open_time, o:+r.open, h:+r.high, l:+r.low, c:+r.close }));

// funding & spread keyed by time for lookup (nearest-before)
const funding = db.prepare(`SELECT ts, funding_rate FROM funding WHERE symbol=? ORDER BY ts ASC`).all(SYMBOL)
  .map(r => ({ ts:r.ts, rate:Math.abs(+r.funding_rate) })).filter(x=>!isNaN(x.rate));
const book = db.prepare(`SELECT ts, spread_ticks FROM book WHERE symbol=? AND spread_ticks IS NOT NULL ORDER BY ts ASC`).all(SYMBOL)
  .map(r => ({ ts:r.ts, sp:r.spread_ticks }));

function nearestBefore(arr, t, field) {
  // simple scan back from end; arrays are small enough
  let val = null;
  for (let i = arr.length - 1; i >= 0; i--) { if (arr[i].ts <= t) { val = arr[i][field]; break; } }
  return val;
}

if (candles.length < 40) {
  console.log(`Only ${candles.length} candles — need ~40+ for ADX. Let it collect longer.`);
  process.exit(0);
}

// ---- indicators ----
function atrSeries(c, p=14) {
  const tr=[]; for(let i=1;i<c.length;i++) tr.push(Math.max(c[i].h-c[i].l,Math.abs(c[i].h-c[i-1].c),Math.abs(c[i].l-c[i-1].c)));
  const out=[]; let a=tr.slice(0,p).reduce((s,x)=>s+x,0)/p; out[p]=a; // aligned to candle index i (uses tr[i-1])
  for(let i=p+1;i<c.length;i++){ a=(a*(p-1)+tr[i-1])/p; out[i]=a; }
  return out; // out[i] = ATR at candle i
}
function emaSeries(vals,p){ const k=2/(p+1); let e=vals[0]; const o=[e]; for(let i=1;i<vals.length;i++){e=vals[i]*k+e*(1-k);o.push(e);} return o; }
function adxSeries(c,p=14){
  const out=new Array(c.length).fill(null);
  if(c.length<p*2) return out;
  let pDM=[],mDM=[],tr=[];
  for(let i=1;i<c.length;i++){const up=c[i].h-c[i-1].h,dn=c[i-1].l-c[i].l;
    pDM.push(up>dn&&up>0?up:0); mDM.push(dn>up&&dn>0?dn:0);
    tr.push(Math.max(c[i].h-c[i].l,Math.abs(c[i].h-c[i-1].c),Math.abs(c[i].l-c[i-1].c)));}
  const sm=a=>{let s=a.slice(0,p).reduce((x,y)=>x+y,0);const o=[s];for(let i=p;i<a.length;i++){s=s-s/p+a[i];o.push(s);}return o;};
  const sP=sm(pDM),sM=sm(mDM),sT=sm(tr),dx=[];
  for(let i=0;i<sT.length;i++){const pdi=100*sP[i]/sT[i],mdi=100*sM[i]/sT[i];dx.push(100*Math.abs(pdi-mdi)/(pdi+mdi||1));}
  let a=dx.slice(0,p).reduce((x,y)=>x+y,0)/p; const adxVals=[a];
  for(let i=p;i<dx.length;i++){a=(a*(p-1)+dx[i])/p;adxVals.push(a);}
  // map adxVals back to candle indices: dx starts at candle p (after smoothing window), adx starts p later
  const startIdx = 1 + (p-1) + (p-1); // rough alignment
  for(let i=0;i<adxVals.length;i++){ const idx=startIdx+i; if(idx<out.length) out[idx]=adxVals[i]; }
  return out;
}
function pctile(arr,q){const s=[...arr].filter(x=>x!=null).sort((a,b)=>a-b);return s.length?s[Math.floor((s.length-1)*q)]:null;}

const atr = atrSeries(candles,14);
const ema20 = emaSeries(candles.map(c=>c.c),20);
const ema50 = emaSeries(candles.map(c=>c.c),50);
const adx = adxSeries(candles,14);

// ATR% history for chaos percentile
const atrPctAll = [];
for(let i=0;i<candles.length;i++) if(atr[i]!=null) atrPctAll.push(100*atr[i]/candles[i].c);
const atrChaosThresh = pctile(atrPctAll, TH.atrChaosPct);

// ---- classify each candle (raw, before hysteresis) ----
function rawRegime(i) {
  if (atr[i]==null || adx[i]==null) return null;
  const atrPct = 100*atr[i]/candles[i].c;
  const fund = nearestBefore(funding, candles[i].t, 'rate'); // abs rate (fraction)
  const fundPct = fund!=null ? fund*100 : null;
  const spread = nearestBefore(book, candles[i].t, 'sp');
  const candleRange = candles[i].h - candles[i].l;

  // CHAOS checks (any one triggers)
  const chaosReasons = [];
  if (atrPct >= atrChaosThresh && atrPct >= TH.atrChaosFloor) chaosReasons.push('volSpike');
  if (fundPct!=null && fundPct >= TH.fundingPanic) chaosReasons.push('funding');
  if (spread!=null && spread >= TH.spreadChaosTicks) chaosReasons.push('spread');
  if (atr[i]>0 && candleRange > TH.candleShockAtrMult*atr[i]) chaosReasons.push('shock');
  if (chaosReasons.length) return { r:'CHAOS', why:chaosReasons.join(','), atrPct, adx:adx[i] };

  // TREND vs RANGE
  if (adx[i] >= TH.adxTrend) {
    const dir = ema20[i] >= ema50[i] ? 'TRENDING_UP' : 'TRENDING_DOWN';
    return { r:dir, why:`adx${adx[i].toFixed(0)}`, atrPct, adx:adx[i] };
  }
  if (adx[i] < TH.adxRange) return { r:'RANGING', why:`adx${adx[i].toFixed(0)}`, atrPct, adx:adx[i] };
  // between 20-25: ambiguous, hold previous (return null-ish neutral)
  return { r:'NEUTRAL', why:`adx${adx[i].toFixed(0)}`, atrPct, adx:adx[i] };
}

// ---- apply hysteresis: only switch after N consecutive agreeing candles ----
const regimes = new Array(candles.length).fill(null);
let current = 'RANGING', pending = null, pendingCount = 0;
const raws = [];
for (let i=0;i<candles.length;i++){
  const rr = rawRegime(i);
  raws[i] = rr;
  if (!rr) { regimes[i]=current; continue; }
  let proposed = rr.r;
  if (proposed === 'NEUTRAL') proposed = current; // ambiguous -> stick
  if (proposed === current) { pending=null; pendingCount=0; }
  else {
    if (proposed === pending) pendingCount++; else { pending=proposed; pendingCount=1; }
    // CHAOS switches instantly (safety); others need hysteresis
    if (proposed === 'CHAOS' || pendingCount >= TH.hysteresis) { current=proposed; pending=null; pendingCount=0; }
  }
  regimes[i]=current;
}

// ---- output ----
const fmt = t => new Date(t).toISOString().replace('T',' ').slice(5,16);
console.log(`\n===== REGIME TIMELINE: ${SYMBOL} ${INTERVAL} =====`);
console.log(`Candles: ${candles.length}   ATR% chaos threshold (p90): ${atrChaosThresh?.toFixed(2)}%\n`);
console.log('TIME           PRICE     ADX   ATR%   REGIME         WHY');
const start = Math.max(0, candles.length - TAIL);
for (let i=start;i<candles.length;i++){
  const rr=raws[i];
  console.log(
    fmt(candles[i].t).padEnd(14)+' '+
    candles[i].c.toFixed(4).padEnd(9)+' '+
    (adx[i]!=null?adx[i].toFixed(0):'-').padEnd(5)+' '+
    (rr?rr.atrPct.toFixed(2):'-').padEnd(6)+' '+
    regimes[i].padEnd(14)+' '+
    (rr?rr.why:'')
  );
}

// summary
const counts={};
for(let i=0;i<candles.length;i++){ if(regimes[i]) counts[regimes[i]]=(counts[regimes[i]]||0)+1; }
const total=candles.length;
console.log('\n--- Regime distribution (full history) ---');
for(const [k,v] of Object.entries(counts).sort((a,b)=>b[1]-a[1]))
  console.log(`  ${k.padEnd(14)} ${v.toString().padStart(5)}  (${(100*v/total).toFixed(1)}%)`);
console.log('\nThresholds:', JSON.stringify(TH));
console.log('Tune these after judging whether the calls match what the chart actually did.\n');

db.close();
