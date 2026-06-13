// Paper Grid Backtest — Adaptive (regime-aware) vs Static
// Replays collected candles and simulates a grid bot two ways:
//   STATIC  = always-on neutral grid (≈ Binance's free default), never stops
//   ADAPTIVE= regime-aware: neutral in RANGING, biased in TREND, FLAT in CHAOS
// Reports net PnL (after fees) for both so you can see if adaptivity wins.
// Read-only simulation. No real orders. Node >= 22.
//
// Usage: SYMBOL=LTCUSDT DB_PATH=./ltc_data.db node backtest.js
'use strict';

const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || './ltc_data.db';
const SYMBOL  = process.env.SYMBOL  || 'LTCUSDT';
const INTERVAL= process.env.INTERVAL|| '15m';

// ---- simulation params (tunable) ----
const CAPITAL      = Number(process.env.CAPITAL || 1000); // USD notional budget for the grid
const GRID_LEVELS  = Number(process.env.LEVELS || 10);    // levels each side
const ATR_SPACING_K= Number(process.env.K || 0.5);        // grid spacing = K * ATR
const TAKER_FEE    = 0.0004;  // 0.04% Binance futures taker
const MAKER_FEE    = 0.0002;  // 0.02% maker (grid limit orders are maker)
const FEE_PER_FILL = MAKER_FEE; // grid orders rest as maker
const SLIPPAGE     = 0.0001;  // small modeled slippage

// regime thresholds (same as regime.js)
const TH = { adxRange:20, adxTrend:25, atrChaosPct:0.90, atrChaosFloor:2.0,
  fundingPanic:0.05, spreadChaosTicks:10, candleShockAtrMult:3, hysteresis:2 };

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const candles = db.prepare(
  `SELECT open_time,open,high,low,close FROM klines WHERE symbol=? AND interval=? ORDER BY open_time ASC`
).all(SYMBOL, INTERVAL).map(r=>({t:r.open_time,o:+r.open,h:+r.high,l:+r.low,c:+r.close}));
const funding = db.prepare(`SELECT ts,funding_rate FROM funding WHERE symbol=? ORDER BY ts ASC`).all(SYMBOL)
  .map(r=>({ts:r.ts,rate:Math.abs(+r.funding_rate)})).filter(x=>!isNaN(x.rate));

if (candles.length < 60) { console.log(`Only ${candles.length} candles — collect more first.`); process.exit(0); }

// ---- indicators (same as regime.js) ----
function atrSeries(c,p=14){const tr=[];for(let i=1;i<c.length;i++)tr.push(Math.max(c[i].h-c[i].l,Math.abs(c[i].h-c[i-1].c),Math.abs(c[i].l-c[i-1].c)));const o=[];let a=tr.slice(0,p).reduce((s,x)=>s+x,0)/p;o[p]=a;for(let i=p+1;i<c.length;i++){a=(a*(p-1)+tr[i-1])/p;o[i]=a;}return o;}
function emaSeries(v,p){const k=2/(p+1);let e=v[0];const o=[e];for(let i=1;i<v.length;i++){e=v[i]*k+e*(1-k);o.push(e);}return o;}
function adxSeries(c,p=14){const out=new Array(c.length).fill(null);if(c.length<p*2)return out;let pDM=[],mDM=[],tr=[];for(let i=1;i<c.length;i++){const up=c[i].h-c[i-1].h,dn=c[i-1].l-c[i].l;pDM.push(up>dn&&up>0?up:0);mDM.push(dn>up&&dn>0?dn:0);tr.push(Math.max(c[i].h-c[i].l,Math.abs(c[i].h-c[i-1].c),Math.abs(c[i].l-c[i-1].c)));}const sm=a=>{let s=a.slice(0,p).reduce((x,y)=>x+y,0);const o=[s];for(let i=p;i<a.length;i++){s=s-s/p+a[i];o.push(s);}return o;};const sP=sm(pDM),sM=sm(mDM),sT=sm(tr),dx=[];for(let i=0;i<sT.length;i++){const pdi=100*sP[i]/sT[i],mdi=100*sM[i]/sT[i];dx.push(100*Math.abs(pdi-mdi)/(pdi+mdi||1));}let a=dx.slice(0,p).reduce((x,y)=>x+y,0)/p;const av=[a];for(let i=p;i<dx.length;i++){a=(a*(p-1)+dx[i])/p;av.push(a);}const startIdx=1+(p-1)+(p-1);for(let i=0;i<av.length;i++){const idx=startIdx+i;if(idx<out.length)out[idx]=av[i];}return out;}
function pctile(arr,q){const s=[...arr].filter(x=>x!=null).sort((a,b)=>a-b);return s.length?s[Math.floor((s.length-1)*q)]:null;}
function nearestBefore(arr,t,f){for(let i=arr.length-1;i>=0;i--)if(arr[i].ts<=t)return arr[i][f];return null;}

const atr=atrSeries(candles,14), ema20=emaSeries(candles.map(c=>c.c),20), ema50=emaSeries(candles.map(c=>c.c),50), adx=adxSeries(candles,14);
const atrPctAll=[];for(let i=0;i<candles.length;i++)if(atr[i]!=null)atrPctAll.push(100*atr[i]/candles[i].c);
const atrChaos=pctile(atrPctAll,TH.atrChaosPct);

function rawRegime(i){
  if(atr[i]==null||adx[i]==null)return null;
  const atrPct=100*atr[i]/candles[i].c;
  const fund=nearestBefore(funding,candles[i].t,'rate'); const fundPct=fund!=null?fund*100:null;
  const range=candles[i].h-candles[i].l;
  if((atrPct>=atrChaos&&atrPct>=TH.atrChaosFloor)||(fundPct!=null&&fundPct>=TH.fundingPanic)||(atr[i]>0&&range>TH.candleShockAtrMult*atr[i])) return 'CHAOS';
  if(adx[i]>=TH.adxTrend) return ema20[i]>=ema50[i]?'TRENDING_UP':'TRENDING_DOWN';
  if(adx[i]<TH.adxRange) return 'RANGING';
  return 'NEUTRAL';
}
// hysteresis
const regimes=new Array(candles.length).fill('RANGING');
let cur='RANGING',pend=null,pc=0;
for(let i=0;i<candles.length;i++){let p=rawRegime(i);if(!p){regimes[i]=cur;continue;}if(p==='NEUTRAL')p=cur;if(p===cur){pend=null;pc=0;}else{if(p===pend)pc++;else{pend=p;pc=1;}if(p==='CHAOS'||pc>=TH.hysteresis){cur=p;pend=null;pc=0;}}regimes[i]=cur;}

// ---- grid simulator ----
// A grid is a set of price levels spaced `spacing` apart, centered on `center`.
// We track which buy levels are "filled" (holding inventory). When price rises one
// spacing above a filled buy, it sells = round-trip profit of (spacing - 2 fees).
// Simplified, candle-based: we count how many grid lines the candle's range crosses.
function simulate(mode){
  let realized=0, fees=0, trades=0, fundingPaid=0;
  let center=candles[0].c, spacing=0, active=false, biased='neutral';
  const notionalPerLevel = CAPITAL / GRID_LEVELS;

  for(let i=14;i<candles.length;i++){
    if(atr[i]==null) continue;
    const reg = regimes[i];
    const price = candles[i].c;

    // --- decide grid state for this mode ---
    if(mode==='static'){ active=true; biased='neutral'; }
    else { // adaptive
      if(reg==='CHAOS'){ active=false; }
      else if(reg==='RANGING'){ active=true; biased='neutral'; }
      else if(reg==='TRENDING_UP'){ active=true; biased='long'; }
      else { active=true; biased='short'; }
    }

    // (re)center grid if far from center or just (re)activated
    spacing = ATR_SPACING_K * atr[i];
    if(spacing<=0){continue;}
    if(!active){ center=price; continue; } // flat: no trades, follow price

    // how many grid lines did this candle traverse? (proxy for fills)
    const span = candles[i].h - candles[i].l;
    let crossings = Math.floor(span / spacing);
    if(crossings<1){ // still may oscillate within; small chance of 1 round trip
      // count a round trip only if intracandle range exceeds one spacing
      crossings = span >= spacing ? 1 : 0;
    }
    // bias adjustment: in trend, the "against trend" side fills less profitably.
    // crude model: neutral captures full crossings; biased captures ~70% (one side favored)
    let effective = crossings;
    if(biased!=='neutral') effective = crossings*0.7;

    if(effective>0){
      // each crossing ≈ one round-trip: profit = spacing per unit notional, minus 2 maker fees + slippage
      const grossPerTrip = (spacing/price); // fractional gain
      const feePerTrip = 2*FEE_PER_FILL + SLIPPAGE;
      const netPerTrip = grossPerTrip - feePerTrip;
      const pnl = effective * netPerTrip * notionalPerLevel;
      realized += pnl;
      fees += effective * feePerTrip * notionalPerLevel;
      trades += effective;
    }

    // funding cost while holding inventory (biased modes hold directional exposure)
    if(biased!=='neutral'){
      const fr = nearestBefore(funding, candles[i].t, 'rate') || 0;
      // pay funding on held notional roughly each candle fraction of 8h
      fundingPaid += fr * notionalPerLevel * (15/ (8*60)); // 15m slice of 8h
    }
    center=price;
  }
  return { mode, realized:+realized.toFixed(2), fees:+fees.toFixed(2),
    fundingPaid:+fundingPaid.toFixed(2), net:+(realized-fundingPaid).toFixed(2), trades:Math.round(trades) };
}

const stat = simulate('static');
const adap = simulate('adaptive');

console.log(`\n===== PAPER GRID BACKTEST: ${SYMBOL} ${INTERVAL} =====`);
console.log(`Candles: ${candles.length}  |  Capital: $${CAPITAL}  |  Levels: ${GRID_LEVELS}  |  Spacing: ${ATR_SPACING_K}xATR`);
console.log(`Fees: maker ${MAKER_FEE*100}% per fill, slippage ${SLIPPAGE*100}%\n`);

const row=(r)=>`${r.mode.padEnd(9)}  net $${String(r.net).padStart(8)}  | gross $${String(r.realized).padStart(8)}  | fees $${String(r.fees).padStart(7)}  | funding $${String(r.fundingPaid).padStart(6)}  | trades ${r.trades}`;
console.log('  '+row(stat));
console.log('  '+row(adap));

const diff = +(adap.net - stat.net).toFixed(2);
const pct = stat.net!==0 ? +(100*diff/Math.abs(stat.net)).toFixed(0) : null;
console.log(`\nAdaptive vs Static: ${diff>=0?'+':''}$${diff}${pct!=null?` (${diff>=0?'+':''}${pct}%)`:''}`);
console.log(`Net return on $${CAPITAL}:  static ${(100*stat.net/CAPITAL).toFixed(2)}%   adaptive ${(100*adap.net/CAPITAL).toFixed(2)}%  (over ${candles.length} candles ≈ ${(candles.length*15/60/24).toFixed(1)} days)`);

console.log('\n⚠ This is a SIMPLIFIED candle-based simulation, not a tick-accurate backtest.');
console.log('It models fills as grid-line crossings per candle and is optimistic about');
console.log('intracandle round-trips. Treat the ADAPTIVE-vs-STATIC *difference* as the');
console.log('signal, not the absolute profit number. Real fills, queue position, and');
console.log('partial fills will reduce both. Validate in paper trading before any live use.\n');

db.close();

