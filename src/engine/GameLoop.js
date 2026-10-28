import { BotFleet } from './BotFleet.js';
import { TickAccumulator } from './bars.js';
import { HistoricalMarket } from './HistoricalMarket.js';
import { sessionPlan, SESSION_SECONDS, MICRO_SECONDS } from './session.js';

const SESSION_OPEN_SECS = 9 * 3600 + 30 * 60;
const SESSION_CLOSE_SECS = 18 * 3600;
const SIM_SECS_PER_TICK = 15;
const GAME_DURATION_MINUTES = 10;
const TOTAL_TICKS = (SESSION_CLOSE_SECS - SESSION_OPEN_SECS) / SIM_SECS_PER_TICK;
const MAX_BACKLOG_TICKS = 40;
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
    this.tickBar=new TickAccumulator();this.collecting=false;
    eventBus.on('TRADE',t=>{if(this.collecting)this.tickBar.addTrade(t.price,t.qty);});
    this.clock=new PulseClock(100,()=>this.pump());this.running=false;this.finished=false;
    this.configure({durationMinutes,sessionDays:1,barMinutes:0.25});
  }
  configure({durationMinutes=20,historicalData=null,sessionDays=5,barMinutes=5,arena=null}={}) {
    if(this.running)throw new Error('The market is already running.');
    this.plan=sessionPlan({durationMinutes,sessionDays,barMinutes});Object.assign(this,this.plan);
    this.historical=historicalData?new HistoricalMarket(this.orderBook,historicalData):null;
    this.orderBook.referencePrice=null;this.clock.intervalMs=Math.min(100,this.tickIntervalMs/3);
    this.arena=arena;this.fleet.arenaAgents=arena?.agents||null;
    this.ticksDone=0;this.microTicks=0;this.dayIndex=0;this.simulatedSeconds=SESSION_OPEN_SECS;
    this.priceHistory=[];this.microHistory=[];this.fast=false;
    this.recordedVolume=0;this.recordedValue=0;
  }
  currentTime() {
    if(this.historical?.timestamp)return this.historical.timestamp.replace('T',' ').replace('Z',' UTC');
    const elapsed=Math.max(0,this.simulatedSeconds-SESSION_OPEN_SECS-this.dayIndex*SESSION_SECONDS);
    return `${this.sessionDays>1?`Day ${this.dayIndex+1}/${this.sessionDays} · `:''}${formatSimTime(SESSION_OPEN_SECS+elapsed)}`;
  }
  progress(){return this.ticksDone/this.totalTicks;}
  start({clock=true}={}) {
    this.ticksDone=0;this.microTicks=0;this.dayIndex=0;this.simulatedSeconds=SESSION_OPEN_SECS;
    this.finished=false;this.paused=false;this.fast=!clock;this.tickBar.reset();this.lastClose=null;
    this.collecting=true;if(this.historical)this.historical.start();
    this.priceHistory=[this.makePoint()];this.microHistory=[{price:this.orderBook.getMidPrice(),simSecs:SESSION_OPEN_SECS}];
    if(!this.historical)this.fleet.start(this.microHistory);
    this.startedAt=performance.now();this.running=true;
    if(clock)this.clock.start();this.onPulse?.([this.priceHistory[0]]);
  }
  stop(){this.running=false;this.paused=false;this.collecting=false;this.clock.stop();}
  pause(){if(this.paused||!this.running)return;this.paused=true;this.pausedAt=performance.now();this.clock.stop();}
  resume(){if(!this.paused||!this.running)return;
    // Five-day sessions count decision time within the nominal wall clock.
    if(this.sessionDays===1)this.startedAt+=performance.now()-this.pausedAt;
    this.paused=false;if(!this.fast)this.clock.start();
  }
  finish(){if(this.finished)return;this.finished=true;this.stop();this.onFinish?.();}
  pump(){
    if(!this.running||this.paused||this.fast)return;
    let due=Math.min(this.totalTicks,Math.floor((performance.now()-this.startedAt)/this.tickIntervalMs));
    if(due-this.ticksDone>MAX_BACKLOG_TICKS){const skipped=due-this.ticksDone-MAX_BACKLOG_TICKS;this.startedAt+=skipped*this.tickIntervalMs;due-=skipped;}
    const points=[];
    while(this.ticksDone<due){points.push(this.step());
      if(this.shouldPause?.(this.ticksDone)&&this.ticksDone<this.totalTicks){this.pause();break;}}
    if(points.length)this.onPulse?.(points);
    if(this.paused){this.onPaused?.(this.ticksDone);return;}
    if(this.ticksDone>=this.totalTicks)this.finish();
  }
  step(){
    const barIndex=this.ticksDone;const day=Math.floor(barIndex/this.barsPerDay);const localBar=barIndex%this.barsPerDay;
    this.dayIndex=day;
    if(!this.historical&&localBar===0&&day>0)this.fleet.nextDay(this.microHistory);
    this.ticksDone+=1;
    if(this.historical){
      this.recordedVolume=0;this.recordedValue=0;
      this.simulatedSeconds=SESSION_OPEN_SECS+this.ticksDone*this.barSeconds;
      this.historical.advance(this.progress(),()=>{
        const mid=this.orderBook.getMidPrice(),volume=this.historical.currentFrame.volume||0;
        this.recordedVolume+=volume;this.recordedValue+=mid*volume;
        this.tickBar.addTrade(mid,0);this.afterStep?.();
      });
      this.afterStep?.();
    } else {
      for(let micro=1;micro<=this.microPerBar;micro++){
        this.microTicks+=1;const localSeconds=SESSION_OPEN_SECS+localBar*this.barSeconds+micro*MICRO_SECONDS;
        this.simulatedSeconds=localSeconds+day*SESSION_SECONDS;
        this.orderBook.currentTick=this.microTicks;this.orderBook.expireOrders(this.microTicks);
        this.fleet.onTick({tick:this.microTicks,simSeconds:localSeconds,history:this.microHistory});
        this.afterStep?.();const price=this.orderBook.getMidPrice();this.tickBar.addTrade(price,0);
        this.microHistory.push({price,simSecs:this.simulatedSeconds});
      }
      if(localBar===this.barsPerDay-1 && day===this.sessionDays-1)this.fleet.endDay(this.microHistory);
    }
    const point=this.makePoint();this.priceHistory.push(point);return point;
  }
  makePoint(){const close=this.orderBook.getMidPrice();const bar=this.tickBar.take(this.lastClose??close,close);this.lastClose=close;
    return {...bar,...(this.historical?{volume:this.recordedVolume,value:this.recordedValue,volumeAvailable:this.historical.hasVolume}:{}),simTimeStr:this.currentTime(),simSecs:this.simulatedSeconds,day:this.dayIndex+1,sourceTimestamp:this.historical?.timestamp||null};}
  async runFast({onDecision=null,onProgress=null}={}){
    this.start({clock:false});if(onDecision)await onDecision(0);
    while(this.running&&this.ticksDone<this.totalTicks){
      if(this.paused){await new Promise(resolve=>setTimeout(resolve,25));continue;}
      const point=this.step();this.onPulse?.([point]);
      if(this.ticksDone<this.totalTicks&&onDecision)await onDecision(this.ticksDone);
      if(this.ticksDone%5===0){onProgress?.(this.progress());await new Promise(resolve=>setTimeout(resolve,0));}
    }
    if(this.running&&this.ticksDone>=this.totalTicks)this.finish();
    return this.finished;
  }
}

