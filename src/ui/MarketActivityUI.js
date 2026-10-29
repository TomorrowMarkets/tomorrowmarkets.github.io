const count=value=>Math.round(value||0).toLocaleString('en-US');
const money=value=>Number.isFinite(value)?`$${value.toFixed(2)}`:'—';
const time=value=>value.includes('T')?value.slice(11,19):value.split(' · ').at(-1);
export class MarketActivityUI {
  constructor(bus,root=document){
    this.root=root;this.lastPrint=null;
    bus.on('SESSION_CONFIG',()=>{this.lastPrint=null;root.getElementById('market-tape')?.replaceChildren();});
    bus.on('TICK',data=>this.render(data));
  }
  set(id,value){const element=this.root.getElementById(id);if(element)element.textContent=value;}
  render(data){
    const activity=data.activity;if(!activity)return;
    const available=activity.volumeAvailable;
    this.set('market-day-volume',available?count(activity.dayVolume):'Unavailable');
    this.set('market-total-volume',available?count(activity.totalVolume):'Unavailable');
    const completed=data.priceHistory?.at(-1);
    this.set('market-bar-volume',available?count(completed?.volume):'—');
    this.set('market-last-trade',money(activity.lastPrice));
    this.set('market-activity-source',activity.source);
    const regime=activity.regime;
    this.set('market-regime',regime?`Week ${regime.week} · ${regime.name} · ${regime.segment}`:data.dataSource==='historical'?'Historical replay · recorded quotes':'Simulated market · opening');
    const cadence=activity.resolutionSeconds;
    this.set('market-data-note',data.dataSource==='historical'
      ? `${cadence?`Typical source interval: ${cadence.toLocaleString()}s. `:''}${activity.source==='Recorded interval volume'?'Each tape row is an interval total; individual prices and buy/sell sides were not supplied.':!available?'This dataset has quotes only. Load recorded trades or interval volume to show executed activity.':'Recorded prints are shown at their snapshot timestamps.'} No interpolation is added.`
      : 'Executed shares from the simulated matching engine. Latest prints shown; counters include all fills.');
    const bids=data.bids||[],asks=data.asks||[];
    const buy=bids.reduce((sum,row)=>sum+row.qty,0),sell=asks.reduce((sum,row)=>sum+row.qty,0);
    this.set('market-depth',`${count(buy)} bid / ${count(sell)} ask shares`);
    this.set('market-imbalance',`${buy+sell?((buy-sell)/(buy+sell)*100).toFixed(0):0}%`);
    const prints=activity.prints||[],key=`${activity.source}:${prints[0]?.id||0}`;
    if(key===this.lastPrint)return;this.lastPrint=key;
    const list=this.root.getElementById('market-tape');if(!list)return;
    if(!prints.length){const empty=this.root.createElement('p');empty.className='empty';empty.textContent=available?'Waiting for executions…':'No recorded trades supplied.';list.replaceChildren(empty);return;}
    list.replaceChildren(...prints.slice(0,12).map(print=>{
      const row=this.root.createElement('div');row.className=`market-print ${print.side==='BUY'?'t-bid':print.side==='SELL'?'t-ask':'t-muted'}`;
      const values=[time(print.timestamp),print.kind==='interval'?'Interval':print.side==='UNKNOWN'?'Trade':print.side,money(print.price),count(print.qty)];
      values.forEach(value=>{const cell=this.root.createElement('span');cell.textContent=value;row.append(cell);});
      return row;
    }));
  }
}
