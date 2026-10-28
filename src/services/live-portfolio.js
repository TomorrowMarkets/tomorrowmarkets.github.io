import { getClient, ensureSession } from './leaderboard-api.js';
export async function liveClient(){const sb=await getClient();if(!sb)throw new Error('Daily portfolios are not available yet.');await ensureSession(sb);return sb;}
export async function liveRPC(name,params={}){let timer;try{
 const response=(async()=>{const sb=await liveClient();return sb.rpc(name,params);})();
 const {data,error}=await Promise.race([response,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The daily portfolio service is taking too long. Please try again.')),15000);})]);
 if(error){console.warn('[daily portfolio]',error.message);throw new Error('The daily portfolio service could not complete that request. Refresh and try again.');}return data;
 }finally{clearTimeout(timer);}}
export const getLiveState=()=>liveRPC('tm_live_state');
export const getLiveBoard=()=>liveRPC('tm_live_board');
export const joinLive=handle=>liveRPC('tm_live_join',{p_handle:handle});
export const saveLive=(session,weights)=>liveRPC('tm_submit_live',{p_session_date:session,p_weights:weights});
