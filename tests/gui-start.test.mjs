import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,get} from 'node:http';
import {once} from 'node:events';
import {ensureSession,startGui} from '../src/gui-start.mjs';

test('unknown session creation result is never replayed; next launch first reads server state',async()=>{
  const directory='C:\\Игра & тест';let stored,posts=0;
  const runtime={request:async(path,options)=>{
    if(options?.method==='POST'){posts++;stored={id:'ses_test',location:{directory}};throw Error('connection lost after commit');}
    assert.equal(new URL('http://localhost'+path).searchParams.get('directory'),directory);
    return Response.json({data:stored?[stored]:[]});
  }};
  await assert.rejects(ensureSession(runtime,directory),/connection lost/);
  assert.equal(posts,1);
  assert.equal((await ensureSession(runtime,directory)).id,stored.id);
  assert.equal(posts,1);
});

test('GUI gateway preserves cookie auth and streaming, rejects foreign origins and hostile hosts',async()=>{
  const upstream=createServer((req,res)=>{
    if(req.url==='/auth/connect/test'){res.writeHead(302,{'Set-Cookie':'test=secret; HttpOnly; SameSite=Lax',Location:'/'});res.end();return;}
    if(req.headers.cookie!=='test=secret'){res.writeHead(401).end();return;}
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: first\n\n');setImmediate(()=>res.end('data: second\n\n'));
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const url='http://127.0.0.1:'+upstream.address().port;
  const gui=await startGui({url,pair:async()=>url+'/auth/connect/test'},'C:\\Игра </script>',{id:'ses_test'});
  try {
    assert.equal((await fetch(gui.url+'/api/info')).status,401);
    assert.equal((await fetch(gui.url+'/api/info',{headers:{Origin:'https://foreign.test'}})).status,403);
    const hostile=await new Promise((ok,fail)=>get(gui.url+'/api/info',{headers:{Host:'foreign.test'}},res=>{res.resume();ok(res.statusCode);}).on('error',fail));
    assert.equal(hostile,403);
    const paired=await fetch(await gui.pair(),{redirect:'manual'});
    assert.equal(paired.status,200);assert.match(paired.headers.get('set-cookie'),/HttpOnly/);
    const html=await paired.text();assert.ok(!html.includes('Игра </script>'));assert.ok(!html.includes('secret'));
    assert.equal(await (await fetch(gui.url+'/events',{headers:{Cookie:'test=secret'}})).text(),'data: first\n\ndata: second\n\n');
  }finally{await gui.close();await new Promise(ok=>upstream.close(ok));}
});
