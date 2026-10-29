import { getClient, ensureSession } from './leaderboard-api.js';
export const BOARD_STORAGE = 'tomorrowMarkets.boards.v2';

import { SESSION_DAY_OPTIONS,DURATION_OPTIONS,PORTFOLIO_ROUND_OPTIONS } from '../engine/session.js';
export function boardDimensions(input = {}) {
  const challenge = ['trading','portfolio','backtest','arena'].includes(input.challenge) ? input.challenge : 'trading';
  const legacy=Number(input.version)===2;
  const value={version:legacy?2:3,challenge,
    strategy:challenge==='portfolio'?'discretionary':challenge==='arena'?'rl':challenge==='backtest'&&input.strategy!=='simple'?'algorithmic':['discretionary','algorithmic','simple','rl'].includes(input.strategy)?input.strategy:'discretionary',
    source:['portfolio','backtest'].includes(challenge)?'historical':challenge==='arena'?'simulated':['simulated','historical'].includes(input.source)?input.source:'simulated',
    sessionDays:challenge==='portfolio'?365:(legacy?[1,5]:SESSION_DAY_OPTIONS).includes(input.sessionDays)?input.sessionDays:5,
    barMinutes:challenge==='portfolio'?0:[0.25,5,10,15].includes(input.barMinutes)?input.barMinutes:5,
    durationMinutes:challenge==='backtest'||(challenge==='portfolio'&&!legacy)?0:(legacy?[10,15,20]:DURATION_OPTIONS).includes(input.durationMinutes)?input.durationMinutes:20,
    playMode:input.playMode==='multi'?'multi':'single',
    roundDays:challenge==='portfolio'&&input.roundDays===1?1:5,
    datasetId:String(input.datasetId||(input.source==='historical'?'historical':legacy?'simulation-v2':'simulation-v3')).replace(/[^A-Za-z0-9_.-]/g,'').slice(0,100)||'dataset'
  };
  if(!legacy)value.roundSeconds=challenge==='portfolio'?(PORTFOLIO_ROUND_OPTIONS.includes(input.roundSeconds)?input.roundSeconds:30):0;
  return value;
}
export const boardKey = input => {
 const d=boardDimensions(input),parts=[d.version,d.challenge,d.strategy,d.source,d.sessionDays,d.barMinutes,d.durationMinutes,d.playMode,d.roundDays,d.datasetId];
 if(d.version===3)parts.push(d.roundSeconds);return parts.join('|');
};
export const boardURL = dimensions => 'leaderboard.html?'+new URLSearchParams(boardDimensions(dimensions)).toString();

export function recordDeviceResult(dimensions,result,storage=globalThis.localStorage) {
  if(!Number.isFinite(result.returnPct))throw new Error('The score must be finite.');
  const key=boardKey(dimensions);
  let rows=[];try{rows=JSON.parse(storage.getItem(BOARD_STORAGE)||'[]');if(!Array.isArray(rows))rows=[];}catch{}
  const entry={id:globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random()}`,board:key,dimensions:boardDimensions(dimensions),
    handle:String(result.handle||'Trader').slice(0,16),return_pct:result.returnPct,pnl:result.pnl||0,
    max_drawdown:result.maxDrawdown||0,achieved_at:new Date().toISOString(),metadata:result.metadata||{},scope:'device'};
  rows.push(entry);rows=rows.slice(-1000);storage.setItem(BOARD_STORAGE,JSON.stringify(rows));
  const rank=rows.filter(r=>r.board===key).sort((a,b)=>b.return_pct-a.return_pct||a.achieved_at.localeCompare(b.achieved_at)).findIndex(r=>r.id===entry.id)+1;
  return {rank,scope:'device',entry};
}
export function deviceRows(dimensions,storage=globalThis.localStorage){
  try{return JSON.parse(storage.getItem(BOARD_STORAGE)||'[]').filter(r=>r.board===boardKey(dimensions))
    .sort((a,b)=>b.return_pct-a.return_pct||a.achieved_at.localeCompare(b.achieved_at)).map((r,i)=>({...r,rank:i+1}));}catch{return [];}
}

async function budget(promise,ms=12000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The shared leaderboard did not answer.')),ms);})]);}finally{clearTimeout(timer);}}
export function createBoardRun(dimensions){
  const normalized=boardDimensions(dimensions);
  const ticket=budget((async()=>{const sb=await getClient();if(!sb)return null;await ensureSession(sb);
    const {data,error}=await sb.rpc('tm_start_run_v2',{p_dimensions:normalized});if(error)throw error;return {sb,id:data};})()).catch(()=>null);
  let finished=false;
  return {dimensions:normalized,async finish(result){
    if(finished)return null;finished=true;
    let local=null;try{local=recordDeviceResult(normalized,result);}catch{}
    const run=await ticket;if(!run)return local;
    try{const {data,error}=await budget(run.sb.rpc('tm_finish_run_v2',{p_run_id:run.id,p_handle:result.handle,
      p_return_pct:result.returnPct,p_pnl:result.pnl||0,p_max_drawdown:result.maxDrawdown||0,p_metadata:result.metadata||{}}));
      if(error)throw error;return {...data,scope:'shared'};
    }catch{return local;}
  }};
}

export async function fetchBoard(dimensions){
  const sb=await budget(getClient());if(!sb)throw new Error('Shared boards are not configured.');
  await budget(ensureSession(sb));
  const {data,error}=await budget(sb.rpc('tm_board_v2',{p_dimensions:boardDimensions(dimensions)}));
  if(error){console.warn('[leaderboards]',error.message);throw new Error('Shared results are not available right now. You can view results saved on this device.');}
  return data||[];
}
