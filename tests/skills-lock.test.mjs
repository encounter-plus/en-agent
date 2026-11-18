import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {lockSkills} from '../src/skills-lock.mjs';

test('installation paths with Unicode quotes are passed as data',{skip:process.platform!=='win32'},async()=>{
 const home=await mkdtemp(join(tmpdir(),"skills-O’Connor-O‘Connor-O'Connor-"));let guard;
 try{
  guard=await lockSkills(home);await guard.commit({version:'first'});await guard.commit({version:'second'});
  assert.deepEqual(JSON.parse(await readFile(join(home,'state.json'),'utf8')),{version:'second'});
 }finally{await guard?.release();await rm(home,{recursive:true,force:true});}
});

test('OS skills lock excludes writers and is released when the writer is forcibly stopped',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const home=await mkdtemp(join(tmpdir(),'skills-mutex-'));let child;
 try {
  await writeFile(join(home,'powershell.exe'),'synthetic invalid executable: must never run');
  child=spawn(process.execPath,['--input-type=module','-e',`import {lockSkills} from ${JSON.stringify(new URL('../src/skills-lock.mjs',import.meta.url).href)};await lockSkills(process.argv[1]);console.log('ready');setInterval(()=>{},1000);`,home],{cwd:home,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const [bytes]=await once(child.stdout,'data');assert.match(bytes.toString(),/ready/);
  await assert.rejects(lockSkills(home),{code:'SKILLS_BUSY',message:'Skills update is already running'});
  const stopped=once(child,'exit');child.kill();await stopped;
  let release;
  for(let attempt=0;attempt<20&&!release;attempt++){
   try{release=await lockSkills(home);}catch(error){if(!error.message.includes('already running'))throw error;await new Promise(done=>setTimeout(done,100));}
  }
  assert.ok(release,'OS lock must recover without owner metadata');await release.release();
  const again=await lockSkills(home);await again.release();
 }finally{child?.kill();await rm(home,{recursive:true,force:true});}
});
test('lost guard cannot commit over a successor, and commits are performed by the owner',{skip:process.platform!=='win32'},async()=>{
 const home=await mkdtemp(join(tmpdir(),'skills-commit-'));const controller=new AbortController();let first,second;
 try{
  first=await lockSkills(home,{signal:controller.signal});await first.commit({version:'old'});
  controller.abort(Error('simulated helper termination'));
  second=await lockSkills(home,{waitMs:5000});await second.commit({version:'new'});
  await assert.rejects(first.commit({version:'stale'}));
  assert.deepEqual(JSON.parse(await readFile(join(home,'state.json'),'utf8')),{version:'new'});
 }finally{await first?.release();await second?.release();await rm(home,{recursive:true,force:true});}
});
