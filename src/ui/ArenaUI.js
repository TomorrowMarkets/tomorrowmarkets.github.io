export class ArenaUI {
  constructor(bus){this.root=document.getElementById('arena-panel');this.live=false;
    document.getElementById('arena-back').addEventListener('click',()=>location.reload());
    bus.on('TICK',data=>{if(this.live)this.render(data.standings||[]);});
  }
  show(learning=false){this.live=true;this.root.hidden=false;document.getElementById('arena-status').textContent=learning
    ?'Training: two independent copies of the current DQN learn during this arena.'
    :'Evaluation: two independent copies of the current DQN trade without weight updates.';}
  render(standings){const rows=standings.filter(player=>player.id.startsWith('bot:arena:'));const body=document.getElementById('arena-standings');body.replaceChildren(...rows.map((player,i)=>{
    const row=document.createElement('div');row.className='row-card arena-row';const name=document.createElement('strong');name.textContent=`${i+1}. ${player.name||player.id}`;
    const pnl=document.createElement('span');pnl.className=`num ${player.total>=0?'pos':'neg'}`;pnl.textContent=`${player.total>=0?'+':'−'}$${Math.abs(player.total).toFixed(2)} · ${player.shares} shares`;
    row.append(name,pnl);return row;}));}
  finish(results){this.render(results.standings);const winner=results.standings.find(player=>player.id.startsWith('bot:arena:'));document.getElementById('arena-status').textContent=winner?`${winner.name||winner.id} finished first. Results are saved on this device.`:'Arena complete.';document.getElementById('arena-back').hidden=false;}
}
