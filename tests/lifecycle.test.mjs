import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {lock,atomicJson,json} from '../src/storage.mjs';
import {report,exportDiagnostics} from '../src/diagnostics.mjs';
test('killed launcher lock is recovered; reused PID is never killed; live and foreign owners survive',async()=>{
  const home=await mkdtemp(join(tmpdir(),'en-lifecycle-'));let child;
  try{
    child=spawn(process.execPath,['--input-type=module','-e',`import {lock} from ${JSON.stringify(new URL('../src/storage.mjs',import.meta.url).href)};await lock(process.argv[1]);console.log('ready');setInterval(()=>{},1000);`,home],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    await once(child.stdout,'data');
    await assert.rejects(lock(home),/already running/);
    const exited=once(child,'exit');child.kill();await exited;
    const release=await lock(home);await release();
    await mkdir(join(home,'launcher.lock'));
    const owner={pid:process.pid,birth:'not-the-current-birth',nonce:'test',installation:(await import('../src/process-identity.mjs')).installationId};
    owner.installation=await owner.installation(home);
    await atomicJson(join(home,'launcher.lock','owner.json'),owner);
    const recovered=await lock(home);await recovered();assert.ok(process.pid);
    await mkdir(join(home,'launcher.lock'));await atomicJson(join(home,'launcher.lock','owner.json'),{...owner,installation:'foreign'});
    await assert.rejects(lock(home),/unknown/);assert.equal((await json(join(home,'launcher.lock','owner.json'))).installation,'foreign');
  }finally{child?.kill();await rm(home,{recursive:true,force:true});}
});
test('diagnostic export cannot include secrets, pairing URLs, chats or raw exceptions',async()=>{
  const home=await mkdtemp(join(tmpdir(),'en-diagnostic-'));
  try{
    await report(home,{stage:'ready',password:'secret-123',url:'http://localhost/auth/connect/secret-123',message:'chat secret-123',mcp:{encounter:'connected',browser:'secret-123'}});
    await writeFile(join(home,'diagnostics','events-2020-01-01.jsonl'),JSON.stringify({stage:'error',error:'secret-123'})+'\n');
    const target=join(home,'export.json');await exportDiagnostics(home,target);
    const text=await readFile(target,'utf8');assert.ok(!text.includes('secret-123'));assert.match(text,/connected/);
  }finally{await rm(home,{recursive:true,force:true});}
});

 test('diagnostic export preserves historical timestamps and does not invent missing times', async () => {
  const home = await mkdtemp(join(tmpdir(), 'en-diagnostic-time-'));
  try {
    await mkdir(join(home, 'diagnostics'));
    const events = [{time:'2026-01-01T10:00:00.000Z',stage:'ready'},
      {time:'2026-01-01T10:05:00.000Z',stage:'error'}, {time:'secret-token',stage:'error'}];
    await writeFile(join(home,'diagnostics','events-2026-01-01.jsonl'),events.map(JSON.stringify).join('\n'));
    const target = join(home,'export.json');
    await exportDiagnostics(home,target);
    const output = await json(target);
    assert.deepEqual(output.events.map(event=>event.time),[events[0].time,events[1].time,null]);
    assert.ok(Number.isFinite(Date.parse(output.exportedAt)));
    assert.ok(!(await readFile(target,'utf8')).includes('secret-token'));
  } finally { await rm(home,{recursive:true,force:true}); }
});
