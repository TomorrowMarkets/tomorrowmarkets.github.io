import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../src/services/data-catalog.js';
import { APP_CONFIG } from '../src/config/app-config.js';
const storage='https://jpsdqawilipmsineoufz.supabase.co';
const options=path=>({fetchImpl:async()=>({ok:true,json:async()=>({version:1,portfolios:[{id:'real',label:'Real portfolio',path}]})})});
test('the supplied PayPal hosted button is configured',()=>{
 const url=new URL(APP_CONFIG.donations.url);assert.equal(url.origin,'https://www.paypal.com');assert.equal(url.searchParams.get('hosted_button_id'),'RM3VV34FJVZKU');
});
test('the exact configured public storage origin is allowed',async()=>{
 const url=storage+'/storage/v1/object/public/tm-market-data/portfolio/yahoo-30.json';
 const result=await loadCatalog('./data/manifest.json','https://tomorrowmarkets.github.io/index.html',options(url));assert.equal(result.portfolios[0].url,url);
});
test('lookalike origins, credentials and untrusted external hosts are rejected',async()=>{
 for(const url of ['https://jpsdqawilipmsineoufz.supabase.co.evil.invalid/data.json','https://other.supabase.co/data.json','http://jpsdqawilipmsineoufz.supabase.co/data.json','https://user:password@jpsdqawilipmsineoufz.supabase.co/data.json'])
  await assert.rejects(loadCatalog('./data/manifest.json','https://tomorrowmarkets.github.io/index.html',options(url)),/trusted HTTPS/);
});
test('existing relative demo paths and repository subdirectories remain valid',async()=>{
 const result=await loadCatalog('./data/manifest.json','https://example.test/markets/index.html',options('portfolio/demo-30.json'));
 assert.equal(result.portfolios[0].url,'https://example.test/markets/data/portfolio/demo-30.json');
});
