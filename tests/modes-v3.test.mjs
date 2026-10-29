import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PortfolioChallenge } from '../src/engine/PortfolioChallenge.js';
import { sessionPlan,SESSION_DAY_OPTIONS,DURATION_OPTIONS,selectHistoricalSessions,sourceSessions } from '../src/engine/session.js';
import { HistoricalMarket,validateOrderbookDataset } from '../src/engine/HistoricalMarket.js';
import { MarketActivity } from '../src/engine/MarketActivity.js';
import { MarketRegimes,sessionSegment,volumeSchedule,REGIMES } from '../src/engine/MarketRegimes.js';
import { GameLoop } from '../src/engine/GameLoop.js';
import { OrderBook } from '../src/engine/OrderBook.js';
import { BotFleet,BASE_MIX } from '../src/engine/BotFleet.js';
import { BOT_TYPES,BreakoutBot,TWAPBot } from '../src/engine/bots.js';
import { boardKey,boardDimensions } from '../src/services/boards.js';
import { publicSettings } from '../src/services/data-catalog.js';
import { donationOptions } from '../src/ui/donations.js';
class Bus{constructor(){this.listeners={};}on(name,fn){(this.listeners[name]||=[]).push(fn);}emit(name,value){for(const fn of this.listeners[name]||[])fn(value);}}
const portfolio=JSON.parse(await readFile(new URL('../data/portfolio/demo-30.json',import.meta.url)));
const frame=(date,time,price,extra={})=>({timestamp:`${date}T${time}Z`,bids:[{price:price-1,qty:30}],asks:[{price:price+1,qty:30}],...extra});
const dataset=frames=>({version:1,kind:'orderbook',currency:'USD',frames});

test('each daily or weekly portfolio allocation gets the full selected time',()=>{
 for(const stride of [1,5])for(const roundSeconds of [30,45,60,90]){
  const game=new PortfolioChallenge(portfolio,{stride,roundSeconds,rng:()=>0});game.register('Alice');game.start(1000);
  assert.equal(game.deadline,1000+roundSeconds*1000);assert.equal(game.advance(game.deadline-1),false);
  game.advance(game.deadline+100000);assert.equal(game.deadline,1000+roundSeconds*2000+100000);
  assert.equal(game.durationMinutes,game.snapshot('Alice').totalRounds*roundSeconds/60);
 }
 assert.throws(()=>new PortfolioChallenge(portfolio,{roundSeconds:5}),/30, 45, 60 or 90/);
});
test('long windows and real durations survive validation and preserve clock arithmetic',()=>{
 for(const sessionDays of SESSION_DAY_OPTIONS)for(const durationMinutes of DURATION_OPTIONS){
  const plan=sessionPlan({sessionDays,durationMinutes,barMinutes:5});
  assert.equal(plan.totalTicks,102*sessionDays);assert.equal(plan.totalMicroTicks,2040*sessionDays);
  assert.ok(Math.abs(plan.microIntervalMs*plan.totalMicroTicks-durationMinutes*60000)<1e-6);
  const settings=publicSettings({sessionDays,durationMinutes,portfolioRoundSeconds:60});
  assert.equal(settings.sessionDays,sessionDays);assert.equal(settings.durationMinutes,durationMinutes);assert.equal(settings.portfolioRoundSeconds,60);
 }
 assert.throws(()=>sessionPlan({sessionDays:999}));assert.throws(()=>sessionPlan({durationMinutes:0}));
});
test('a timed pulse refreshes the market between bars without triggering a decision',()=>{
 const bus=new Bus(),book=new OrderBook(bus);let pulses=0,decisions=0;
 const loop=new GameLoop(book,bus,{onPulse:()=>pulses++,shouldPause:()=>{decisions++;return true;}});
 loop.configure({sessionDays:1,barMinutes:5,durationMinutes:120});
 loop.fleet={start(){},onTick(){book.lastPrice+=0.01;},endDay(){},nextDay(){}};
 loop.start({clock:false});loop.fast=false;loop.startedAt=performance.now()-loop.microIntervalMs*5.5;loop.pump();loop.stop();
 assert.equal(loop.microTicks,5);assert.equal(loop.ticksDone,0);assert.equal(loop.priceHistory.length,1);
 assert.ok(pulses>1);assert.equal(decisions,0);assert.ok(book.lastPrice>100);
});
test('sixty-session simulation rolls 59 times, keeps history bounded, and terminates once',()=>{
 const bus=new Bus(),book=new OrderBook(bus),loop=new GameLoop(book,bus);let days=0,terminal=0,micros=0;
 loop.configure({sessionDays:60,barMinutes:15,durationMinutes:120});
 loop.fleet={start(){},onTick(){micros++;},nextDay(){days++;},endDay(){terminal++;}};
 loop.start({clock:false});while(loop.ticksDone<loop.totalTicks)loop.step();loop.stop();
 assert.equal(micros,122400);assert.equal(days,59);assert.equal(terminal,1);assert.ok(loop.microHistory.length<=8192);
 assert.equal(loop.priceHistory.length,2041);assert.match(loop.currentTime(),/Day 60\/60/);
});
test('a historical close cannot reveal the next session opening',()=>{
 const raw=dataset([frame('2024-01-02','09:30:00',100),frame('2024-01-02','18:00:00',101),frame('2024-01-03','09:30:00',200),frame('2024-01-03','18:00:00',201)]);
 const book=new OrderBook(),market=new HistoricalMarket(book,raw);market.start();market.advance(0.5);
 assert.equal(book.getMidPrice(),101);assert.equal(market.timestamp,'2024-01-02T18:00:00Z');
 market.advance(0.50001);assert.equal(book.getMidPrice(),200);
});
test('recorded prints count as volume and tape data without creating account fills',async()=>{
 const raw=dataset([frame('2024-01-02','09:30:00',100,{trades:[],volume:0}),
  frame('2024-01-02','18:00:00',102,{trades:[{price:101,qty:7,side:'BUY'},{price:103,qty:3,side:'SELL'}],volume:10})]);
 const bus=new Bus(),book=new OrderBook(bus);let fills=0;bus.on('TRADE',()=>fills++);
 const loop=new GameLoop(book,bus);loop.configure({sessionDays:1,barMinutes:15,durationMinutes:20,historicalData:raw});await loop.runFast();
 const activity=loop.marketActivity();assert.equal(activity.totalVolume,10);assert.equal(activity.dayVolume,10);assert.equal(activity.prints.length,2);
 assert.equal(activity.source,'Recorded trades');assert.equal(fills,0);
 assert.equal(loop.priceHistory.reduce((sum,bar)=>sum+bar.volume,0),10);
 assert.equal(loop.priceHistory.reduce((sum,bar)=>sum+bar.value,0),101*7+103*3);
});
test('interval-only data never fabricates trade prices or aggressors; missing volume stays unavailable',async()=>{
 for(const volume of [undefined,50]){
  const raw=dataset([frame('2024-01-02','09:30:00',100,volume==null?{}:{volume:0}),frame('2024-01-02','18:00:00',101,volume==null?{}:{volume})]);
  const bus=new Bus(),loop=new GameLoop(new OrderBook(bus),bus);loop.configure({sessionDays:1,barMinutes:15,durationMinutes:20,historicalData:raw});await loop.runFast();
  const activity=loop.marketActivity();assert.equal(activity.volumeAvailable,volume!=null);
  if(volume!=null){assert.equal(activity.prints[0].price,null);assert.equal(activity.prints[0].side,'UNKNOWN');assert.equal(activity.totalVolume,50);}
 }
});
test('bad recorded quantities, prices and inconsistent totals are rejected',()=>{
 const first=frame('2024-01-02','09:30:00',100),second=frame('2024-01-02','18:00:00',100);
 for(const extra of [{volume:-1},{volume:1.5},{trades:[{price:100,qty:NaN}]},{trades:[{price:100.001,qty:1}]},{trades:[{price:100,qty:1,side:'BAD'}]},
  {volume:100,trades:[{price:100,qty:1}]}])assert.throws(()=>validateOrderbookDataset(dataset([first,{...second,...extra}])));
});
test('activity separates daily and run volume and bounds the public tape',()=>{
 const activity=new MarketActivity();for(let i=0;i<100;i++)activity.add({price:100,qty:2,side:'BUY'});
 activity.beginDay(2);activity.add({price:101,qty:3});
 assert.equal(activity.totalVolume,203);assert.equal(activity.dayVolume,3);assert.equal(activity.prints.length,16);
});
test('intraday participation varies and regime transitions preserve a valid state across weeks',()=>{
 assert.ok(sessionSegment(34200).activity>sessionSegment(12*3600).activity);
 assert.ok(sessionSegment(17.5*3600).activity>sessionSegment(12*3600).activity);
 const regimes=new MarketRegimes({randomFn:()=>0.7});const seen=new Set();
 for(let i=0;i<20;i++){regimes.nextDay();for(const second of [34215,45000,54000,64785]){
  const state=regimes.step(second);seen.add(state.id);assert.ok(REGIMES[state.id]);assert.ok(state.liquidity>0);assert.ok(Number.isFinite(state.drift));
 }}
 assert.equal(regimes.day,20);assert.equal(regimes.step(60000).week,4);assert.ok(seen.size>1);
 let previous=0;for(let i=0;i<=100;i++){const next=volumeSchedule(i/100);assert.ok(next>=previous-1e-10);previous=next;}
 assert.equal(volumeSchedule(0),0);assert.ok(Math.abs(volumeSchedule(1)-1)<1e-10);
});
test('the population includes all new behaviours and preserves the 1000-agent base',()=>{
 assert.equal(Object.values(BASE_MIX).reduce((sum,n)=>sum+n,0),1000);
 const bus=new Bus(),fleet=new BotFleet(new OrderBook(bus),bus);fleet.start([{price:100}]);
 for(const type of ['twap','vwap','fundamental','breakout','orderFlow','riskManager']){assert.ok(BOT_TYPES[type]);assert.ok(fleet.countByType()[type]>0);}
});
test('new clocks and market generations have distinct boards while v2 keys are preserved',()=>{
 assert.notEqual(boardKey({challenge:'portfolio',roundSeconds:30}),boardKey({challenge:'portfolio',roundSeconds:60}));
 assert.notEqual(boardKey({sessionDays:20}),boardKey({sessionDays:60}));
 assert.notEqual(boardKey({durationMinutes:60}),boardKey({durationMinutes:120}));
 assert.equal(boardDimensions({challenge:'portfolio'}).durationMinutes,0);
 assert.equal(boardKey({version:2}),'2|trading|discretionary|simulated|5|5|20|single|5|simulation-v2');
 assert.notEqual(boardKey({}),boardKey({version:2}));
});
test('donation options hide blank links, reject unsafe URLs and avoid duplicates',()=>{
 assert.deepEqual(donationOptions({url:'',channels:[{provider:'PayPal',url:''}]}),[]);
 const choices=donationOptions({provider:'PayPal',url:'https://paypal.com/example',channels:[{url:'javascript:alert(1)'},{url:'https://paypal.com/example'},{provider:'Patreon',url:'https://patreon.com/example'}]});
 assert.equal(choices.length,2);assert.equal(choices[1].provider,'Patreon');
});
test('long demo provides 20 unique sessions and short demo has actively changing depth',async()=>{
 const short=JSON.parse(await readFile(new URL('../data/orderbooks/demo-book.json',import.meta.url)));
 const long=JSON.parse(await readFile(new URL('../data/orderbooks/demo-book-20.json',import.meta.url)));
 const market=new HistoricalMarket(new OrderBook(),short);
 assert.equal(market.resolutionSeconds,15);assert.equal(market.hasTrades,true);
 assert.notDeepEqual(short.frames[10].bids,short.frames[11].bids);
 assert.equal(sourceSessions(selectHistoricalSessions(long,20,()=>0)).length,20);
});

test('breakout entries compare the current observation with earlier prices',()=>{
 const bus=new Bus(),book=new OrderBook(bus),fleet=new BotFleet(book,bus);fleet.tick=10;
 const bot=new BreakoutBot('breakout-test',fleet);bot.lookback=3;bot.nextReview=0;
 const calls=[];bot.market=(side,qty)=>calls.push({side,qty});
 const state={shares:0,mid:101,length:4,lastVolume:100,volumeEma:100,trendWeight:100,
  history:[{price:100},{price:100},{price:100},{price:101}],memo:(key,fn)=>fn()};
 bot.onTick(state);assert.equal(calls[0].side,'BUY');assert.ok(calls[0].qty>0);
});
test('parent execution slices cannot ignore unfilled orders or exceed position room',()=>{
 const bus=new Bus(),book=new OrderBook(bus),fleet=new BotFleet(book,bus);fleet.regimes.day=1;fleet.tick=100;
 const bot=new TWAPBot('twap-test',fleet);bot.epoch=1;bot.side='BUY';bot.startShares=0;bot.parentQty=1000;bot.nextSlice=0;bot.maxPosition=50;
 book.processOrder({playerId:'seller',side:'SELL',type:'LIMIT',price:101,qty:500});
 const calls=[];bot.market=(side,qty)=>calls.push({side,qty});
 bot.onTick({simSeconds:64800});assert.equal(calls[0].qty,50);
 bot.shares=50;bot.nextSlice=0;bot.onTick({simSeconds:64800});assert.equal(calls.length,1);
});
