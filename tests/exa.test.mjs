import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exaAction,exaEnvironment,exaStore} from '../src/exa.mjs';

function memoryStore(){let value=null;return {get:async()=>value,set:async(_,v)=>{value=v;},delete:async()=>{value=null;}};}
test('saved key overrides environment only for child, replacement and deletion preserve fallback',async()=>{
  const store=memoryStore(),env={EXA_API_KEY:'environment-key',OTHER:'value'};
  assert.deepEqual(await exaEnvironment(store,env),env);
  await exaAction(store,'save',' first-key ');
  assert.equal((await exaEnvironment(store,env)).EXA_API_KEY,'first-key');
  assert.equal(env.EXA_API_KEY,'environment-key');
  assert.ok(!(await exaAction(store,'status')).message.includes('first-key'));
  await exaAction(store,'save','replacement-key');
  assert.equal((await exaEnvironment(store,env)).EXA_API_KEY,'replacement-key');
  await assert.rejects(exaAction(store,'save','bad\nkey'));
  assert.equal(await store.get(),'replacement-key');
  await exaAction(store,'delete','',{env});
  assert.deepEqual(await exaEnvironment(store,env),env);
});
test('test sends exactly one bounded search and never saves candidate or returns response content',async()=>{
  const store=memoryStore();await store.set('api-key','saved-key');let calls=0;
  const reply=await exaAction(store,'test','candidate-key',{request:async(url,options)=>{
    calls++;assert.equal(url,'https://api.exa.ai/search');assert.equal(options.redirect,'error');
    assert.equal(options.headers['x-api-key'],'candidate-key');assert.ok(options.signal);
    assert.equal(JSON.parse(options.body).numResults,1);
    return Response.json({results:[{text:'private content'}]});
  }});
  assert.equal(calls,1);assert.equal(reply.ok,true);assert.equal(await store.get(),'saved-key');assert.ok(!JSON.stringify(reply).includes('private'));
});
test('test resolves saved key before environment, status/errors never expose secrets',async()=>{
  const store=memoryStore();await store.set('api-key','saved-key');
  for(const status of [401,403,402,429,500]){
    const reply=await exaAction(store,'test','',{env:{EXA_API_KEY:'env-key'},request:async(_,options)=>{
      assert.equal(options.headers['x-api-key'],'saved-key');return new Response('secret-key',{status});
    }});assert.equal(reply.ok,false);assert.ok(!JSON.stringify(reply).includes('secret-key'));
  }
  const network=await exaAction(store,'test','',{request:async()=>{throw new Error('secret-key');}});
  assert.equal(network.ok,false);assert.ok(!JSON.stringify(network).includes('secret-key'));
  assert.equal((await exaAction(store,'test','',{request:async()=>Response.json({})})).ok,false);
  await store.delete();let calls=0;
  await assert.rejects(exaAction(store,'test','',{env:{},request:async()=>{calls++;}}));assert.equal(calls,0);
});
test('credential names isolate installations and never contain the raw installation path',()=>{
  const a=exaStore('root','installation-a'),b=exaStore('root','installation-b');
  assert.notEqual(a.prefix,b.prefix);assert.ok(!a.prefix.includes('installation-a'));
});
