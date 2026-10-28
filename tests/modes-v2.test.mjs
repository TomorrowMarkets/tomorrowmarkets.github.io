import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimpleEngine,defaultSimpleStrategy,validateSimpleStrategy,featureValue,compare } from '../src/engine/algo/SimpleEngine.js';
import { buildSnapshot } from '../src/engine/algo/AlgoAPI.js';
import { sessionPlan,selectHistoricalSessions,sourceSessions } from '../src/engine/session.js';
import { GameLoop } from '../src/engine/GameLoop.js';
import { OrderBook } from '../src/engine/OrderBook.js';
import { BotFleet } from '../src/engine/BotFleet.js';
import { MarketEvents } from '../src/engine/MarketEvents.js';
import { boardDimensions,boardKey,recordDeviceResult,deviceRows } from '../src/services/boards.js';
class Bus {constructor(){this.listeners={};}on(name,fn){(this.listeners[name]||=[]).push(fn);}emit(name,value){for(const fn of this.listeners[name]||[])fn(value);}}
const data=JSON.parse(await readFile(new URL('../data/orderbooks/demo-book.json',import.meta.url)));
const snapshot=(closes,extra={})=>buildSnapshot({priceHistory:closes.map((price,i)=>({price,volume:10,simSecs:i*300})),
  mid:closes.at(-1),account:{cash:10000,shares:40,avgEntry:100,realizedPnL:0},...extra});
function onlyBuy(){const strategy=defaultSimpleStrategy();strategy.sell.enabled=false;strategy.buy.cancelWorking=false;
 strategy.buy.conditions[0].right={kind:'number',value:100};strategy.buy.conditions[0].operator='gte';return strategy;}

test('rolling indicators wait for warmup; accumulating indicators use the full observed history',()=>{
 const s=snapshot(Array.from({length:500},(_,i)=>i+1));
 assert.equal(s.close.length,300);assert.equal(s.cumulative.count,500);
 assert.equal(featureValue({metric:'mean',window:'accumulating',period:20},s),250.5);
 assert.equal(featureValue({metric:'mean',window:'rolling',period:20},s),490.5);
 assert.equal(featureValue({metric:'mean',window:'rolling',period:20},snapshot([1,2,3])),null);
 assert.equal(featureValue({metric:'volume',window:'accumulating',period:1},s),5000);
 assert.equal(featureValue({metric:'rsi',window:'accumulating',period:14},s),100);
});
test('comparisons include inclusive bounds, around tolerance and crossing with prior observations',()=>{
 assert.equal(compare('gte',100,100),true);assert.equal(compare('lte',100,100),true);
 assert.equal(compare('around',101,100,null,1),true);assert.equal(compare('around',101.01,100,null,1),false);
 assert.equal(compare('crossAbove',101,100,null),false);assert.equal(compare('crossAbove',101,100,{a:99,b:100}),true);
 assert.equal(compare('crossBelow',99,100,{a:101,b:100}),true);assert.equal(compare('lt',NaN,1),false);
});
test('consecutive persistence does not count duplicate snapshots',async()=>{
 const engine=new SimpleEngine(),strategy=onlyBuy();strategy.buy.conditions[0].persistence.count=2;await engine.init(strategy);
 assert.equal((await engine.step(snapshot([100]))).actions.length,0);
 assert.equal((await engine.step(snapshot([100]))).actions.length,0);
 assert.equal((await engine.step(snapshot([100,100]))).actions.length,1);
});
test('rolling and accumulating hit counters distinguish recent matches from lifetime matches',async()=>{
 const run=async(mode)=>{const engine=new SimpleEngine(),strategy=onlyBuy();strategy.buy.conditions[0].persistence={mode,count:2,window:2};await engine.init(strategy);
  await engine.step(snapshot([100]));await engine.step(snapshot([100,90]));return (await engine.step(snapshot([100,90,100]))).actions.length;};
 assert.equal(await run('rollingHits'),0);assert.equal(await run('accumulatingHits'),1);
});
test('both buy and sell signals are skipped rather than self-crossed',async()=>{
 const strategy=onlyBuy();strategy.sell={...structuredClone(strategy.buy),enabled:true};const engine=new SimpleEngine();await engine.init(strategy);
 const result=await engine.step(snapshot([100]));assert.equal(result.actions.length,0);assert.match(result.logs[0],/Both/);
});
test('Simple cash and position percentages and limit offsets create finite sized orders',async()=>{
 const strategy=onlyBuy();strategy.buy.amountType='cashPct';strategy.buy.amount=25;strategy.buy.orderType='LIMIT';strategy.buy.limitOffsetBps=-50;
 const engine=new SimpleEngine();await engine.init(strategy);const order=(await engine.step(snapshot([100]))).actions[0];
 assert.equal(order.price,99.5);assert.equal(order.qty,25);assert.equal(order.kind,'LIMIT');
 strategy.buy.enabled=false;strategy.sell=structuredClone(strategy.buy);strategy.sell.enabled=true;strategy.sell.amountType='positionPct';strategy.sell.cancelWorking=false;
 await engine.init(strategy);assert.equal((await engine.step(snapshot([100]))).actions[0].qty,10);
});
test('invalid strategies and unavailable historical volume cannot generate signals',()=>{
 const bad=onlyBuy();bad.buy.amount=Infinity;assert.throws(()=>validateSimpleStrategy(bad));
 assert.equal(featureValue({metric:'volume',window:'rolling',period:1},{...snapshot([100]),volume_available:false}),null);
});
test('five sessions fit the selected wall duration with 5/10/15-minute bars',()=>{
 for(const [barMinutes,expected] of [[5,510],[10,255],[15,170]]){const plan=sessionPlan({sessionDays:5,barMinutes,durationMinutes:20});
  assert.equal(plan.totalTicks,expected);assert.equal(plan.tickIntervalMs*plan.totalTicks,1200000);assert.equal(plan.microPerBar*plan.totalTicks,10200);}
});
test('historical windows select whole sessions and reject insufficient data',()=>{
 assert.equal(sourceSessions(data).length,5);assert.equal(sourceSessions(selectHistoricalSessions(data,1,()=>0.99)).length,1);
 assert.equal(sourceSessions(selectHistoricalSessions(data,5,()=>0)).length,5);
 assert.throws(()=>selectHistoricalSessions({...data,frames:data.frames.slice(0,200)},5),/contains 1 session/);
});
test('backtests can select a repeatable recorded start date',()=>{
 const days=sourceSessions(data),start=days[2].date;
 const selected=selectHistoricalSessions(data,1,()=>0,start);
 assert.equal(selected.windowStart,start);assert.equal(selected.windowEnd,start);
 assert.throws(()=>selectHistoricalSessions(data,5,()=>0,start),/enough recorded sessions/);
});
test('five-day simulation keeps 15-second microsteps, rolls sessions four times and finishes once',()=>{
 const bus=new Bus(),book=new OrderBook(bus),loop=new GameLoop(book,bus);let micros=0,days=0,terminal=0;
 loop.configure({sessionDays:5,barMinutes:15,durationMinutes:20});
 loop.fleet={start(){},onTick(){micros++;},nextDay(){days++;},endDay(){terminal++;}};
 loop.start({clock:false});while(loop.ticksDone<loop.totalTicks)loop.step();loop.stop();
 assert.equal(micros,10200);assert.equal(days,4);assert.equal(terminal,1);assert.equal(loop.priceHistory.length,171);assert.match(loop.currentTime(),/Day 5\/5.*06:00:00 PM/);
});
test('real bot fleet removes temporary cohorts without duplicating its base population',()=>{
 const bus=new Bus(),book=new OrderBook(bus),fleet=new BotFleet(book,bus),history=[{price:100}];fleet.start(history);
 assert.equal(fleet.size,1000);fleet.onTick({tick:1,simSeconds:34215,history});assert.equal(fleet.size,1100);
 fleet.nextDay(history);assert.equal(fleet.size,1000);
});
test('fast historical backtest exposes only observed bars to each decision and closes on the final snapshot',async()=>{
 const bus=new Bus(),book=new OrderBook(bus);let finished=0;const loop=new GameLoop(book,bus,{onFinish:()=>finished++});
 loop.configure({sessionDays:5,barMinutes:15,durationMinutes:20,historicalData:data});
 const seen=[];await loop.runFast({onDecision:async round=>seen.push({round,history:loop.priceHistory.length,time:loop.historical.timestamp})});
 assert.equal(loop.finished,true);assert.equal(finished,1);assert.equal(seen[0].history,1);assert.equal(seen.at(-1).history,170);
 assert.equal(loop.historical.timestamp,data.frames.at(-1).timestamp);assert.equal(loop.priceHistory.length,171);
});
test('random events have bounded shocks and fade liquidity back toward baseline',()=>{
 const events=new MarketEvents({randomFn:()=>0,gaussian:()=>1});const first=events.step(34200);assert.ok(first.jump>0);assert.ok(first.liquidity<1);
 const later=events.step(34200+60*50);assert.equal(later.liquidity,1);assert.equal(later.volatility,1);assert.equal(later.jump,0);
});
test('leaderboard dimensions separate strategy, source, duration, horizon and dataset',()=>{
 const original=boardKey({strategy:'algorithmic',source:'historical',datasetId:'test'});
 for(const change of [{strategy:'simple'},{source:'simulated'},{durationMinutes:10},{sessionDays:1},{datasetId:'other'}])assert.notEqual(boardKey({strategy:'algorithmic',source:'historical',datasetId:'test',...change}),original);
 assert.equal(boardDimensions({challenge:'backtest'}).durationMinutes,0);
});
test('device boards persist actual results and never mix different categories',()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};
 recordDeviceResult({strategy:'simple'},{handle:'Alice',returnPct:5,pnl:500},storage);
 recordDeviceResult({strategy:'simple'},{handle:'Bob',returnPct:8,pnl:800},storage);
 assert.equal(deviceRows({strategy:'simple'},storage)[0].handle,'Bob');assert.equal(deviceRows({strategy:'algorithmic'},storage).length,0);
});
