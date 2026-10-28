import { random, gauss } from './random.js';

// Prices are not forced toward Gaussian returns. These bounded shocks add
// clustered volatility, temporary liquidity withdrawal and time-varying flow.
export const EVENT_TYPES = [
  {id:'earnings',name:'Earnings surprise',jump:0.008,vol:1.8,liquidity:0.8,minutes:50},
  {id:'macro',name:'Macro data release',jump:0.004,vol:2.2,liquidity:0.75,minutes:35},
  {id:'flow',name:'Large fund rebalance',jump:0.002,vol:1.25,liquidity:1.1,minutes:80},
  {id:'liquidity',name:'Temporary liquidity withdrawal',jump:0.001,vol:1.5,liquidity:0.45,minutes:25},
  {id:'rumour',name:'Unconfirmed market rumour',jump:0.003,vol:1.4,liquidity:0.9,minutes:40}
];
export class MarketEvents {
  constructor({randomFn=random,gaussian=gauss,onNews=null}={}) {this.random=randomFn;this.gaussian=gaussian;this.onNews=onNews;this.reset();}
  reset(){this.active=null;this.nextEligible=0;}
  step(seconds,stepSeconds=15){
    let jump=0;
    if(this.active && seconds>=this.active.until)this.active=null;
    // About 0.7 unscheduled events per active market hour, with a cooldown.
    if(!this.active && seconds>=this.nextEligible && this.random()<1-Math.exp(-0.7*stepSeconds/3600)){
      const event=EVENT_TYPES[Math.min(EVENT_TYPES.length-1,Math.floor(this.random()*EVENT_TYPES.length))];
      jump=Math.max(-2.5,Math.min(2.5,this.gaussian()))*event.jump;
      this.active={...event,start:seconds,until:seconds+event.minutes*60};
      this.nextEligible=this.active.until+20*60;
      this.onNews?.(`${event.name}: ${Math.abs(jump*100).toFixed(2)}% ${jump>=0?'upward':'downward'} fair-value shock; conditions will fade.`);
    }
    const fade=this.active?Math.max(0,1-(seconds-this.active.start)/(this.active.until-this.active.start)):0;
    return {jump,volatility:1+((this.active?.vol||1)-1)*fade,
      liquidity:1+((this.active?.liquidity||1)-1)*fade,event:this.active?.id||null};
  }
}
