// Paper Grid Backtest v3 — TWO-SIDED adaptive grid
// Adaptive now trades BOTH directions based on regime:
//   RANGING       -> neutral grid (buy dips / sell rips), long inventory
//   TRENDING_UP   -> long-biased (buy dips, ride up)
//   TRENDING_DOWN -> SHORT grid (sell rallies / cover dips), profits from decline
//   CHAOS         -> flat (close all, no new orders)
// Static baseline = long-only neutral grid, never stops (≈ Binance default).
//
// Tracks long lots (+qty) and short lots (-qty) separately, marks both to market.
// True PnL = realized + unrealized - fees - funding.  Read-only. Node >= 22.
//
// Usage: SYMBOL=LTCUSDT DB_PATH=./ltc_data.db node backtest3.js
'use strict';
const { DatabaseSync } = require('node:sqlite');

const DB_PATH=process.env.DB_PATH||'./ltc_data.db', SYMBOL=process.env.SYMBOL||'LTCUSDT', INTERVAL=process.env.INTERVAL||'15m';
const CAPITAL=Number(process.env.CAPITAL||1000), GRID_LEVELS=Number(process.env.LEVELS||10), ATR_SPACING_K=Number(process.env.K||0.5);
const FEE=0.0002+0.0001; // maker + slippage per fill
const TH={adxRange:20,adxTrend:25,atrChaosPct:0.90,atrChaosFloor:2.0,fundingPanic:0.05,spreadChaosTicks:10,candleShockAtrMult:3,hysteresis:2};

const db=new DatabaseSync(DB_PATH,{readOnly:true});
const candles=db.prepare(`SELECT open_time,open,high,low,close FROM klines WHERE symbol=? AND interval=? ORDER BY open_time ASC`).all(SYMBOL,INTERVAL).map(r=>({t:r.open_time,o:+r.open,h:+r.high,l:+r.low,c:+r.close}));
const funding=db.prepare(`SELECT ts,funding_rate FROM funding WHERE symbol=? ORDER BY ts ASC`).all(SYMBOL).map(r=>({ts:r.ts,rate:+r.funding_rate})).filter(x=>!isNaN(x.rate));
if(candles.length<60){console.log(`Only ${candles.length} candles.`);process.exit(0);}

function atrSeries(c,p=14){const tr=[];for(let i=1;i<c.length;i++)tr.push(Math.max(c[i].h-c[i].l,Math.abs(c[i].h-c[i-1].c),Math.abs(c[i].l-c[i-1].c)));const o=[];let a=tr.slice(0,p).reduce((s,x)=>s+x,0)/p;o[p]=a;for(let i=p+1;i<c.length;i++){a=(a*(p-1)+tr[i-1])/p;o[i]=a;}return o;}
function emaSeries(v,p){const k=2/(p+1);let e=v[0];const o=[e];for(let i=1;i<v.length;i++){e=v[i]*k+e*(1-k);o.push(e);}return o;}
function adxSeries(c,p=14){const out=new Array(c.length).fill(null);if(c.length<p*2)return out;let pDM=[],mDM=[],tr=[];for(let i=1;i<c.length;i++){const up=c[i].h-c[i-1].h,dn=c[i-1].l-c[i].l;pDM.push(up>dn&&up>0?up:0);mDM.push(dn>up&&dn>0?dn:0);tr.push(Math.max(c[i].h-c[i].l,Math.abs(c[i].h-c[i-1].c),Math.abs(c[i].l-c[i-1].c)));}const sm=a=>{let s=a.slice(0,p).reduce((x,y)=>x+y,0);const o=[s];for(let i=p;i<a.length;i++){s=s-s/p+a[i];o.push(s);}return o;};const sP=sm(pDM),sM=sm(mDM),sT=sm(tr),dx=[];for(let i=0;i<sT.length;i++){const pdi=100*sP[i]/sT[i],mdi=100*sM[i]/sT[i];dx.push(100*Math.abs(pdi-mdi)/(pdi+mdi||1));}let a=dx.slice(0,p).reduce((x,y)=>x+y,0)/p;const av=[a];for(let i=p;i<dx.length;i++){a=(a*(p-1)+dx[i])/p;av.push(a);}const si=1+(p-1)+(p-1);for(let i=0;i<av.length;i++){const idx=si+i;if(idx<out.length)out[idx]=av[i];}return out;}
function pctile(a,q){const s=[...a].filter(x=>x!=null).sort((x,y)=>x-y);return s.length?s[Math.floor((s.length-1)*q)]:null;}
function nearestBefore(arr,t,f){for(let i=arr.length-1;i>=0;i--)if(arr[i].ts<=t)return arr[i][f];return null;}

const atr=atrSeries(candles,14),ema20=emaSeries(candles.map(c=>c.c),20),ema50=emaSeries(candles.map(c=>c.c),50),adx=adxSeries(candles,14);
const atrPctAll=[];for(let i=0;i<candles.length;i++)if(atr[i]!=null)atrPctAll.push(100*atr[i]/candles[i].c);
const atrChaos=pctile(atrPctAll,TH.atrChaosPct);
function rawRegime(i){if(atr[i]==null||adx[i]==null)return null;const ap=100*atr[i]/candles[i].c;const f=nearestBefore(funding,candles[i].t,'rate');const fp=f!=null?Math.abs(f)*100:null;const rg=candles[i].h-candles[i].l;if((ap>=atrChaos&&ap>=TH.atrChaosFloor)||(fp!=null&&fp>=TH.fundingPanic)||(atr[i]>0&&rg>TH.candleShockAtrMult*atr[i]))return'CHAOS';if(adx[i]>=TH.adxTrend)return ema20[i]>=ema50[i]?'TRENDING_UP':'TRENDING_DOWN';if(adx[i]<TH.adxRange)return'RANGING';return'NEUTRAL';}
const regimes=new Array(candles.length).fill('RANGING');
{let cur='RANGING',pend=null,pc=0;for(let i=0;i<candles.length;i++){let p=rawRegime(i);if(!p){regimes[i]=cur;continue;}if(p==='NEUTRAL')p=cur;if(p===cur){pend=null;pc=0;}else{if(p===pend)pc++;else{pend=p;pc=1;}if(p==='CHAOS'||pc>=TH.hysteresis){cur=p;pend=null;pc=0;}}regimes[i]=cur;}}

// ---- simulator: longs (+) and shorts (-) ----
function simulate(mode){
  let realized=0,fees=0,fundingPaid=0,fills=0;
  let longs=[], shorts=[];           // {price,qty}
  const qtyPerLevel=(CAPITAL/GRID_LEVELS)/candles[14].c;
  let lastPrice=candles[14].c;

  for(let i=14;i<candles.length;i++){
    if(atr[i]==null) continue;
    const reg=regimes[i], spacing=ATR_SPACING_K*atr[i];
    if(spacing<=0) continue;
    const hi=candles[i].h, lo=candles[i].l, close=candles[i].c;

    // determine side behavior
    let mode_buy=true, mode_sellRip=true, mode_openShort=false, flat=false;
    if(mode==='static'){ mode_buy=true; mode_sellRip=true; mode_openShort=false; }
    else { // adaptive two-sided
      if(reg==='CHAOS'){ flat=true; }
      else if(reg==='RANGING'){ mode_buy=true; mode_sellRip=true; mode_openShort=false; }
      else if(reg==='TRENDING_UP'){ mode_buy=true; mode_sellRip=true; mode_openShort=false; }
      else if(reg==='TRENDING_DOWN'){ mode_buy=false; mode_sellRip=false; mode_openShort=true; }
    }

    if(flat){
      // close everything at close price
      for(const l of longs){ realized+=(close-l.price)*l.qty; fees+=FEE*l.qty*close; fills++; }
      for(const s of shorts){ realized+=(s.price-close)*s.qty; fees+=FEE*s.qty*close; fills++; }
      longs=[]; shorts=[]; lastPrice=close; continue;
    }

    if(close<lastPrice){ // price down
      const steps=Math.floor((lastPrice-lo)/spacing);
      for(let s=1;s<=steps;s++){
        const px=lastPrice-s*spacing;
        if(mode_buy){ longs.push({price:px,qty:qtyPerLevel}); fees+=FEE*qtyPerLevel*px; fills++; }
        // cover shorts on dips (buy back lower = profit)
        if(shorts.length){
          let idx=-1,best=-Infinity;
          for(let k=0;k<shorts.length;k++){ if(shorts[k].price>px && shorts[k].price>best){best=shorts[k].price;idx=k;} }
          if(idx>=0){ const lot=shorts[idx]; realized+=(lot.price-px)*lot.qty; fees+=FEE*lot.qty*px; fills++; shorts.splice(idx,1); }
        }
      }
    } else if(close>lastPrice){ // price up
      const steps=Math.floor((hi-lastPrice)/spacing);
      for(let s=1;s<=steps;s++){
        const px=lastPrice+s*spacing;
        // sell longs on rips (profit)
        if(mode_sellRip && longs.length){
          let idx=-1,best=Infinity;
          for(let k=0;k<longs.length;k++){ if(longs[k].price<px && longs[k].price<best){best=longs[k].price;idx=k;} }
          if(idx>=0){ const lot=longs[idx]; realized+=(px-lot.price)*lot.qty; fees+=FEE*lot.qty*px; fills++; longs.splice(idx,1); }
        }
        // open shorts on rallies (in downtrend)
        if(mode_openShort){ shorts.push({price:px,qty:qtyPerLevel}); fees+=FEE*qtyPerLevel*px; fills++; }
      }
    }

    // funding: longs pay when rate>0, shorts receive when rate>0 (and vice versa)
    const fr=nearestBefore(funding,candles[i].t,'rate')||0;
    const longNot=longs.reduce((s,l)=>s+l.price*l.qty,0);
    const shortNot=shorts.reduce((s,l)=>s+l.price*l.qty,0);
    fundingPaid += fr*longNot*(15/(8*60));      // longs pay positive funding
    fundingPaid -= fr*shortNot*(15/(8*60));     // shorts receive it
    lastPrice=close;
  }

  const fp=candles[candles.length-1].c;
  let unreal=0;
  for(const l of longs) unreal+=(fp-l.price)*l.qty;
  for(const s of shorts) unreal+=(s.price-fp)*s.qty;
  const net=realized+unreal-fees-fundingPaid;
  return {mode,realized:+realized.toFixed(2),unreal:+unreal.toFixed(2),fees:+fees.toFixed(2),funding:+fundingPaid.toFixed(2),net:+net.toFixed(2),fills,longLots:longs.length,shortLots:shorts.length};
}

const stat=simulate('static'), adap=simulate('adaptive');
console.log(`\n===== TWO-SIDED ADAPTIVE BACKTEST: ${SYMBOL} ${INTERVAL} =====`);
console.log(`Candles ${candles.length} (~${(candles.length*15/60/24).toFixed(1)}d) | Capital $${CAPITAL} | Levels ${GRID_LEVELS} | Spacing ${ATR_SPACING_K}xATR | Fee ${(FEE*100).toFixed(3)}%\n`);
const row=r=>`${r.mode.padEnd(9)} net $${String(r.net).padStart(9)} = real $${String(r.realized).padStart(8)} + unreal $${String(r.unreal).padStart(9)} - fees $${String(r.fees).padStart(6)} - fund $${String(r.funding).padStart(7)} | fills ${r.fills}, long ${r.longLots}/short ${r.shortLots}`;
console.log('  '+row(stat));
console.log('  '+row(adap));
const diff=+(adap.net-stat.net).toFixed(2);
console.log(`\nAdaptive vs Static: ${diff>=0?'+':''}$${diff}`);
console.log(`Net return on $${CAPITAL}:  static ${(100*stat.net/CAPITAL).toFixed(2)}%   adaptive ${(100*adap.net/CAPITAL).toFixed(2)}%`);
console.log(`\nNow adaptive SHORTS in downtrends (profits from decline) instead of just`);
console.log(`defending. Watch whether adaptive's net goes positive while static stays`);
console.log(`underwater — that's the two-sided edge.\n`);
console.log('Still candle-level FIFO simulation. Validate in live paper trading.\n');
db.close();

