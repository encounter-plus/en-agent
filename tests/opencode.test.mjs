import {test} from 'node:test';
import assert from 'node:assert/strict';
import {waitForMcp} from '../src/opencode.mjs';
import {validateManifest} from '../src/releases.mjs';

test('v1 releases and storage are rejected before loading files',()=>{
  const base={schemaVersion:1,id:'0.2.0',sequence:2,platform:process.platform,arch:process.arch,storageEpoch:2,opencode:{version:'1.18.10',configVersion:1}};
  assert.throws(()=>validateManifest(base),/OpenCode v2/);
  assert.throws(()=>validateManifest({...base,storageEpoch:1}),/Storage migration/);
});

test('v2 MCP readiness waits for pending and uses location-scoped response',async()=>{
  let calls=0;
  const runtime={request:async path=>{
    assert.equal(new URL('http://localhost'+path).searchParams.get('location[directory]'),'C:\\games\\Тест & игра');
    return Response.json({location:{},data:[{name:'encounter',status:{status:++calls===1?'pending':'connected'}}]});
  }};
  await waitForMcp(runtime,'C:\\games\\Тест & игра',['encounter']);assert.equal(calls,2);
  await assert.rejects(waitForMcp({request:async()=>Response.json({data:[{name:'encounter',status:{status:'failed',error:'private diagnostic'}}]})},'.',['encounter']),/^Error: encounter MCP is failed$/);
  await assert.rejects(waitForMcp({request:async()=>Response.json({encounter:{status:'connected'}})},'.',['encounter']),/Invalid OpenCode v2/);
});
