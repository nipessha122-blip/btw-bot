// Paper Grid Backtest v2 — HONEST inventory model
// Simulates real grid mechanics: buy orders below price, sell orders above.
// Tracks actual inventory (lots held) and marks unsold inventory to market at
// the end. This captures the REAL risk a static grid faces: in a downtrend it
// keeps buying as price falls, accumulating losing inventory it can't sell.
//
// STATIC  = always-on neutral grid (≈ Binance default), never stops.
// ADAPTIVE= regime-aware: neutral in RANGING, biased in TREND, FLAT in CHAOS
//           (flat = stop opening new buys; still sell existing inventory).
//
// True PnL = realized round-trip profit + unrealized (mark-to-market) - fees - funding
// Read-only. No real orders. Node >= 22.
//
// Usage: SYMBOL=LTCUSDT DB_PATH=./ltc_data.db node backtest2.js
'use strict';

const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || './ltc_data.db';
const SYMBOL  = process.env.SYMBOL  || 'LTCUSDT';
const INTERVAL= process.env.INTERVAL|| '15m';

const CAPITAL     = Number(process.env.CAPITAL || 1000);
const GRID_LEVELS = Number(process.env.LEVELS || 10);   // levels each side of center
const ATR_SPACING_K = Number(process.env.K || 0.5);
const MAKER_FEE   = 0.0002;
const SLIPPAGE    = 0.0001;
const FEE = MAKER_FEE + SLIPPAGE; // per fill

const TH = { adxRange:20, adxTrend:25, atrChaosPct:0.90, atrChaosFloor:2.0,
  fundingPanic:0.05, spreadChaosTicks:10, candleShockAtrMult:3, hysteresis:2 };

const db = new DatabaseSync(DB_PATH, { readOnly:true });
const candles = db.prepare(`SELECT open_time,open,high,low,close FROM klines WHERE symbol=? AND interval=? ORDER BY open_time ASC`)
  .all(SYMBOL,INTERVAL).map(r=>({t:r.open_time,o:+r.open,h:+r.high,l:+r.low,c:+r.close}));
const funding = db.prepare(`SELECT ts,funding_rate FROM funding WHERE symbol=? ORDER BY ts ASC`).all(SYMBOL)
  .map(r=>({ts:r.ts,rate:+r.funding_rate})).filter(x=>!isNaN(x.rate));
if(candles.length<60){console.log(`Only ${candles.length} candles — collect more.`);process.exit(0);}

// indicators
function atrSeries(c,p=14){const tr=[];for(let i=1;i<c.length;i++)tr.push(Math.max(c[i].h-c[i].l,Math.abs(c[i].h-c[i-1].c),Math.abs(c[i].l-c[i-1].c)));const o=[];let a=tr.slice(0,p).reduce((s,x)=>s+x,0)/p;o[p]=a;for(let i=p+1;i<c.length;i++){a=(a*(p-1)+tr[i-1])/p;o[i]=a;}return o;}
function emaSeries(v,p){const k=2/(p+1);let e=v[0];const o=[e];for(let i=1;i<v.length;i++){e=v[i]*k+e*(1-k);o.push(e);}return o;}
function adxSeries(c,p=14){const out=new Array(c.length).fill(null);if(c.length<p*2)return out;let pDM=[],mDM=[],tr=[];for(let i=1;i<c.length;i++){const up=c[i].h-c[i-1].h,dn=c[i-1].l-c[i].l;pDM.push(up>dn&&up>0?up:0);mDM.push(dn>up&&dn>0?dn:0);tr.push(Math.max(c[i].h-c[i].l,Math.abs(c[i].h-c[i-1].c),Math.abs(c[i].l-c[i-1].c)));}const sm=a=>{let s=a.slice(0,p).reduce((x,y)=>x+y,0);const o=[s];for(let i=p;i<a.length;i++){s=s-s/p+a[i];o.push(s);}return o;};const sP=sm(pDM),sM=sm(mDM),sT=sm(tr),dx=[];for(let i=0;i<sT.length;i++){const pdi=100*sP[i]/sT[i],mdi=100*sM[i]/sT[i];dx.push(100*Math.abs(pdi-mdi)/(pdi+mdi||1));}let a=dx.slice(0,p).reduce((x,y)=>x+y,0)/p;const av=[a];for(let i=p;i<dx.length;i++){a=(a*(p-1)+dx[i])/p;av.push(a);}const startIdx=1+(p-1)+(p-1);for(let i=0;i<av.length;i++){const idx=startIdx+i;if(idx<out.length)out[idx]=av[i];}return out;}
function pctile(a,q){const s=[...a].filter(x=>x!=null).sort((x,y)=>x-y);return s.length?s[Math.floor((s.length-1)*q)]:null;}
function nearestBefore(arr,t,f){for(let i=arr.length-1;i>=0;i--)if(arr[i].ts<=t)return arr[i][f];return null;}

const atr=atrSeries(candles,14),ema20=emaSeries(candles.map(c=>c.c),20),ema50=emaSeries(candles.map(c=>c.c),50),adx=adxSeries(candles,14);
const atrPctAll=[];for(let i=0;i<candles.length;i++)if(atr[i]!=null)atrPctAll.push(100*atr[i]/candles[i].c);
const atrChaos=pctile(atrPctAll,TH.atrChaosPct);

function rawRegime(i){if(atr[i]==null||adx[i]==null)return null;const atrPct=100*atr[i]/candles[i].c;const fund=nearestBefore(funding,candles[i].t,'rate');const fundPct=fund!=null?Math.abs(fund)*100:null;const range=candles[i].h-candles[i].l;if((atrPct>=atrChaos&&atrPct>=TH.atrChaosFloor)||(fundPct!=null&&fundPct>=TH.fundingPanic)||(atr[i]>0&&range>TH.candleShockAtrMult*atr[i]))return'CHAOS';if(adx[i]>=TH.adxTrend)return ema20[i]>=ema50[i]?'TRENDING_UP':'TRENDING_DOWN';if(adx[i]<TH.adxRange)return'RANGING';return'NEUTRAL';}
const regimes=new Array(candles.length).fill('RANGING');
{let cur='RANGING',pend=null,pc=0;for(let i=0;i<candles.length;i++){let p=rawRegime(i);if(!p){regimes[i]=cur;continue;}if(p==='NEUTRAL')p=cur;if(p===cur){pend=null;pc=0;}else{if(p===pend)pc++;else{pend=p;pc=1;}if(p==='CHAOS'||pc>=TH.hysteresis){cur=p;pend=null;pc=0;}}regimes[i]=cur;}}

// ---- honest grid simulator with inventory ----
function simulate(mode){
  let realized=0, fees=0, fundingPaid=0, fills=0;
  let inventory=[];           // array of {price, qty} lots bought, not yet sold
  let center=candles[14].c;   // grid center
  const qtyPerLevel = (CAPITAL/GRID_LEVELS)/center; // base units per grid order
  let lastPrice=center;

  for(let i=14;i<candles.length;i++){
    if(atr[i]==null) continue;
    const reg=regimes[i];
    const spacing=ATR_SPACING_K*atr[i];
    if(spacing<=0) continue;
    const hi=candles[i].h, lo=candles[i].l, close=candles[i].c;

    // decide behavior
    let allowBuy=true, allowSell=true;
    if(mode==='adaptive'){
      if(reg==='CHAOS'){ allowBuy=false; allowSell=true; }          // stop buying, let sells clear
      else if(reg==='TRENDING_DOWN'){ allowBuy=false; allowSell=true; } // don't catch falling knife
      else if(reg==='TRENDING_UP'){ allowBuy=true; allowSell=true; }    // ride up
      else { allowBuy=true; allowSell=true; }                          // ranging neutral
    }

    // recenter grid toward price gradually (grids re-anchor)
    // Simulate fills by walking price from lastPrice across the candle.
    // Approximate: if price fell, buys triggered at levels between; if rose, sells.
    if(close<lastPrice){
      // price moved down: buy levels triggered
      if(allowBuy){
        const steps=Math.floor((lastPrice-lo)/spacing);
        for(let s=1;s<=steps;s++){
          const buyPrice=lastPrice-s*spacing;
          inventory.push({price:buyPrice, qty:qtyPerLevel});
          realized -= 0; // buy itself isn't profit; cost tracked in inventory
          fees += FEE*qtyPerLevel*buyPrice;
          fills++;
        }
      }
    } else if(close>lastPrice){
      // price moved up: sell levels triggered — sell oldest cheapest inventory (FIFO of profitable lots)
      if(allowSell){
        const steps=Math.floor((hi-lastPrice)/spacing);
        for(let s=1;s<=steps && inventory.length>0;s++){
          const sellPrice=lastPrice+s*spacing;
          // sell a lot bought below sellPrice for profit
          // find cheapest lot under sellPrice
          let idx=-1, best=Infinity;
          for(let k=0;k<inventory.length;k++){ if(inventory[k].price<sellPrice && inventory[k].price<best){best=inventory[k].price;idx=k;} }
          if(idx>=0){
            const lot=inventory[idx];
            realized += (sellPrice-lot.price)*lot.qty;
            fees += FEE*lot.qty*sellPrice;
            fills++;
            inventory.splice(idx,1);
          }
        }
      }
    }

    // funding on held inventory (long exposure pays funding when rate positive)
    const fr=nearestBefore(funding,candles[i].t,'rate')||0;
    const heldNotional=inventory.reduce((s,l)=>s+l.price*l.qty,0);
    fundingPaid += fr*heldNotional*(15/(8*60));

    lastPrice=close;
  }

  // mark remaining inventory to final price (unrealized)
  const finalPrice=candles[candles.length-1].c;
  let unreal=0, heldUnits=0;
  for(const lot of inventory){ unreal += (finalPrice-lot.price)*lot.qty; heldUnits+=lot.qty; }

  const net = realized + unreal - fees - fundingPaid;
  return { mode, realized:+realized.toFixed(2), unreal:+unreal.toFixed(2),
    fees:+fees.toFixed(2), funding:+fundingPaid.toFixed(2), net:+net.toFixed(2),
    fills, heldLots:inventory.length, heldValue:+(heldUnits*finalPrice).toFixed(2) };
}

const stat=simulate('static');
const adap=simulate('adaptive');

console.log(`\n===== HONEST GRID BACKTEST (with inventory): ${SYMBOL} ${INTERVAL} =====`);
console.log(`Candles: ${candles.length} (~${(candles.length*15/60/24).toFixed(1)} days) | Capital $${CAPITAL} | Levels ${GRID_LEVELS} | Spacing ${ATR_SPACING_K}xATR | Fee ${(FEE*100).toFixed(3)}%/fill\n`);

const row=r=>`${r.mode.padEnd(9)} net $${String(r.net).padStart(9)} = realized $${String(r.realized).padStart(8)} + unrealized $${String(r.unreal).padStart(9)} - fees $${String(r.fees).padStart(6)} - fund $${String(r.funding).padStart(6)}  | fills ${r.fills}, trapped lots ${r.heldLots}`;
console.log('  '+row(stat));
console.log('  '+row(adap));

const diff=+(adap.net-stat.net).toFixed(2);
console.log(`\nAdaptive vs Static: ${diff>=0?'+':''}$${diff}`);
console.log(`Net return on $${CAPITAL}:  static ${(100*stat.net/CAPITAL).toFixed(2)}%   adaptive ${(100*adap.net/CAPITAL).toFixed(2)}%`);
console.log(`\nKey insight: 'unrealized' is mark-to-market of inventory the grid is still`);
console.log(`holding at the end. Large negative unrealized = grid got TRAPPED buying into`);
console.log(`a decline. This is the risk the previous model ignored.\n`);
console.log('Still simplified (candle-level, FIFO fills), but now models the real trap.');
console.log('Validate in live paper trading before trusting for real money.\n');

db.close();

