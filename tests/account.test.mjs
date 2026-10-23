import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {AccountManager,authenticationFailure,startAccountService} from '../dist/account-service.mjs';
const memory=()=>{const values=new Map();return {values,get:async k=>values.get(k)??null,set:async(k,v)=>{values.set(k,v);},delete:async k=>{values.delete(k);}};};
async function fixture(t,fetchImpl){const dir=await mkdtemp(join(tmpdir(),'en-account-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=memory();return {dir,store,manager:new AccountManager({home:dir,dataDir:dir,store,fetchImpl})};}
test('account persists outside games, restores once and never returns credentials in status',async t=>{
 let calls=0;const {dir,store,manager}=await fixture(t,async(url,init)=>{calls++;assert.equal(url,'https://api.en.cx/login');assert.equal(init.redirect,'error');assert.equal(JSON.parse(init.body).password,'synthetic-secret');return Response.json({token:'synthetic-token-'+calls});});
 await manager.login({domain:'demo.en.cx',username:'Автор',password:'synthetic-secret'});
 const raw=await readFile(join(dir,'profiles.json'),'utf8');assert(!raw.includes('synthetic-secret'));assert(!raw.includes('synthetic-token'));
 assert.equal((await manager.status()).connected,true);assert(!JSON.stringify(await manager.status()).includes('synthetic'));
 assert.equal((await manager.recover()).status,'restored');assert.equal(calls,2);
 assert.equal((await manager.recover()).status,'login-required');assert.equal(calls,2);
 const restarted=new AccountManager({home:dir,dataDir:dir,store});assert.equal((await restarted.status()).connected,true);
 await restarted.forget();assert.equal(store.values.size,0);assert.equal((await restarted.status()).connected,false);
});
test('invalid credentials request correction without overwriting saved values; network failure preserves account',async t=>{
 let mode='ok';const {manager,store}=await fixture(t,async()=>{if(mode==='network')throw Error('secret-bearing diagnostics');return mode==='ok'?Response.json({token:'old-token'}):new Response('',{status:401});});
 await manager.login({domain:'demo.en.cx',username:'author',password:'old-password'});const before=[...store.values];
 mode='bad';await assert.rejects(manager.login({domain:'demo.en.cx',username:'author',password:'wrong'}),/Вход отклонён/);assert.deepEqual([...store.values],before);assert.equal((await manager.status()).connected,false);
 mode='network';await assert.rejects(manager.login({domain:'demo.en.cx',username:'author',password:'another'}),/Сеть/);assert.deepEqual([...store.values],before);assert(!manager.message.includes('secret-bearing'));
});
test('legacy login stores a scoped cookie jar and retains browser cancellation safely',async t=>{
 const {manager,store}=await fixture(t);manager.legacyLogin=async()=>({cookies:[{name:'auth',value:'synthetic',domain:'test.en.cx',path:'/',expires:-1,httpOnly:true,secure:true},{name:'foreign',value:'excluded',domain:'elsewhere.example',path:'/',expires:-1,httpOnly:true,secure:true}]});
 await manager.login({domain:'test.en.cx',username:'author',password:'legacy-secret'});
 const p=await manager.active(),jar=JSON.parse(await store.get(manager.sessionKey(p)));assert.equal(jar.cookies.length,1);assert(jar.importId);
 assert.equal((await manager.recover()).status,'login-required');
 manager.legacyLogin=async()=>{throw Error('Вход отменён');};await assert.rejects(manager.login({domain:'test.en.cx',username:'author',useSaved:true}),/отменён/);assert(await store.get(manager.sessionKey(p)));
});
test('auth classification excludes permissions, outages, rate checkpoints and uncertain writes',()=>{
 const result=message=>({isError:true,structuredContent:{error:{message}}});
 for(const message of ['Encounter API returned HTTP 401 for GET /x','Author authentication required','Legacy browser session expired; import an authorized session again','Legacy authenticated author/CAPTCHA checkpoint; no retry'])assert(authenticationFailure(result(message)));
 for(const message of ['HTTP 403','Network error','unknown-after-dispatch','Legacy human-verification checkpoint: wait 30 minutes','Legacy page/authentication unavailable'])assert(!authenticationFailure(result(message)));
 assert(!authenticationFailure({isError:false}));
});
test('account HTTP rejects cross-origin writes, wrong capability and hostile Host; recovery is coalesced',async t=>{
 let calls=0,opened=0;const manager={message:'',status:async()=>({domain:'',username:'',connected:false}),recover:async()=>{calls++;await new Promise(r=>setTimeout(r,25));return {status:'login-required'};},login:async()=>({ok:true})};
 const service=await startAccountService({manager,open:async()=>{opened++;}});t.after(()=>service.close());const u=new URL(service.url),nonce=u.pathname.split('/')[2];
 assert.equal((await fetch(service.url+'status')).status,200);
 assert.equal((await fetch(service.url+'login',{method:'POST',headers:{Origin:'https://evil.example','X-En-Agent-UI':nonce},body:'{}'})).status,403);
 assert.equal((await fetch(service.url+'login',{method:'POST',headers:{Origin:u.origin,'X-En-Agent-UI':'wrong'},body:'{}'})).status,403);
 const hostile=await new Promise((resolve,reject)=>{const r=request(service.url,{headers:{Host:'evil.example'}},response=>{response.resume();resolve(response.statusCode);});r.on('error',reject);r.end();});assert.equal(hostile,403);
 assert.equal((await fetch(u.origin+'/recover',{method:'POST'})).status,403);
 const recover=()=>fetch(u.origin+'/recover',{method:'POST',headers:{Authorization:'Bearer '+service.environment.EN_AGENT_ACCOUNT_TOKEN}});
 await Promise.all([recover(),recover()]);assert.equal(calls,1);assert.equal(opened,1);
 await recover();assert.equal(opened,1);
 assert.equal((await fetch(service.url+'login',{method:'POST',headers:{Origin:u.origin,'X-En-Agent-UI':nonce},body:'{}'})).status,200);
});

test('save account without domain, connect later from chat',async t=>{
 let calls=0;const {manager,store}=await fixture(t,async()=>{calls++;return Response.json({token:'test-token'});});
 assert.equal((await manager.login({username:'author',password:'saved-password'})).verified,false);
 assert.equal(await manager.active(),null);assert.equal(calls,0);assert.equal((await manager.status()).saved,true);assert.equal((await manager.status()).connected,false);
 assert.equal((await manager.recover()).status,'domain-required');
 assert.equal((await manager.connect('demo.en.cx')).status,'connected');assert.equal(calls,1);
 await manager.forget();assert.equal(store.values.size,0);
});

test('domain connection is authenticated and completes asynchronously',async t=>{
 const {manager}=await fixture(t,async()=>Response.json({token:'test-token'}));
 await manager.login({username:'author',password:'test-secret'});
 const service=await startAccountService({manager,open:async()=>{}});t.after(()=>service.close());const origin=new URL(service.url).origin;
 assert.equal((await fetch(origin+'/connect',{method:'POST',body:'{}'})).status,403);
 const headers={Authorization:'Bearer '+service.environment.EN_AGENT_ACCOUNT_TOKEN};
 const r=await fetch(origin+'/connect',{method:'POST',headers,body:JSON.stringify({domain:'demo.en.cx'})});assert.equal((await r.json()).status,'connecting');
 for(let i=0;i<50;i++){const status=await (await fetch(origin+'/status',{headers})).json();assert(!JSON.stringify(status).includes('test-secret'));if(status.connected)return;await new Promise(r=>setTimeout(r,10));}assert.fail('connection did not complete');
});
