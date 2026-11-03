/* Prop Desk Research Model v0.4 — one file, no dependencies, no orders.
 * Experimental measurements, not validated trading guidance. See handoff.
 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PropDeskResearch=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const VERSION='0.4.0-experimental';
const DEFAULTS={atrPeriod:14,internalLeft:2,internalRight:2,majorLeft:5,majorRight:5,equalAtr:.1,breakAtr:.1,tickSize:0,rangeLookback:20,rangeEfficiency:.3,rangeMinTests:2,dojiRatio:.1,smallRatio:.3,longRatio:.6,shadowRatio:2,trendBars:5,trendEfficiency:.4,gapMode:'strict',zoneTicks:2,stopTicks:1,expiryBars:8,mergeDistanceBps:10};
const finite=Number.isFinite;
function positive(v,k){if(!finite(v)||v<=0)throw Error('Invalid '+k);}
function configuration(raw={}){const c={...DEFAULTS,...raw};
 for(const k of ['atrPeriod','internalLeft','internalRight','majorLeft','majorRight','rangeLookback','rangeMinTests','trendBars','expiryBars'])if(!Number.isInteger(c[k])||c[k]<1)throw Error('Invalid '+k);
 for(const k of ['equalAtr','breakAtr','tickSize','shadowRatio','zoneTicks','stopTicks','mergeDistanceBps'])if(!finite(c[k])||c[k]<0)throw Error('Invalid '+k);
 for(const k of ['dojiRatio','smallRatio','longRatio','rangeEfficiency','trendEfficiency'])if(!finite(c[k])||c[k]<0||c[k]>1)throw Error('Invalid '+k);
 if(!(c.dojiRatio<c.smallRatio&&c.smallRatio<c.longRatio)||c.trendBars<2||!['strict','relaxed'].includes(c.gapMode))throw Error('Invalid thresholds');return c;
}
function candle(x,closed){if(!x||x.closed!==closed)throw Error('Incorrect candle closure flag');for(const k of ['time','open','high','low','close'])if(!finite(x[k]))throw Error('Invalid '+k);
 if(x.low<=0||x.high<x.low||x.high<Math.max(x.open,x.close)||x.low>Math.min(x.open,x.close))throw Error('Invalid OHLC');
 const range=x.high-x.low,body=Math.abs(x.close-x.open);return {...x,range,body,ratio:range?body/range:0,top:Math.max(x.open,x.close),bottom:Math.min(x.open,x.close),upper:x.high-Math.max(x.open,x.close),lower:Math.min(x.open,x.close)-x.low,bull:x.close>x.open,bear:x.close<x.open};
}
function efficiency(b,n){if(b.length<=n)return null;const end=b.length-1,start=end-n;let path=0;for(let j=start+1;j<=end;j++)path+=Math.abs(b[j].close-b[j-1].close);return path?Math.abs(b[end].close-b[start].close)/path:0;}
function atrSeries(b,n){let sum=0,last=null;return b.map((x,i)=>{const tr=i?Math.max(x.range,Math.abs(x.high-b[i-1].close),Math.abs(x.low-b[i-1].close)):x.range;if(i<n){sum+=tr;if(i===n-1)last=sum/n;}else last=(last*(n-1)+tr)/n;return last;});}
function trend(b,start,c){if(start<c.trendBars)return 'unknown';const s=b.slice(start-c.trendBars,start),e=efficiency(s,s.length-1),net=s.at(-1).close-s[0].close;return e>=c.trendEfficiency&&net!==0?(net>0?'up':'down'):'sideways';}
function registry(c){const list=[],small=x=>x.range>0&&x.ratio<=c.smallRatio,long=x=>x.range>0&&x.ratio>=c.longRatio,doji=x=>x.range>0&&x.ratio<=c.dojiRatio;
 const add=(name,n,bias,context,test,seed=null,middle=null,variant='standard')=>list.push({name,n,bias,context,test,seed,middle,variant});
 add('zero_range',1,'neutral',false,([x])=>x.range===0);
 add('doji',1,'neutral',false,([x])=>doji(x));
 add('dragonfly_doji',1,'neutral',false,([x])=>doji(x)&&x.upper<=x.range*.1&&x.lower>=x.range*.6);
 add('gravestone_doji',1,'neutral',false,([x])=>doji(x)&&x.lower<=x.range*.1&&x.upper>=x.range*.6);
 add('long_legged_doji',1,'neutral',false,([x])=>doji(x)&&x.upper>=x.range*.3&&x.lower>=x.range*.3);
 add('spinning_top',1,'neutral',false,([x])=>small(x)&&!doji(x)&&x.upper>=x.body&&x.lower>=x.body);
 for(const bull of [true,false]){const prefix=bull?'bullish':'bearish',bias=bull?'bullish':'bearish',color=x=>bull?x.bull:x.bear;
  add(prefix+'_marubozu',1,bias,false,([x])=>color(x)&&x.ratio>=.9&&x.upper<=x.range*.05&&x.lower<=x.range*.05);
  add(prefix+'_engulfing',2,bias,true,([a,b])=>(bull?a.bear&&b.bull:a.bull&&b.bear)&&b.bottom<=a.bottom&&b.top>=a.top&&b.body>a.body,a=>bull?a.bear:a.bull);
  add(prefix+'_harami',2,bias,true,([a,b])=>long(a)&&small(b)&&!doji(b)&&(bull?a.bear&&b.bull:a.bull&&b.bear)&&b.bottom>a.bottom&&b.top<a.top);
  add(prefix+'_harami_cross',2,bias,true,([a,b])=>long(a)&&doji(b)&&(bull?a.bear:a.bull)&&b.bottom>a.bottom&&b.top<a.top);
  add(bull?'tweezer_bottom':'tweezer_top',2,bias,true,([a,b])=>(bull?a.bear&&b.bull:a.bull&&b.bear)&&Math.abs(bull?a.low-b.low:a.high-b.high)<=c.tickSize);
  add(bull?'piercing_line':'dark_cloud_cover',2,bias,true,([a,b])=>long(a)&&(bull?a.bear&&b.bull:a.bull&&b.bear)&&(bull?(c.gapMode==='strict'?b.open<a.low:b.open<=a.close+c.tickSize):(c.gapMode==='strict'?b.open>a.high:b.open>=a.close-c.tickSize))&&(bull?b.close>(a.open+a.close)/2&&b.close<a.open:b.close<(a.open+a.close)/2&&b.close>a.open),null,null,c.gapMode);
  const mid=(a,b)=>small(b)&&(c.gapMode==='relaxed'||(bull?b.top<a.bottom:b.bottom>a.top));
  const star=([a,b,d])=>long(a)&&(bull?a.bear:a.bull)&&mid(a,b)&&long(d)&&(bull?d.bull&&d.close>(a.open+a.close)/2:d.bear&&d.close<(a.open+a.close)/2)&&(c.gapMode==='relaxed'||(bull?d.bottom>b.top:d.top<b.bottom));
  add(bull?'morning_star':'evening_star',3,bias,true,star,a=>long(a)&&(bull?a.bear:a.bull),mid,c.gapMode);
  add(bull?'morning_doji_star':'evening_doji_star',3,bias,true,s=>star(s)&&doji(s[1]),null,null,c.gapMode);
  add(prefix+'_abandoned_baby',3,bias,true,([a,b,d])=>long(a)&&doji(b)&&(bull?a.bear&&b.high<a.low&&d.bull&&d.low>b.high&&d.close>(a.open+a.close)/2:a.bull&&b.low>a.high&&d.bear&&d.high<b.low&&d.close<(a.open+a.close)/2));
  add(bull?'three_white_soldiers':'three_black_crows',3,bias,true,([a,b,d])=>[a,b,d].every(x=>long(x)&&color(x)&&(bull?x.upper:x.lower)<=x.range*.2)&&[[a,b],[b,d]].every(([u,v])=>v.open>=u.bottom&&v.open<=u.top&&(bull?v.close>u.close:v.close<u.close)));
  add(bull?'rising_three_methods':'falling_three_methods',5,bias,false,s=>long(s[0])&&color(s[0])&&long(s[4])&&color(s[4])&&s.slice(1,4).every(x=>small(x)&&x.high<=s[0].high&&x.low>=s[0].low)&&(bull?s[4].close>s[0].high:s[4].close<s[0].low));
 }
 const lower=x=>!doji(x)&&small(x)&&x.lower>=c.shadowRatio*x.body&&x.upper<=x.body*.5,upper=x=>!doji(x)&&small(x)&&x.upper>=c.shadowRatio*x.body&&x.lower<=x.body*.5;
 add('hammer',1,'bullish',true,([x])=>lower(x));add('hanging_man',1,'bearish',true,([x])=>lower(x));add('inverted_hammer',1,'bullish',true,([x])=>upper(x));add('shooting_star',1,'bearish',true,([x])=>upper(x));
 add('inside_bar',2,'neutral',false,([a,b])=>b.high<a.high&&b.low>a.low);add('outside_bar',2,'neutral',false,([a,b])=>b.high>a.high&&b.low<a.low);return list;
}
function patterns(b,live,c,emit,id,now){const defs=registry(c),observations=[],candidates=[],previews=[];
 const context=(d,start)=>{const t=trend(b,start,c),match=!d.context||t===(d.bias==='bullish'?'down':'up');return {priorTrend:t,contextStatus:match?'matched':t==='unknown'?'insufficient_history':'not_matched',bias:match?d.bias:'neutral',shapeBias:d.bias};};
 for(let i=0;i<b.length;i++){
  for(const d of defs){const start=i-d.n+1;if(start<0||!d.test(b.slice(start,i+1)))continue;const o={pattern:d.name,variant:d.variant,startTime:b[start].time,eventTime:b[i].time,...context(d,start),action:'observation_only'};observations.push(o);emit('patterns','confirmed',b[i].time,o,d.name+':'+d.variant+':'+o.startTime);}
  for(const x of candidates.filter(x=>['watching','forming'].includes(x.status))){const d=defs.find(d=>d.name===x.pattern),n=i-x.startIndex+1;if(n<=1)continue;
   if(n===d.n)x.status=d.test(b.slice(x.startIndex,i+1))?'confirmed':'rejected';else x.status=d.middle&&!d.middle(b[x.startIndex],b[i])?'rejected':'forming';x.knownAt=b[i].time;emit('developing',x.status,b[i].time,{candidateId:x.id,pattern:x.pattern},x.id);
  }
  for(const d of defs.filter(d=>d.seed)){if(!d.seed(b[i]))continue;const x={id:id('candidate',d.name+':'+d.variant+':'+b[i].time),pattern:d.name,variant:d.variant,startIndex:i,startTime:b[i].time,knownAt:b[i].time,status:'watching',expectedFinalClose:b[i].time+(d.n-1)*c.intervalMs,...context(d,i)};candidates.push(x);emit('developing','watching',b[i].time,{candidateId:x.id,pattern:x.pattern},x.id);}
 }
 if(live){for(const d of defs.filter(d=>d.n===1))if(d.test([live]))previews.push({pattern:d.name,status:'awaiting_final_close',provisional:true,conditionsSatisfiedNow:true,scheduledClose:live.time,observedAt:now,...context(d,b.length)});
 for(const x of candidates.filter(x=>['watching','forming'].includes(x.status))){const d=defs.find(d=>d.name===x.pattern),seq=b.slice(x.startIndex).concat(live);previews.push({candidateId:x.id,pattern:x.pattern,status:seq.length===d.n?'awaiting_final_close':'forming',provisional:true,conditionsSatisfiedNow:seq.length===d.n?d.test(seq):null,middleEligibleNow:seq.length===2&&d.middle?d.middle(seq[0],seq[1]):null,scheduledClose:live.time,observedAt:now});}}
 return {observations,candidates,previews};
}
function structure(b,c,emit){const atr=atrSeries(b,c.atrPeriod),scales={internal:{highs:[],lows:[],direction:'unknown',protectedLow:null,protectedHigh:null},major:{highs:[],lows:[],direction:'unknown',protectedLow:null,protectedHigh:null}};
 for(let i=0;i<b.length;i++){if(atr[i]===null)continue;for(const name of ['internal','major']){const s=scales[name],left=c[name+'Left'],right=c[name+'Right'],p=i-right,tol=Math.max(2*c.tickSize,c.equalAtr*atr[i]),buffer=Math.max(c.tickSize,c.breakAtr*atr[i]);
 if(p>=left)for(const side of ['high','low']){let valid=true;const value=b[p][side];for(let j=p-left;j<=p+right;j++)if(j!==p&&(side==='high'?b[j].high>=value:b[j].low<=value)){valid=false;break;}if(!valid)continue;
 const list=side==='high'?s.highs:s.lows,prior=list.at(-1),delta=prior?value-prior.price:null,label=delta===null?(side==='high'?'H':'L'):Math.abs(delta)<=tol?(side==='high'?'EH':'EL'):delta>0?(side==='high'?'HH':'HL'):(side==='high'?'LH':'LL');
 const v={id:name+':'+side+':'+b[p].time,kind:side,price:value,pivotTime:b[p].time,knownAt:b[i].time,label,tolerance:tol,breakLevel:value+(side==='high'?buffer:-buffer),broken:false};list.push(v);emit('structure','swing',b[i].time,{scale:name,...v},v.id);}
 const h=s.highs.at(-1),l=s.lows.at(-1),close=b[i].close,previous=s.direction;
 if(s.protectedLow&&close<s.protectedLow.breakLevel&&s.direction==='bullish')s.direction='bearish_transition';if(s.protectedHigh&&close>s.protectedHigh.breakLevel&&s.direction==='bearish')s.direction='bullish_transition';
 const up=h&&!h.broken&&close>h.breakLevel,down=l&&!l.broken&&close<l.breakLevel;
 if(up){h.broken=true;s.protectedLow=l?{...l}:null;emit('structure','break_up',b[i].time,{scale:name,level:h.price},h.id);if(['bearish','bearish_transition'].includes(s.direction))s.direction='bullish_transition';else if(h.label==='HH'&&l?.label==='HL')s.direction='bullish';}
 if(down){l.broken=true;s.protectedHigh=h?{...h}:null;emit('structure','break_down',b[i].time,{scale:name,level:l.price},l.id);if(['bullish','bullish_transition'].includes(s.direction))s.direction='bearish_transition';else if(h?.label==='LH'&&l.label==='LL')s.direction='bearish';}
 if(s.direction==='unknown'&&h?.label==='HH'&&l?.label==='HL')s.direction='bullish';if(s.direction==='unknown'&&h?.label==='LH'&&l?.label==='LL')s.direction='bearish';
 if(up&&s.direction==='bullish_transition'&&h.label==='HH'&&l?.label==='HL')s.direction='bullish';if(down&&s.direction==='bearish_transition'&&h?.label==='LH'&&l.label==='LL')s.direction='bearish';
 if(previous!==s.direction)emit('structure','state_change',b[i].time,{scale:name,from:previous,to:s.direction},name);
 }}
 const s=scales.major,enough=s.highs.length>=2&&s.lows.length>=2,e=efficiency(b,c.rangeLookback),range={confirmed:false,efficiency:e,upper:null,lower:null,highTests:0,lowTests:0};let bias=enough?s.direction:'insufficient_data';
 if(enough&&e!==null){const recent=b.slice(-c.rangeLookback),hs=s.highs.filter(x=>x.pivotTime>=recent[0].time),ls=s.lows.filter(x=>x.pivotTime>=recent[0].time),tol=Math.max(2*c.tickSize,c.equalAtr*atr.at(-1));if(hs.length&&ls.length){range.upper=Math.max(...hs.map(x=>x.price));range.lower=Math.min(...ls.map(x=>x.price));range.highTests=hs.filter(x=>range.upper-x.price<=tol).length;range.lowTests=ls.filter(x=>x.price-range.lower<=tol).length;range.confirmed=range.upper>range.lower&&e<=c.rangeEfficiency&&range.highTests>=c.rangeMinTests&&range.lowTests>=c.rangeMinTests&&recent.every(x=>x.close<=range.upper+tol&&x.close>=range.lower-tol);if(range.confirmed)bias='range';}}
 if(bias==='bullish'&&scales.internal.highs.at(-1)?.label==='LH')bias='bullish_weakening';if(bias==='bearish'&&scales.internal.lows.at(-1)?.label==='HL')bias='bearish_weakening';if(bias==='unknown')bias='mixed';return {bias,atr:atr.at(-1)??null,range,scales};
}
function setupScan(b,levels,c,emit,id){const candidates=[],used=new Set();for(let i=0;i<b.length;i++){const x=b[i];
 for(const a of candidates){if(['invalidated','expired'].includes(a.status))continue;
 if(a.status==='triggered'){if(a.direction==='long'?x.low<=a.invalidation:x.high>=a.invalidation){a.status='invalidated';emit('setups','invalidated',x.time,{candidateId:a.id,reason:'stop_level_touched'},a.id);}continue;}
 if(i-a.breakIndex>c.expiryBars){a.status='expired';emit('setups','expired',x.time,{candidateId:a.id},a.id);continue;}if(i<=a.breakIndex)continue;
 if(a.direction==='long'?x.close<a.level-a.zone:x.close>a.level+a.zone){a.status='invalidated';emit('setups','invalidated',x.time,{candidateId:a.id,reason:'failed_close'},a.id);continue;}
 if(x.low<=a.level+a.zone&&x.high>=a.level-a.zone&&(a.direction==='long'?x.close>a.level:x.close<a.level)){a.invalidation=a.direction==='long'?x.low-c.tickSize*c.stopTicks:x.high+c.tickSize*c.stopTicks;if(a.invalidation<=0){a.status='invalidated';emit('setups','invalidated',x.time,{candidateId:a.id,reason:'invalid_stop'},a.id);continue;}a.status='triggered';a.triggeredAt=x.time;a.referenceClose=x.close;emit('setups','triggered',x.time,{candidateId:a.id,direction:a.direction,referenceClose:x.close,invalidation:a.invalidation,riskEligibility:'not_evaluated'},a.id);}}
 if(!i)continue;for(const l of levels){if(used.has(l.id)||l.knownAt>b[i-1].time)continue;const direction=l.kind==='high'?'long':'short',zone=c.tickSize*c.zoneTicks,hit=direction==='long'?b[i-1].close<=l.price+zone&&x.close>l.price+zone:b[i-1].close>=l.price-zone&&x.close<l.price-zone;if(!hit)continue;used.add(l.id);const a={id:id('setup',l.id+':'+x.time),direction,status:'watching',level:l.price,levelId:l.id,breakAt:x.time,breakIndex:i,zone,invalidation:null,riskEligibility:'not_evaluated'};candidates.push(a);emit('setups','watching',x.time,{candidateId:a.id,direction},a.id);}}
 return {candidates};
}
function freshness(x,now){if(!x)return 'unavailable';if(!finite(x.asOf)||x.asOf>now||!finite(x.maxAgeMs)||x.maxAgeMs<=0)throw Error('Invalid source freshness');return now-x.asOf>x.maxAgeMs?'stale':'available';}
function flow(x,type,symbol,now){if(!x)return {status:'unavailable',netUsd:null,sign:'unknown',directionalBias:'unknown'};const health=freshness(x,now);
 if(!x.source||x.asset!==symbol||x.currency!=='USD'||!x.scope||!finite(x.windowStart)||!finite(x.windowEnd)||x.windowEnd<=x.windowStart||x.windowEnd>x.asOf)throw Error('Invalid flow metadata or underlying asset');
 let net=null;if(type==='etf'){if(x.netUsd!==null&&x.netUsd!==undefined&&!finite(x.netUsd))throw Error('Invalid netUsd');net=finite(x.netUsd)?x.netUsd:null;}else{if(!finite(x.inflowUsd)||x.inflowUsd<0||!finite(x.outflowUsd)||x.outflowUsd<0)throw Error('Invalid wallet flows');net=x.inflowUsd-x.outflowUsd;}
 const usable=health==='available'&&x.complete===true&&net!==null;return {source:x.source,asset:x.asset,scope:x.scope,asOf:x.asOf,windowStart:x.windowStart,windowEnd:x.windowEnd,status:health==='stale'?'stale':x.complete!==true?'partial':net===null?'unavailable':'available',netUsd:net,sign:usable?(net>0?'positive':net<0?'negative':'flat'):'unknown',directionalBias:usable&&type==='etf'?(net>0?'bullish_context':net<0?'bearish_context':'neutral'):'unknown',interpretation:type==='etf'?'Reported net fund flows; not intrabar buying pressure.':'Positive = net transfers into labeled exchange wallets; not proof of buying or selling.'};
}
function flowContext(input,{now=Date.now(),config={}}={}){const c=configuration(config),{symbol,venue,quote,price,priceAsOf,priceMaxAgeMs,etf=null,exchange=null,heatmap=null}=input;
 if(!symbol||!venue||!quote)throw Error('Context identity required');positive(price,'price');const priceStatus=freshness({asOf:priceAsOf,maxAgeMs:priceMaxAgeMs},now),hs=freshness(heatmap,now),clusters=[];
 const flows={etf:flow(etf,'etf',symbol,now),exchange:flow(exchange,'exchange',symbol,now)};
 if(heatmap){if(!heatmap.source||heatmap.symbol!==symbol||heatmap.venue!==venue||heatmap.quote!==quote||!heatmap.model||!heatmap.windowId||!['usd_notional','relative_intensity'].includes(heatmap.unit)||!Array.isArray(heatmap.bins)||heatmap.disjointBins!==true)throw Error('Incompatible heatmap metadata');const ids=new Set();
 const bins=heatmap.bins.map(x=>{if(!x.id||ids.has(x.id))throw Error('Unique bin IDs required');ids.add(x.id);positive(x.low,'bin low');positive(x.high,'bin high');if(x.high<x.low||!finite(x.value)||x.value<0||!['long','short'].includes(x.liquidatedSide))throw Error('Invalid bin');if(x.liquidatedSide==='short'&&x.low<=price||x.liquidatedSide==='long'&&x.high>=price)throw Error('Crossed bin; refresh heatmap');return {...x};}).sort((a,b)=>a.low-b.low);
 for(let i=1;i<bins.length;i++)if(bins[i].low<bins[i-1].high)throw Error('Overlapping bins');
 for(const b of bins){const a=clusters.at(-1);if(a&&a.liquidatedSide===b.liquidatedSide&&(b.low-a.high)/price*10000<=c.mergeDistanceBps){a.high=b.high;a.value+=b.value;a.binIds.push(b.id);}else clusters.push({low:b.low,high:b.high,value:b.value,binIds:[b.id],liquidatedSide:b.liquidatedSide});}}
 const paths=['up','down'].map(direction=>{const selected=clusters.filter(x=>direction==='up'?x.liquidatedSide==='short':x.liquidatedSide==='long').sort((a,b)=>direction==='up'?a.low-b.low:b.high-a.high);let cumulative=0,previous=0;const levels=selected.map(x=>{cumulative+=x.value;const distance=(direction==='up'?x.low-price:price-x.high)/price*10000,far=(direction==='up'?x.high-price:price-x.low)/price*10000,gap=Math.max(0,distance-previous);previous=far;return {...x,direction,distanceBps:distance,farEdgeDistanceBps:far,gapFromPriorEdgeBps:gap,unit:heatmap.unit,estimatedNotionalUsd:heatmap.unit==='usd_notional'?x.value:null,relativeIntensity:heatmap.unit==='relative_intensity'?x.value:null,cumulativeModeledNotionalUsd:heatmap.unit==='usd_notional'?cumulative:null,cumulativeRelativeIntensity:heatmap.unit==='relative_intensity'?cumulative:null};});return {direction,status:priceStatus!=='available'?'stale_price':hs,levels,projectedCascadePrice:null,cascadeProbability:null};});
 return {symbol,venue,quote,observedAt:now,price,priceStatus,flows,heatmap:{status:hs,source:heatmap?.source??null,model:heatmap?.model??null,estimated:true},paths,tradeEligibility:'not_evaluated'};
}
function reviewZones(context,{bias='unknown',setupDirection=null,setupConfirmed=false}={}){if(!['bullish','bearish','range','unknown'].includes(bias))throw Error('Explicit bias required');return context.paths.flatMap(p=>p.levels.map(x=>({symbol:context.symbol,venue:context.venue,quote:context.quote,zoneLow:x.low,zoneHigh:x.high,pathDirection:p.direction,distanceBps:x.distanceBps,estimatedNotionalUsd:x.estimatedNotionalUsd,relativeIntensity:x.relativeIntensity,status:p.status==='available'?'research_watch_zone':'data_blocked',biasAligned:p.direction==='up'?bias==='bullish':bias==='bearish',setupAligned:setupConfirmed&&(p.direction==='up'?setupDirection==='long':setupDirection==='short'),limitPrice:null,orderSide:null,accountRisk:'not_evaluated'})));}
function analyzeStream(input,options={}){const {bars:raw=[],liveBar=null,symbol='UNKNOWN',venue='UNKNOWN',timeframe='UNKNOWN',intervalMs,staleAfterMs,context=null}=input,now=options.now??Date.now(),c=configuration(options.config);positive(intervalMs,'intervalMs');positive(staleAfterMs,'staleAfterMs');if(!finite(now))throw Error('Invalid now');c.intervalMs=intervalMs;
 const all=raw.map(x=>candle(x,true));let gap=-1;for(let i=0;i<all.length;i++){if(all[i].time>now||(i&&all[i].time<=all[i-1].time))throw Error('Invalid candle times');if(i&&all[i].time-all[i-1].time!==intervalMs)gap=i;}
 const b=gap<0?all:all.slice(gap),live=liveBar?candle(liveBar,false):null;if(live&&(live.time<=now||!b.length||live.time!==b.at(-1).time+intervalMs))throw Error('Invalid live schedule');
 const namespace=JSON.stringify([VERSION,symbol,venue,timeframe,c]),id=(component,key)=>JSON.stringify([namespace,component,key]),events=[],emit=(component,type,time,payload,key)=>events.push({id:id(component,type+':'+time+':'+key),symbol,venue,timeframe,component,type,eventTime:time,...payload});
 const st=structure(b,c,emit),pa=patterns(b,live,c,emit,id,now),ss=setupScan(b,[...st.scales.major.highs,...st.scales.major.lows],c,emit,id);
 let fc=null;if(context){if(context.symbol!==symbol||context.venue!==venue)throw Error('Context stream mismatch');fc=flowContext(context,{now,config:c});}
 events.sort((a,b)=>a.eventTime-b.eventTime||a.id.localeCompare(b.id));const asOf=b.at(-1)?.time??null,dataStatus=asOf===null?'empty':gap>=0?'gap':now-asOf>staleAfterMs?'stale':st.atr===null?'warming_up':'ready';
 return {version:VERSION,namespace,symbol,venue,timeframe,asOf,observedAt:now,dataStatus,gapDetected:gap>=0,structure:st,patterns:pa,setups:ss,flowContext:fc,events,accountRisk:{status:'not_evaluated',reason:'Use existing tested account math; no automatic netting of opposing risk.'}};
}
function analyzeModel(streams,options={}){const results=streams.map(s=>analyzeStream(s,options)),keys=results.map(r=>JSON.stringify([r.symbol,r.venue,r.timeframe]));if(new Set(keys).size!==keys.length)throw Error('Duplicate streams');return {version:VERSION,streams:results,context:results.map(r=>({symbol:r.symbol,venue:r.venue,timeframe:r.timeframe,dataStatus:r.dataStatus,bias:r.structure.bias,asOf:r.asOf})),events:results.flatMap(r=>r.events)};}
function alertBatch(result,{seenIds=[],afterTime=-Infinity,baseline=false,includeEarly=false,detectedAt=Date.now()}={}){if(baseline||result.dataStatus!=='ready')return [];const seen=new Set(seenIds),groups=new Map();for(const e of result.events){const allowed=e.component==='patterns'&&e.type==='confirmed'&&e.bias!=='neutral'||e.component==='setups'&&e.type==='triggered'||e.component==='structure'&&e.type==='state_change'||includeEarly&&e.component==='developing'&&['watching','forming'].includes(e.type);if(!allowed||e.eventTime<=afterTime||seen.has(e.id))continue;const key=JSON.stringify([e.symbol,e.venue,e.timeframe,e.eventTime]);if(!groups.has(key))groups.set(key,{symbol:e.symbol,venue:e.venue,timeframe:e.timeframe,eventTime:e.eventTime,detectedAt,classification:'research_observations_not_trade_instructions',events:[]});groups.get(key).events.push(e);}return [...groups.values()];}
return {VERSION,DEFAULTS,analyzeStream,analyzeModel,flowContext,reviewZones,alertBatch,efficiency,registry:config=>registry(configuration(config)).map(d=>({name:d.name,bars:d.n,earlyLifecycle:!!d.seed,livePreview:d.n===1}))};
});
