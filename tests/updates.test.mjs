import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {atomicJson,json} from '../src/storage.mjs';
import {updateChecker} from '../src/updates.mjs';
import {safeEvent} from '../src/diagnostics.mjs';

test('a Windows reader can briefly hold status.json during an atomic update',{skip:process.platform!=='win32'},async()=>{
  const home=await mkdtemp(join(tmpdir(),'en-status-reader-')),path=join(home,'status.json');
  try{
    await atomicJson(path,{stage:'before'});
    const reader=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      "$f=[IO.File]::Open($env:STATUS_FILE,'Open','Read','Read'); try { [Console]::WriteLine('reading'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 180 } finally { $f.Dispose() }"],
      {windowsHide:true,env:{...process.env,STATUS_FILE:path},stdio:['ignore','pipe','inherit']});
    const exited=once(reader,'exit');
    await once(reader.stdout,'data');
    await atomicJson(path,{stage:'after'});
    assert.equal((await exited)[0],0);
    assert.equal((await json(path)).stage,'after');
  }finally{await rm(home,{recursive:true,force:true});}
});
test('startup and button share work, report independent outcomes, and can retry',async()=>{
  const home=await mkdtemp(join(tmpdir(),'en-check-'));
  try{
    const configured={manifestUrl:'https://github.com/encounter-plus/en-agent-updates/releases/latest/download/channel.json',publicKey:'fixture'};
    await atomicJson(join(home,'channel.json'),configured);
    const events=[];
    let calls=0,finish;
    const gate=new Promise(resolve=>{finish=resolve;});
    const checker=updateChecker(home,{root:home,manifest:{minimumSkillsVersion:'0.1.0'}},{
      signal:new AbortController().signal,progress:fields=>events.push(safeEvent(fields)),
      appUpdate:async(home,channel)=>{assert.deepEqual(channel,configured);await gate;return {status:'staged',id:'1.1.1'};},
      skillsUpdate:async()=>{if(++calls===1)throw Error('offline');return {status:'current',version:'1.2.3'};}
    });
    const startup=checker.check();
    assert.equal(checker.check(),startup);
    assert.equal((await startup.skills).status,'failed');
    finish();await startup.done;
    assert.ok(events.some(e=>e.app?.id==='1.1.1'));
    await checker.check().done;
    assert.equal(calls,2);
    assert.ok(events.some(e=>e.skills?.version==='1.2.3'));
  }finally{await rm(home,{recursive:true,force:true});}
});
