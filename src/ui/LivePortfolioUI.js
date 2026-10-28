import { liveClient,getLiveState,getLiveBoard,joinLive,saveLive } from '../services/live-portfolio.js';
import { validateWeights } from '../engine/PortfolioChallenge.js';
import { mountSettingsButtons } from './theme.js';
mountSettingsButtons();
const $=id=>document.getElementById(id), money=v=>'$'+Number(v).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2});
const ny=stamp=>new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short',timeZone:'America/New_York'}).format(new Date(stamp))+' New York';
let state=null,dirty=false,inputs=[],busy=false,offset=0;
function status(message,error=false){$('live-status').textContent=message;$('live-status').classList.toggle('neg',error);}
function weights(){return inputs.map(input=>Number(input.value||0)/100);}
function totals(){const current=weights(),sum=current.reduce((a,b)=>a+b,0)*100;let valid=true;try{validateWeights(current);}catch{valid=false;}
 $('live-total').textContent=Number.isFinite(sum)?`${sum.toFixed(2)}% invested · ${Math.max(0,100-sum).toFixed(2)}% cash`:'Invalid allocation';
 $('live-save').disabled=!valid||!state?.joined||!state?.nextPeriod||busy;}
function render(force=false){
 if(!state)return;
 $('live-join-form').hidden=state.joined;
 $('live-allocation-fields').disabled=!state.joined||!state.nextPeriod;
 const account=state.account;
 $('live-capital').textContent=money(account?.capital??10000);
 $('live-return').textContent=`${Number(account?.returnPct||0).toFixed(2)}%`;
 $('live-drawdown').textContent=`${Number(account?.maxDrawdown||0).toFixed(2)}%`;
 $('live-last-settled').textContent=account?.lastSettled||'No completed periods yet';
 $('live-price-date').textContent=state.priceDate?`Latest complete adjusted closes: ${state.priceDate}`:'Waiting for the first market-data update';
 $('live-period').textContent=state.nextPeriod?`Allocate for ${state.nextPeriod.previousDate} → ${state.nextPeriod.date}. Lock: ${ny(state.nextPeriod.cutoff)}. Valuation: ${ny(state.nextPeriod.valuation)}.`:'The next trading period is not available yet.';
 if(inputs.length!==state.assets.length){$('live-assets').replaceChildren();inputs=state.assets.map((asset,i)=>{
  const row=document.createElement('tr'),name=document.createElement('th'),price=document.createElement('td'),allocation=document.createElement('td'),input=document.createElement('input');
  name.scope='row';name.textContent=`${asset.symbol} · ${asset.name}`;price.dataset.livePrice=String(i);
  Object.assign(input,{type:'number',min:'0',max:'100',step:'any',className:'field num pm-weight'});input.setAttribute('aria-label',`${asset.symbol} allocation percent`);
  input.addEventListener('input',()=>{dirty=true;totals();status('Unsaved allocation changes.');});allocation.append(input);row.append(name,price,allocation);$('live-assets').append(row);return input;
 });}
 state.assets.forEach((asset,i)=>{document.querySelector(`[data-live-price="${i}"]`).textContent=state.prices?money(state.prices[i]):'—';});
 if(force||!dirty)inputs.forEach((input,i)=>{input.value=String(Number((state.weights[i]*100).toFixed(8)));});
 $('live-history').replaceChildren(...state.history.slice(-30).reverse().map(item=>{const tr=document.createElement('tr');for(const value of [item.session_date,money(item.nav),`${Number(item.period_return).toFixed(2)}%`]){const td=document.createElement('td');td.textContent=value;tr.append(td);}return tr;}));
 totals();
}
async function refresh(force=false){
 if(busy)return;busy=true;
 try{state=await getLiveState();offset=Number(state.serverNow)-Date.now();render(force);
  if(!dirty)status(state.joined?'Your saved percentages carry forward until you save a change.':'Join the challenge to start your daily portfolio.');
  const sb=await liveClient(),{data}=await sb.auth.getUser();
  $('live-auth-state').textContent=data.user?.is_anonymous?'Guest portfolio · sign in or link an email to return on another device.':`Signed in${data.user?.email?' as '+data.user.email:''}`;
  try{const board=await getLiveBoard();$('live-board').replaceChildren(...board.slice(0,20).map(p=>{const row=document.createElement('div');row.className='pm-standing row-card';row.textContent=`${p.rank}. ${p.handle} · ${Number(p.return_pct).toFixed(2)}% · started ${p.start_session}`;return row;}));}catch{}
 }catch(error){status(error.message,true);}finally{busy=false;totals();}
}
$('live-join-form').addEventListener('submit',async event=>{event.preventDefault();try{await joinLive($('live-handle').value.trim());await refresh(true);}catch(error){status(error.message,true);}});
$('live-allocation-form').addEventListener('submit',async event=>{event.preventDefault();if(!state?.nextPeriod)return;
 try{await saveLive(state.nextPeriod.date,validateWeights(weights()));dirty=false;await refresh(true);status('Allocation saved for the next eligible trading period.');}catch(error){status(error.message,true);}});
$('live-equal').addEventListener('click',()=>{inputs.forEach((input,i)=>{input.value=i<10?'3.34':'3.33';});dirty=true;totals();});
$('live-cash').addEventListener('click',()=>{inputs.forEach(input=>{input.value='0';});dirty=true;totals();});
$('live-refresh').addEventListener('click',()=>refresh());
$('live-auth-form').addEventListener('submit',async event=>{event.preventDefault();
 try{const sb=await liveClient();const {error}=await sb.auth.signInWithPassword({email:$('live-email').value.trim(),password:$('live-password').value});if(error)throw error;$('live-password').value='';dirty=false;await refresh(true);}catch(error){status(error.message,true);}});
$('live-create-account').addEventListener('click',async()=>{
 try{const sb=await liveClient();const {error}=await sb.auth.signUp({email:$('live-email').value.trim(),password:$('live-password').value,
   options:{emailRedirectTo:new URL('live-portfolio.html',document.baseURI).href}});if(error)throw error;$('live-password').value='';status('Check your email to confirm the account, then sign in. Creating a separate account starts a separate portfolio.');}catch(error){status(error.message,true);}});
$('live-link-email').addEventListener('click',async()=>{
 try{const sb=await liveClient();const {error}=await sb.auth.updateUser({email:$('live-email').value.trim()},{emailRedirectTo:new URL('live-portfolio.html',document.baseURI).href});if(error)throw error;status('Check your email to verify this portfolio’s email address. After verification, use Set password to finish linking it.');}catch(error){status(error.message,true);}});
$('live-set-password').addEventListener('click',async()=>{
 try{const sb=await liveClient();const {error}=await sb.auth.updateUser({password:$('live-password').value});if(error)throw error;$('live-password').value='';status('Password saved. You can sign in to this portfolio on another device.');}catch(error){status(error.message,true);}});
setInterval(()=>{if(!state?.nextPeriod)return;const ms=Date.parse(state.nextPeriod.cutoff)-Date.now()-offset;$('live-countdown').textContent=ms>0?`${Math.floor(ms/3600000)}h ${Math.floor(ms/60000)%60}m until allocations lock`:'Allocation cutoff reached. Refreshing the next period…';if(ms<=0)refresh();},1000);
setInterval(()=>refresh(),60000);refresh();
