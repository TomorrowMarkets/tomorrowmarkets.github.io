import { BotFleet } from './BotFleet.js';
import { TickAccumulator } from './bars.js';
import { HistoricalMarket } from './HistoricalMarket.js';
import { sessionPlan, SESSION_SECONDS, MICRO_SECONDS } from './session.js';
import { MarketActivity } from './MarketActivity.js';

const SESSION_OPEN_SECS = 9 * 3600 + 30 * 60;
const SESSION_CLOSE_SECS = 18 * 3600;
const SIM_SECS_PER_TICK = 15;
const GAME_DURATION_MINUTES = 10;
const TOTAL_TICKS = (SESSION_CLOSE_SECS - SESSION_OPEN_SECS) / SIM_SECS_PER_TICK;
const MAX_BACKLOG_MICROS = 400;
const MICRO_HISTORY_LIMIT = 4096;
function formatSimTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  return `${String(hours % 12 || 12).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')} ${hours >= 12 ? 'PM' : 'AM'}`;
}

export class PulseClock {
  constructor(intervalMs, onPulse) {
    this.intervalMs = intervalMs;
    this.onPulse = onPulse;
    this.worker = null;
    this.workerUrl = null;
    this.timer = null;
  }

  start() {
    this.stop();
    try {
      const src = 'let t=null;onmessage=(e)=>{clearInterval(t);t=null;if(e.data>0)t=setInterval(()=>postMessage(1),e.data);};';
      this.workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      this.worker = new Worker(this.workerUrl);
      this.worker.onmessage = () => this.onPulse();
      this.worker.onerror = () => this.useFallback();
      this.worker.postMessage(this.intervalMs);
    } catch (err) {
      this.useFallback();
    }
  }

  useFallback() {
    this.stopWorker();
    if (!this.timer) this.timer = setInterval(() => this.onPulse(), this.intervalMs);
  }

  stopWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.workerUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
    }
  }

  stop() {
    this.stopWorker();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export class GameLoop {
  constructor(orderBook,eventBus,{durationMinutes=10,afterStep,onPulse,onFinish,onNews,shouldPause,onPaused}={}) {
    this.orderBook=orderBook;this.eventBus=eventBus;this.afterStep=afterStep;this.onPulse=onPulse;
    this.onFinish=onFinish;this.onNews=onNews;this.shouldPause=shouldPause;this.onPaused=onPaused;
    this.fleet=new BotFleet(orderBook,eventBus,{simSecsPerTick:MICRO_SECONDS,openSecs:SESSION_OPEN_SECS,closeSecs:SESSION_CLOSE_SECS,onNews});
    this.tickBar=new TickAccumulator();this.activity=new MarketActivity();this.collecting=false;
    eventBus.on('TRADE',trade=>{
      if(!this.collecting)return;
      this.tickBar.addTrade(trade.price,trade.qty);
      if(!this.historical)this.activity.add({price:trade.price,qty:trade.qty,side:trade.aggressor,timestamp:this.currentTime()});
    });
    this.clock=new PulseClock(100,()=>this.pump());this.running=false;this.finished=false;
    this.configure({durationMinutes,sessionDays:1,barMinutes:0.25});
  }
  configure({durationMinutes=20,historicalData=null,sessionDays=5,barMinutes=5,arena=null}={}) {
    if(this.running)throw new Error('The market is already running.');
    this.plan=sessionPlan({durationMinutes,sessionDays,barMinutes});Object.assign(this,this.plan);
    this.historical=historicalData?new HistoricalMarket(this.orderBook,historicalData):null;
    if(this.historical&&this.historical.sessions.length!==sessionDays)throw new Error('Load exactly the selected number of historical sessions.');
    this.orderBook.referencePrice=null;this.clock.intervalMs=Math.max(16,Math.min(100,this.microIntervalMs));
    this.arena=arena;this.fleet.arenaAgents=arena?.agents||null;
    this.ticksDone=0;this.microTicks=0;this.dayIndex=0;this.simulatedSeconds=SESSION_OPEN_SECS;
    this.priceHistory=[];this.microHistory=[];this.fast=false;this.recordedVolume=0;this.recordedValue=0;
  }
  currentTime() {
    if(this.historical?.timestamp)return this.historical.timestamp.replace('T',' ').replace('Z',' UTC');
    const elapsed=Math.max(0,this.simulatedSeconds-SESSION_OPEN_SECS-this.dayIndex*SESSION_SECONDS);
    return `${this.sessionDays>1?`Day ${this.dayIndex+1}/${this.sessionDays} · `:''}${formatSimTime(SESSION_OPEN_SECS+elapsed)}`;
  }
  progress(){return this.microTicks/this.totalMicroTicks;}
  marketActivity(){return this.activity.snapshot({historical:this.historical,
    barVolume:this.historical?this.recordedVolume:this.tickBar.volume,
    regime:this.historical?null:this.fleet.regimeState||null});}
  recordFrame(){
    const frame=this.historical.currentFrame,mid=this.orderBook.getMidPrice();
    const volume=frame.volume||0;this.recordedVolume+=volume;
    if(frame.trades){
      for(const trade of frame.trades){this.recordedValue+=trade.price*trade.qty;
        this.activity.add({...trade,timestamp:frame.timestamp,kind:'recorded'});}
    }else if(volume){this.recordedValue+=mid*volume;
      // Aggregate volume has no observable execution price or aggressor.
      this.activity.add({qty:volume,timestamp:frame.timestamp,kind:'interval'});}
    this.tickBar.addTrade(mid,0);this.afterStep?.();
  }
  start({clock=true}={}) {
    this.ticksDone=0;this.microTicks=0;this.dayIndex=0;this.simulatedSeconds=SESSION_OPEN_SECS;
    this.finished=false;this.paused=false;this.fast=!clock;this.tickBar.reset();this.lastClose=null;
    this.recordedVolume=0;this.recordedValue=0;this.activity.reset();this.collecting=true;
    if(this.historical)this.historical.start(()=>this.recordFrame());
    this.microHistory=[{price:this.orderBook.getMidPrice(),simSecs:SESSION_OPEN_SECS}];
    if(!this.historical)this.fleet.start(this.microHistory);
    this.priceHistory=[this.makePoint()];
    this.startedAt=performance.now();this.running=true;
    if(clock)this.clock.start();this.onPulse?.([this.priceHistory[0]]);
  }
  stop(){this.running=false;this.paused=false;this.collecting=false;this.clock.stop();}
  pause(){if(this.paused||!this.running)return;this.paused=true;this.pausedAt=performance.now();this.clock.stop();}
  resume(){if(!this.paused||!this.running)return;
    // Keep the original public one-day format's paused decision budget.
    if(this.sessionDays===1)this.startedAt+=performance.now()-this.pausedAt;
    this.paused=false;if(!this.fast)this.clock.start();
  }
  finish(){if(this.finished)return;this.finished=true;this.stop();this.onFinish?.();}
  pump(){
    if(!this.running||this.paused||this.fast)return;
    let due=Math.min(this.totalMicroTicks,Math.floor((performance.now()-this.startedAt)/this.microIntervalMs));
    if(due-this.microTicks>MAX_BACKLOG_MICROS){
      const deferred=due-this.microTicks-MAX_BACKLOG_MICROS;
      this.startedAt+=deferred*this.microIntervalMs;due-=deferred;
    }
    const points=[],before=this.microTicks,budget=performance.now()+24;
    while(this.microTicks<due){
      const point=this.advanceMicro();
      if(point){points.push(point);
        if(this.shouldPause?.(this.ticksDone)&&this.ticksDone<this.totalTicks){this.pause();break;}}
      if(performance.now()>=budget)break;
    }
    if(this.microTicks>before)this.onPulse?.(points);
    if(this.paused){this.onPaused?.(this.ticksDone);return;}
    if(this.ticksDone>=this.totalTicks)this.finish();
  }
  advanceMicro(){
    if(this.microTicks>=this.totalMicroTicks)return null;
    const perDay=SESSION_SECONDS/MICRO_SECONDS,day=Math.floor(this.microTicks/perDay);
    const localMicro=this.microTicks%perDay;
    this.dayIndex=day;this.activity.beginDay(day+1);
    if(!this.historical&&localMicro===0&&day>0)this.fleet.nextDay(this.microHistory);
    this.microTicks+=1;this.simulatedSeconds=SESSION_OPEN_SECS+this.microTicks*MICRO_SECONDS;
    this.orderBook.currentTick=this.microTicks;this.orderBook.expireOrders(this.microTicks);
    if(this.historical){this.historical.advance(this.progress(),()=>this.recordFrame());this.afterStep?.();}
    else {
      this.fleet.onTick({tick:this.microTicks,simSeconds:SESSION_OPEN_SECS+(localMicro+1)*MICRO_SECONDS,history:this.microHistory});
      this.afterStep?.();const price=this.orderBook.getMidPrice();this.tickBar.addTrade(price,0);
      this.microHistory.push({price,simSecs:this.simulatedSeconds});
      if(this.microHistory.length>MICRO_HISTORY_LIMIT*2)this.microHistory.splice(0,MICRO_HISTORY_LIMIT);
      if(this.microTicks===this.totalMicroTicks)this.fleet.endDay(this.microHistory);
    }
    if(this.microTicks%this.microPerBar!==0)return null;
    this.ticksDone+=1;const point=this.makePoint();this.priceHistory.push(point);return point;
  }
  // Fast runs and headless checks finish one decision bar at a time.
  step(){const target=this.ticksDone+1;let point=null;
    while(this.ticksDone<target&&this.microTicks<this.totalMicroTicks)point=this.advanceMicro()||point;
    return point;
  }
  makePoint(){const close=this.orderBook.getMidPrice();const bar=this.tickBar.take(this.lastClose??close,close);this.lastClose=close;
    const point={...bar,...(this.historical?{volume:this.recordedVolume,value:this.recordedValue,volumeAvailable:this.historical.hasVolume}:{}),
      simTimeStr:this.currentTime(),simSecs:this.simulatedSeconds,day:this.dayIndex+1,sourceTimestamp:this.historical?.timestamp||null};
    this.recordedVolume=0;this.recordedValue=0;return point;
  }
  async runFast({onDecision=null,onProgress=null}={}){
    this.start({clock:false});if(onDecision)await onDecision(0);
    while(this.running&&this.ticksDone<this.totalTicks){
      if(this.paused){await new Promise(resolve=>setTimeout(resolve,25));continue;}
      const point=this.step();this.onPulse?.([point]);
      if(this.ticksDone<this.totalTicks&&onDecision)await onDecision(this.ticksDone);
      if(this.ticksDone%5===0){onProgress?.(this.progress());await new Promise(resolve=>setTimeout(resolve,0));}
    }
    if(this.running&&this.ticksDone>=this.totalTicks)this.finish();return this.finished;
  }
}
