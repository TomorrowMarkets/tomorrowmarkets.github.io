// Public executed activity only. Resting depth is never counted as volume.
// Recorded prints are display data and never become simulated account fills.
export class MarketActivity {
  constructor() { this.reset(); }
  reset() { this.totalVolume=0;this.dayVolume=0;this.prints=[];this.sequence=0;this.lastPrice=null;this.day=1; }
  beginDay(day) { if(day!==this.day){this.day=day;this.dayVolume=0;} }
  add({price=null,qty,side='UNKNOWN',timestamp='',kind='trade'}) {
    if(!Number.isFinite(qty)||qty<=0)return;
    this.totalVolume+=qty;this.dayVolume+=qty;
    if(Number.isFinite(price)&&price>0)this.lastPrice=price;
    this.prints.unshift({id:++this.sequence,price:Number.isFinite(price)?price:null,qty,side,timestamp,kind});
    if(this.prints.length>16)this.prints.length=16;
  }
  snapshot({historical=null,barVolume=0,regime=null}={}) {
    return {day:this.day,totalVolume:this.totalVolume,dayVolume:this.dayVolume,barVolume,lastPrice:this.lastPrice,
      prints:this.prints.slice(),volumeAvailable:historical?historical.hasVolume:true,
      source:historical?historical.hasTrades?'Recorded trades':historical.hasVolume?'Recorded interval volume':'Volume not supplied':'Simulated executions',
      resolutionSeconds:historical?.resolutionSeconds||null,regime};
  }
}
