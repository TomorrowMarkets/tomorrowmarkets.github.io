// Isolated DOM/transport integration checks. The engines and AI are real; selected UI and online services are stubbed.
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { APP_CONFIG } from '../src/config/app-config.js';
import {fileURLToPath} from 'node:url';

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const uiStubs = new Set(['src/ui/PriceChart.js','src/ui/theme.js','src/ui/player-name.js','src/ui/lobby-facts.js','src/ui/AlgoLabUI.js','src/ui/AlgoActionLogUI.js','src/ui/TradeHistoryUI.js','src/services/public-lobby.js']);
const sourceRoot = base;
const fallbackRoot = path.join(base, 'tests/fixtures');
const structure = JSON.parse(readFileSync(path.join(base,'tests/fixtures/dom.json')));

class Element {
  constructor(tag, attrs = {}, text = '', owner = null) {
    this.tagName = String(tag).toUpperCase(); this.attrs = {...attrs}; this._text = text;
    this.children = []; this.parentNode = null; this.ownerDocument = owner;
    this.listeners = {}; this.dataset = {}; this.style = {}; this.disabled = 'disabled' in attrs;
    this.hidden = 'hidden' in attrs; this.open = false; this.clientWidth = 0; this.clientHeight = 0;
    this._value = attrs.value ?? null;
    for (const [key, val] of Object.entries(attrs)) if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val;
    this.classList = { add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(n => !names.includes(n)).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, value) => {const yes = value ?? !this.classList.contains(name); if (yes) this.classList.add(name); else this.classList.remove(name); return yes;} };
  }
  get id() { return this.attrs.id || ''; } set id(v) { this.attrs.id = v; }
  get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = v; }
  get value() {
    if (this._value != null) return this._value;
    if (this.tagName === 'SELECT') return (this.children.find(c => 'selected' in c.attrs) || this.children[0])?.value || '';
    if (this.tagName === 'OPTION') return this.attrs.value ?? this.textContent;
    return '';
  }
  set value(v) { this._value = String(v); }
  get selectedOptions() { return this.children.filter(c => c.value === this.value); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerText() { return this.textContent; } set innerText(v) { this.textContent = v; }
  set innerHTML(v) { this._html = v; this.children = []; this._text = v.replace(/<[^>]*>/g,''); } get innerHTML() { return this._html || ''; }
  get firstChild() { return this.children[0]; }
  append(...children) { for (const child of children) { child.parentNode = this; child.ownerDocument ||= this.ownerDocument; this.children.push(child); } }
  appendChild(child) { this.append(child); return child; }
  add(child) { this.append(child); }
  replaceChildren(...children) {this.children = []; this._text = ''; this._value = null; this.append(...children);}
  setAttribute(k, v) {this.attrs[k] = String(v);} removeAttribute(k) {delete this.attrs[k];}
  getAttribute(k) {return this.attrs[k] ?? null;}
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) {
      const key = attribute[1].startsWith('data-') ? attribute[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()) : null;
      const value = key ? this.dataset[key] : this.attrs[attribute[1]];
      return attribute[2] == null ? value != null : value === attribute[2];
    }
    return this.tagName.toLowerCase() === selector;
  }
  querySelectorAll(selector) {const out = []; for (const child of this.children) {if(child.matches(selector))out.push(child);out.push(...child.querySelectorAll(selector));}return out;}
  querySelector(selector) {return this.querySelectorAll(selector)[0] || null;}
  contains(child) {return child === this || this.children.some(c => c.contains(child));}
  addEventListener(event, fn) {(this.listeners[event] ||= []).push(fn);}
  removeEventListener() {}
  async dispatch(event) { for (const fn of this.listeners[event] || []) await fn({target:this,preventDefault(){},key:''}); }
  async click() {if(!this.disabled) await this.dispatch('click');}
  focus() {this.ownerDocument.activeElement = this;}
  remove() {if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(c=>c!==this);}
  showModal() {this.open = true;} close(){this.open=false;this.dispatch('close');}
  getBoundingClientRect(){return {left:0,top:0,right:100,bottom:100};}
  getContext(){return null;}
}

function documentFixture() {
  const doc = { baseURI:'https://fixture.test/markets/index.html', readyState:'complete', hidden:false,
    activeElement:null, listeners:{}, addEventListener(event,fn){(this.listeners[event] ||= []).push(fn);},
    createElement(tag){return new Element(tag,{},'',this);} };
  const build = raw => {const el = new Element(raw.tag, raw.attrs, raw.text, doc);el.append(...raw.children.map(build));return el;};
  const root = build(structure);
  doc.getElementById = id => root.id === id ? root : root.querySelector('#'+id);
  doc.querySelector = sel => root.querySelector(sel);
  doc.querySelectorAll = sel => root.querySelectorAll(sel);
  return doc;
}

const defer = () => new Promise(resolve => setImmediate(resolve));
const rooms = new Map();
let uniqueConnection = 0;
class Network {
  constructor(bus){this.bus = bus;this.connections=[];this.messages=[];}
  close(){}
  async initHost(code){this.code=code;this.isHost=true;rooms.set(code,this);return true;}
  async initClient(code){const host=rooms.get(code);if(!host)return false;this.host=host;this.connection={id:++uniqueConnection,client:this,open:true};host.connections.push(this.connection);queueMicrotask(()=>this.bus.emit('NET_HOST_CONNECTED'));return true;}
  send(conn,data){this.messages.push(structuredClone(data));queueMicrotask(()=>conn.client.bus.emit('NET_DATA_RECEIVED',{data:structuredClone(data)}));}
  broadcast(data){if(this.isHost){for(const conn of this.connections)this.send(conn,data);}else if(this.host){const host=this.host;const conn=this.connection;queueMicrotask(()=>host.bus.emit('NET_DATA_RECEIVED',{conn,data:structuredClone(data)}));}}
}

async function app() {
  const doc = documentFixture();
  let currentTime = 1800000000000;
  const timers = new Map(); let serial = 0;
  const errors = [];
  const storage = () => ({getItem(){return null;},setItem(){},removeItem(){}});
  class TestDate extends Date {static now(){return currentTime;}}
  const ctx = vm.createContext({
    console:{...console,warn(){},error:(...args)=>errors.push(args)}, Date:TestDate, document:doc,
    URL, URLSearchParams, Blob, AbortController, atob, btoa, performance:{now:()=>currentTime},
    localStorage:storage(),sessionStorage:storage(),
    setInterval:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;},clearInterval:id=>timers.delete(id),
    setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms,timeout:true,scheduled:currentTime+ms});return id;},clearTimeout:id=>timers.delete(id),
    requestAnimationFrame:()=>0,cancelAnimationFrame(){},getComputedStyle:()=>({getPropertyValue:()=>''}),
    Option:function(label,value){return new Element('option',{value},label,doc);},
    window:{addEventListener(){},removeEventListener(){},matchMedia:()=>({matches:false}),location:{reload(){}}},
    fetch:async(url)=>{
      const u=new URL(String(url),doc.baseURI);const local=path.join(sourceRoot,u.pathname.replace(/^\/markets\//,''));
      return {ok:existsSync(local),status:existsSync(local)?200:404,json:async()=>JSON.parse(readFileSync(local,'utf8'))};
    },
    __Network:Network
  });
  const modules = new Map();
  async function module(filename) {
    if(modules.has(filename))return modules.get(filename);
    let content;
    if(filename === '/src/net/PeerNetwork.js')content='export class PeerNetwork extends __Network {}';
    else if(filename === '/src/services/leaderboard-api.js') content='export const getClient=async()=>null;export const ensureSession=async()=>{};';
    else {
      const local=path.join(sourceRoot,filename);const fallback=path.join(fallbackRoot,filename);
      content=readFileSync(uiStubs.has(filename.slice(1))?fallback:existsSync(local)?local:fallback,'utf8');
    }
    const mod=new vm.SourceTextModule(content,{context:ctx,identifier:filename});modules.set(filename,mod);
    return mod;
  }
  const main=await module('/src/main.js');await main.link((specifier,referencing)=>module(path.posix.resolve(path.posix.dirname(referencing.identifier),specifier)));await main.evaluate();await defer();
  return {doc,errors,async click(id){await doc.getElementById(id).click();await defer();},
    async event(id,name){await doc.getElementById(id).dispatch(name);await defer();},
    async advance(ms){currentTime+=ms;for(const [id,t] of [...timers]){if(t.timeout){if(t.scheduled>currentTime)continue;timers.delete(id);}await t.fn();}await defer();},
    async choose(kind,mode){await this.click(kind==='solo'?'btn-single-player':kind==='host'?'btn-host-multiplayer':'btn-join-multiplayer');await defer();await this.click('mode-'+mode);await defer();}
  };
}

const support=await app();
await support.doc.querySelector('[data-support]').click();
assert.equal(support.doc.getElementById('support-dialog').open,true);
const payment=support.doc.querySelector('[data-donation-link]');
if(APP_CONFIG.donations.url){
 assert.equal(payment.hidden,false);assert.equal(payment.href,new URL(APP_CONFIG.donations.url).href);
 assert.match(support.doc.querySelector('[data-donation-status]').textContent,/creator/);
}else{
 assert.match(support.doc.querySelector('[data-donation-status]').textContent,/coming soon/);assert.equal(payment.hidden,true);
}
console.log('PASS support displays exactly the configured payment destination');

const solo=await app();await solo.choose('solo','portfolio');
assert.equal(solo.doc.getElementById('portfolio-screen').classList.contains('hidden'),false);
assert.equal(solo.doc.getElementById('pm-assets').children.length,30);
assert.match(solo.doc.getElementById('pm-source').textContent,/DEMO/);
await solo.click('pm-equal');await solo.event('pm-form','submit');
assert.match(solo.doc.getElementById('pm-status').textContent,/saved/);
await solo.advance(30000);
assert.equal(solo.doc.getElementById('pm-round').textContent.startsWith('2 /'),true);
const saved=solo.doc.getElementById('pm-weight-0').value;
await solo.advance(30000);
assert.equal(solo.doc.getElementById('pm-weight-0').value,saved);
solo.doc.getElementById('pm-weight-0').value='101';await solo.event('pm-weight-0','input');
assert.equal(solo.doc.getElementById('pm-save').disabled,true);
console.log('PASS solo portfolio routes, saves and carries weights; rejects >100%');

const host=await app();host.doc.getElementById('trader-name-input').value='Host';await host.choose('host','portfolio');
const code=host.doc.getElementById('display-room-code').textContent;
const client=await app();client.doc.getElementById('trader-name-input').value='Guest';client.doc.getElementById('room-code-input').value=code;
await client.choose('join','portfolio');await defer();await defer();
assert.match(host.doc.getElementById('player-count').textContent,/2 Players/);
await host.click('btn-start-game');await defer();
assert.equal(client.doc.getElementById('pm-window').textContent,host.doc.getElementById('pm-window').textContent);
assert.equal(client.doc.getElementById('pm-assets').children.length,30);
await client.click('pm-equal');await client.event('pm-form','submit');await defer();await defer();
assert.match(client.doc.getElementById('pm-status').textContent,/saved/);
await host.advance(30000);await defer();
assert.equal(host.doc.getElementById('pm-capital').textContent,'$10,000.00');
assert.notEqual(client.doc.getElementById('pm-capital').textContent,'$10,000.00');
assert.equal(client.doc.getElementById('pm-date').textContent,host.doc.getElementById('pm-date').textContent);
const transport=rooms.get(code);
const snapshotMessages=transport.messages.filter(m=>m.type==='PM_STATE');
assert.ok(snapshotMessages.length>1);
assert.equal('prices' in snapshotMessages[0].snapshot,false);
console.log('PASS host/guest share year and dates but have private independent accounts');
const activeRound = Number(host.doc.getElementById('pm-round').textContent.split(' /')[0])-1;
transport.connections[0].client.broadcast({type:'PM_ALLOCATE',playerId:'Host',round:activeRound,weights:[1,...Array(29).fill(0)]});
await defer();await defer();
assert.equal(transport.messages.filter(m=>m.type==='PM_STATE').at(-1).snapshot.account.pending[0],1);
await host.advance(30000);await defer();
assert.equal(host.doc.getElementById('pm-capital').textContent,'$10,000.00');
for(let i=0;i<60 && !host.doc.getElementById('pm-title').textContent.includes('complete');i++)await host.advance(30000);
assert.equal(host.doc.getElementById('pm-title').textContent,'Portfolio challenge complete');
assert.equal(client.doc.getElementById('pm-title').textContent,'Portfolio challenge complete');
assert.equal(client.doc.getElementById('pm-save').disabled,true);
console.log('PASS a guest cannot assign the host allocation; final results reach both players');

const replay=await app();
await replay.click('btn-single-player');replay.doc.getElementById('setup-source').value='historical';await replay.event('setup-source','change');await replay.click('mode-discretionary');
assert.equal(replay.doc.getElementById('trading-screen').classList.contains('hidden'),false);
assert.match(replay.doc.getElementById('mode-badge').textContent,/Historical.*Demo/);
assert.match(replay.doc.getElementById('sim-clock').textContent,/2024-01-03/);
replay.doc.getElementById('order-qty').value='1';await replay.click('type-market-btn');await replay.click('btn-buy');
assert.equal(replay.doc.getElementById('port-shares').textContent,'1');
await replay.advance(5000);
assert.equal(replay.errors.length,0);
console.log('PASS historical discretionary launch, source clock and market order fill');
await replay.doc.querySelector('[data-ticket-qty="25"]').click();
assert.equal(replay.doc.getElementById('order-qty').value,'25');
assert.equal(replay.doc.getElementById('market-activity-source').textContent,'Recorded trades');
assert.ok(replay.doc.getElementById('market-tape').children.length>0);
assert.notEqual(replay.doc.getElementById('market-day-volume').textContent,'0');
console.log('PASS manual quick quantities and public recorded volume/tape');


const algo=await app();await algo.click('btn-single-player');algo.doc.getElementById('setup-source').value='historical';await algo.click('mode-algorithmic');
assert.equal(algo.doc.getElementById('algo-lab-screen').classList.contains('hidden'),false);
await algo.click('btn-algo-enter');assert.match(algo.doc.getElementById('mode-badge').textContent,/Algorithmic.*Historical/);
assert.equal(algo.doc.getElementById('order-entry-panel').classList.contains('algo-locked'),true);
assert.equal(algo.doc.getElementById('trading-screen').classList.contains('is-algorithmic'),true);
console.log('PASS historical algorithmic routing retains strategy-only order entry');

const simulation=await app();await simulation.choose('solo','discretionary');
assert.equal(simulation.doc.getElementById('trading-screen').classList.contains('hidden'),false);
assert.ok(Number(simulation.doc.getElementById('trader-count').textContent.replaceAll(',',''))>=1000);
await simulation.advance(1000);
assert.equal(simulation.errors.length,0);
console.log('PASS original simulated trading starts its real bot fleet');

assert.equal(host.errors.length+client.errors.length+solo.errors.length+support.errors.length+algo.errors.length,0);
const arena=await app();await arena.choose('solo','arena');await defer();
assert.equal(arena.doc.getElementById('arena-panel').hidden,false);
assert.equal(arena.doc.getElementById('positions-panel').classList.contains('hidden'),true);
assert.equal(arena.doc.getElementById('arena-standings').children.length,2);
await arena.advance(3000);assert.equal(arena.errors.length,0);
console.log('PASS the real RL arena launches with two agents and hides spectator order entry');
const backtest=await app();await backtest.click('btn-backtest');await backtest.click('mode-algorithmic');await backtest.click('btn-algo-enter');
for(let i=0;i<200 && backtest.doc.getElementById('game-over').classList.contains('hidden');i++) await backtest.advance(1);
assert.equal(backtest.doc.getElementById('backtest-controls').hidden,false);
assert.equal(backtest.errors.length,0);
assert.equal(backtest.doc.getElementById('game-over').classList.contains('hidden'),false);
assert.equal(backtest.doc.getElementById('btn-export-backtest').hidden,false);
console.log('PASS single-player backtest routing and execution start correctly');
const slower=await app();await slower.click('btn-single-player');
slower.doc.getElementById('setup-round-seconds').value='60';await slower.click('mode-portfolio');
assert.match(slower.doc.getElementById('pm-window').textContent,/60s per round/);
await slower.advance(59999);assert.ok(slower.doc.getElementById('pm-round').textContent.startsWith('1 /'));
await slower.advance(1);assert.ok(slower.doc.getElementById('pm-round').textContent.startsWith('2 /'));
console.log('PASS portfolio allocation clock honours the full selected 60 seconds');
const long=await app();await long.click('btn-single-player');
long.doc.getElementById('setup-source').value='historical';long.doc.getElementById('setup-days').value='20';
long.doc.getElementById('setup-duration').value='90';long.doc.getElementById('setup-book-dataset').value='demo-orderbook-20';
await long.click('mode-discretionary');assert.match(long.doc.getElementById('mode-badge').textContent,/90 min.*20 days/);
await long.advance(1000);assert.equal(long.errors.length,0);
console.log('PASS long historical challenge settings reach the market clock');
console.log('All integration checks passed. External services and selected UI modules were stubbed.');

