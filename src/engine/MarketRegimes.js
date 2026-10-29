import { random } from './random.js';

// Stylised scenarios, not fitted forecasts. Regimes persist across sessions;
// participation also changes within each session. No future state is exposed.
export const REGIMES = {
  balanced:{name:'Balanced',volatility:1,liquidity:1,activity:1,trendWeight:1,reversionWeight:1,drift:0},
  trend:{name:'Directional flow',volatility:1.15,liquidity:0.95,activity:1.2,trendWeight:1.5,reversionWeight:0.75,drift:0.000012},
  range:{name:'Range trading',volatility:0.72,liquidity:1.2,activity:0.85,trendWeight:0.65,reversionWeight:1.5,drift:0},
  stress:{name:'Risk reduction',volatility:1.65,liquidity:0.68,activity:1.45,trendWeight:1.2,reversionWeight:0.65,drift:0.000008},
  recovery:{name:'Liquidity recovery',volatility:0.9,liquidity:1.15,activity:1.05,trendWeight:0.8,reversionWeight:1.25,drift:0.000004}
};
const choices={balanced:['balanced','range','trend','stress'],trend:['trend','balanced','stress','range'],range:['range','balanced','trend'],stress:['stress','recovery','recovery','balanced'],recovery:['recovery','balanced','range','trend']};
export function sessionSegment(seconds,open=34200,close=64800){
  const elapsed=Math.max(0,seconds-open),remaining=close-seconds;
  if(elapsed<60*60)return {id:'opening',name:'Opening price discovery',activity:1.3,volatility:1.18,liquidity:0.9};
  if(remaining<=60*60)return {id:'closing',name:'Closing rebalance',activity:1.4,volatility:1.1,liquidity:1.05};
  if(seconds>=14.5*3600&&seconds<15.5*3600)return {id:'overlap',name:'US market overlap',activity:1.25,volatility:1.15,liquidity:1.08};
  if(seconds>=11.5*3600&&seconds<13.5*3600)return {id:'midday',name:'Midday lull',activity:0.62,volatility:0.8,liquidity:1.08};
  return {id:'continuous',name:'Continuous trading',activity:1,volatility:1,liquidity:1};
}
// Integral of a simple U-shaped execution volume curve, normalised to [0,1].
export function volumeSchedule(progress){const x=Math.max(0,Math.min(1,progress));return (2.3*x-3.6*x*x+2.4*x*x*x)/1.1;}
export class MarketRegimes {
  constructor({randomFn=random,open=34200,close=64800,onChange=null}={}){
    this.random=randomFn;this.open=open;this.close=close;this.onChange=onChange;
    this.id='balanced';this.day=0;this.direction=1;this.untilDay=0;this.nextShift=Infinity;this.lastSegment=null;
  }
  pick(){const pool=choices[this.id];return pool[Math.min(pool.length-1,Math.floor(this.random()*pool.length))];}
  nextDay(){
    this.day+=1;
    if(this.day>=this.untilDay){this.id=this.pick();this.direction=this.random()<0.5?-1:1;this.untilDay=this.day+2+Math.floor(this.random()*3);}
    // A possible intraday regime change, not a compulsory daily shock.
    this.nextShift=this.open+(90+this.random()*210)*60;this.shiftPending=this.random()<0.45;this.lastSegment=null;
  }
  step(seconds){
    if(!this.day)this.nextDay();
    if(this.shiftPending&&seconds>=this.nextShift){this.id=this.pick();this.shiftPending=false;this.onChange?.(`Market environment: ${REGIMES[this.id].name.toLowerCase()}.`);}
    const base=REGIMES[this.id],segment=sessionSegment(seconds,this.open,this.close);
    if(segment.id!==this.lastSegment){this.lastSegment=segment.id;this.onChange?.(`${segment.name}. Participation and liquidity are changing.`);}
    return {...base,id:this.id,day:this.day,week:Math.ceil(this.day/5),segment:segment.name,segmentId:segment.id,
      activity:base.activity*segment.activity,volatility:base.volatility*segment.volatility,
      liquidity:base.liquidity*segment.liquidity,drift:base.drift*this.direction};
  }
}
