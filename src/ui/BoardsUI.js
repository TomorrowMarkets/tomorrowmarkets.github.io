import { boardDimensions, boardURL, deviceRows, fetchBoard } from '../services/boards.js';
import { mountSettingsButtons } from './theme.js';
import { loadCatalog } from '../services/data-catalog.js';
import { APP_CONFIG } from '../config/app-config.js';
mountSettingsButtons();
const $=id=>document.getElementById(id);
const query=Object.fromEntries(new URLSearchParams(location.search));
if(query.scope==='device')$('board-scope').value='device';
const fields=['version','roundSeconds','challenge','strategy','source','sessionDays','barMinutes','durationMinutes','playMode','roundDays','datasetId'];
for(const key of fields)if(query[key]!=null)$(key).value=query[key];
let request=0;
function dimensions(){const data={};for(const key of fields)data[key]=['version','roundSeconds','sessionDays','barMinutes','durationMinutes','roundDays'].includes(key)?Number($(key).value):$(key).value;return boardDimensions(data);}
async function load(){
 const seq=++request,d=dimensions();history.replaceState(null,'',boardURL(d));
 for(const key of fields)if(!['sessionDays','barMinutes','durationMinutes'].includes(key))$(key).value=String(d[key]);
 for(const key of ['strategy','sessionDays','barMinutes'])$(key).parentElement.hidden=d.challenge==='portfolio';
 $('durationMinutes').parentElement.hidden=d.challenge==='backtest'||(d.challenge==='portfolio'&&d.version===3);$('roundSeconds').parentElement.hidden=d.challenge!=='portfolio'||d.version===2;$('roundDays').parentElement.hidden=d.challenge!=='portfolio';
 $('board-status').textContent='Loading results…';$('board-rows').replaceChildren();
 let rows,scope=$('board-scope').value;
 try{rows=scope==='device'?deviceRows(d):await fetchBoard(d);}catch(err){if(seq!==request)return;$('board-status').textContent=err.message;return;}
 if(seq!==request)return;
 $('board-status').textContent=`${scope==='device'?'Results saved on this device':'Community results · client-reported scores'} · ${rows.length} entries. Historical periods can differ; compare the dates and dataset.`;
 for(const row of rows){const tr=document.createElement('tr');
  const values=[row.rank,row.handle,`${Number(row.return_pct).toFixed(2)}%`,`$${Number(row.pnl).toFixed(2)}`,`${Number(row.max_drawdown||0).toFixed(2)}%`,row.metadata?.windowStart&&row.metadata?.windowEnd?`${row.metadata.windowStart} → ${row.metadata.windowEnd}`:'—',new Date(row.achieved_at).toLocaleDateString()];
  values.forEach(value=>{const td=document.createElement('td');td.textContent=value;tr.append(td);});$('board-rows').append(tr);
 }
}
$('board-filters').addEventListener('submit',event=>{event.preventDefault();load();});
$('board-scope').addEventListener('change',load);
$('version').addEventListener('change',()=>{$('datasetId').value=Number($('version').value)===2?'simulation-v2':'simulation-v3';});
loadCatalog(APP_CONFIG.dataManifest).then(catalog=>{
 const list=document.createElement('datalist');list.id='board-datasets';
 for(const entry of [{id:'simulation-v3',label:'Current simulated market'},{id:'simulation-v2',label:'Previous simulated market'},...catalog.orderbooks,...catalog.portfolios]){
  const option=document.createElement('option');option.value=entry.id;option.label=entry.label;list.append(option);
 }
 document.body.append(list);$('datasetId').setAttribute('list','board-datasets');
}).catch(()=>{});load();
