const assert = require('node:assert/strict');
const { create } = require('../js/pda-autopilot.js');
function harness() {
  const data = new Map();
  const storage = { getItem: k => data.get(k) || null, setItem: (k,v) => data.set(k,v) };
  const bars = [];
  for (let i=0;i<100;i++) { const close=100+i*0.02; bars.push({time:1700000000+i*900,open:close-0.01,high:close+0.2,low:close-0.2,close}); }
  const feed = { source:'Kraken',status:'live',demo:false,quote:()=>({bid:102,ask:102.01}),age:()=>1,candleAge:()=>1,candles:()=>bars,on:()=>{} };
  return {storage,feed,bars};
}
const h=harness(), engine=create({feed:h.feed,storage:h.storage,clock:()=>1700000000000});
assert.equal(engine.snapshot().config.enabled,false);
engine.configure({capital:1000,riskPct:0.25,dailyLossPct:1,symbol:'BTC/USD'});
engine.setEnabled(true);
engine.tick();
assert.equal(engine.snapshot().open,null,'monotonic data must not invent a crossover');
assert.throws(()=>engine.configure({riskPct:1}),/0.5%/);
engine.setEnabled(false);
assert.equal(engine.snapshot().config.enabled,false);
const blocked=harness(); blocked.feed.demo=true;
const guarded=create({feed:blocked.feed,storage:blocked.storage,clock:()=>1700000000000});
guarded.configure({symbol:'BTC/USD'}); guarded.setEnabled(true); guarded.tick();
assert.equal(guarded.snapshot().open,null,'demo feed must never open a position');
assert.equal(guarded.snapshot().config.enabled,true,'feed guard pauses entries but preserves explicit enabled state');
console.log('PDA autonomous paper engine: all tests passed');
