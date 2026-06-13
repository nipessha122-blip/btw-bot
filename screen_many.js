// Multi-Symbol Grid-Suitability Screener
// Pulls recent klines + funding from Binance Futures REST for a list of symbols,
// scores each on grid-suitability, and prints a ranked table.
// No DB needed. Run on a non-geo-blocked host (your Tokyo VPS). Node >= 20.
// Usage: node screen_many.js                (uses default symbol list)
//        SYMBOLS=ETHUSDT,SOLUSDT node screen_many.js   (custom list)
'use strict';

const REST = 'https://fapi.binance.com';
const INTERVAL = process.env.INTERVAL || '15m';
const LIMIT = Number(process.env.LIMIT || 1000); // candles per symbol (max 1500)
const SYMBOLS = (process.env.SYMBOLS ||
  'BTWUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,DOGEUSDT,LTCUSDT'
).split(',').map(s => s.trim().toUpperCase());

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rest(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${REST}${path}${qs ? '?' + qs : ''}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

// ---------- indicators (same logic as single-symbol screener) ----------
function atr(c, p = 14) {
  const trs = [];
  for (let i = 1; i < c.length; i++) trs.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i-1].c), Math.abs(c[i].l - c[i-1].c)));
  const out = []; let a = trs.slice(0, p).reduce((s,x)=>s+x,0)/p; out[p-1]=a;
  for (let i = p; i < trs.length; i++) { a = (a*(p-1)+trs[i])/p; out[i]=a; }
  return out;
}
function adx(c, p = 14) {
  if (c.length < p*2) return [];
  let pDM=[], mDM=[], tr=[];
  for (let i=1;i<c.length;i++){ const up=c[i].h-c[i-1].h, dn=c[i-1].l-c[i].l;
    pDM.push(up>dn&&up>0?up:0); mDM.push(dn>up&&dn>0?dn:0);
    tr.push(Math.max(c[i].h-c[i].l,Math.abs(c[i].h-c[i-1].c),Math.abs(c[i].l-c[i-1].c))); }
  const sm=a=>{let s=a.slice(0,p).reduce((x,y)=>x+y,0);const o=[s];for(let i=p;i<a.length;i++){s=s-s/p+a[i];o.push(s);}return o;};
  const sP=sm(pDM),sM=sm(mDM),sT=sm(tr),dx=[];
  for(let i=0;i<sT.length;i++){const pdi=100*sP[i]/sT[i],mdi=100*sM[i]/sT[i];dx.push(100*Math.abs(pdi-mdi)/(pdi+mdi||1));}
  const out=[];let a=dx.slice(0,p).reduce((x,y)=>x+y,0)/p;out[p-1]=a;
  for(let i=p;i<dx.length;i++){a=(a*(p-1)+dx[i])/p;out[i]=a;}
  return out.filter(x=>x!==undefined);
}
function pct(arr,q){const s=[...arr].sort((a,b)=>a-b);return s[Math.floor((s.length-1)*q)];}

// ---------- per-symbol analysis ----------
async function analyzeSymbol(sym) {
  const raw = await rest('/fapi/v1/klines', { symbol: sym, interval: INTERVAL, limit: LIMIT });
  const c = raw.filter(k => k[6] < Date.now()).map(k => ({ t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4] }));
  if (c.length < 50) throw new Error('insufficient candles');

  // volatility
  const atrArr = atr(c, 14), atrPct = [];
  for (let i=0;i<atrArr.length;i++) if (atrArr[i]!==undefined) atrPct.push(100*atrArr[i]/c[i+1].c);
  const medAtr = pct(atrPct,0.5), stab = pct(atrPct,0.9)/(pct(atrPct,0.1)||1e-9);

  // trend
  const adxArr = adx(c,14);
  const ranging = adxArr.length ? 100*adxArr.filter(x=>x<20).length/adxArr.length : null;

  // range efficiency
  const net = Math.abs(c[c.length-1].c - c[0].c);
  let path=0; for(let i=1;i<c.length;i++) path+=Math.abs(c[i].c-c[i-1].c);
  const eff = net/(path||1e-9);

  // funding (last ~100 settlements)
  let fAvg = null;
  try {
    const fr = await rest('/fapi/v1/fundingRate', { symbol: sym, limit: 100 });
    const rates = fr.map(f=>Math.abs(+f.fundingRate)).filter(x=>!isNaN(x));
    if (rates.length) fAvg = rates.reduce((s,x)=>s+x,0)/rates.length;
  } catch {}

  // spread proxy from book ticker (single snapshot — rough)
  let spreadBps = null;
  try {
    const bt = await rest('/fapi/v1/ticker/bookTicker', { symbol: sym });
    const bid=+bt.bidPrice, ask=+bt.askPrice;
    if (bid&&ask) spreadBps = 10000*(ask-bid)/((ask+bid)/2);
  } catch {}

  return { sym, candles:c.length, medAtr, stab, ranging, eff, fAvg, spreadBps };
}

// ---------- scoring (0-100) ----------
function score(m) {
  let s=0; const n=[];
  // volatility 25
  if (m.medAtr>=0.3 && m.medAtr<=1.5) s+=15; else s+=6;
  if (m.stab<4) s+=10;
  // trend 30 (most important)
  if (m.ranging>=60) s+=30; else if (m.ranging>=45) s+=20; else if (m.ranging>=35) s+=10; else s+=3;
  // liquidity/spread 25
  if (m.spreadBps!=null){ if(m.spreadBps<=2)s+=25; else if(m.spreadBps<=5)s+=18; else if(m.spreadBps<=15)s+=8; else s+=2; }
  // funding 10
  if (m.fAvg!=null){ const f=m.fAvg*100; if(f<0.01)s+=10; else if(f<0.05)s+=5; }
  // range efficiency 10
  if (m.eff<0.1) s+=10; else if(m.eff<0.3) s+=6; else s+=1;
  return Math.round(s);
}

// ---------- run ----------
(async () => {
  console.log(`\nScreening ${SYMBOLS.length} symbols on ${INTERVAL} (${LIMIT} candles each)...\n`);
  const results = [];
  for (const sym of SYMBOLS) {
    try {
      const m = await analyzeSymbol(sym);
      m.score = score(m);
      results.push(m);
      process.stdout.write(`  ${sym} done (${m.score})\n`);
    } catch (e) {
      process.stdout.write(`  ${sym} skipped: ${e.message}\n`);
    }
    await sleep(250); // rate-limit politeness
  }

  results.sort((a,b)=>b.score-a.score);
  console.log('\n===== RANKED GRID-SUITABILITY =====');
  console.log('RANK SYMBOL      SCORE  ATR%  RANGE%  SPREAD(bps)  FUND%/8h  CHOP');
  results.forEach((m,i)=>{
    const pad=(v,w)=>String(v).padEnd(w);
    console.log(
      pad(i+1,4)+ ' ' +
      pad(m.sym,11)+ ' ' +
      pad(m.score,6)+ ' ' +
      pad(m.medAtr?.toFixed(2),5)+ ' ' +
      pad(m.ranging?.toFixed(0),6)+ '  ' +
      pad(m.spreadBps?.toFixed(1)??'?',11)+ '  ' +
      pad(m.fAvg!=null?(m.fAvg*100).toFixed(4):'?',8)+ '  ' +
      (m.eff?.toFixed(3))
    );
  });
  console.log('\nHigher score = more grid-friendly. ATR%=volatility per candle,');
  console.log('RANGE%=time spent ranging (higher better), SPREAD=tightness (lower better),');
  console.log('FUND=funding cost (lower better), CHOP=efficiency (lower=choppier=better).');
  console.log('\nThis is a screen, not advice. Spread is a single snapshot (rough).\n');
})();
