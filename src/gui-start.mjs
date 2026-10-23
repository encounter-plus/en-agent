import {createServer,request as httpRequest} from 'node:http';
import {randomBytes} from 'node:crypto';

// OpenCode 2.0.32: session.create does not run a model or send a prompt.
export async function ensureSession(runtime,directory) {
  const response=await runtime.request('/api/session?'+new URLSearchParams({directory,parentID:'null',order:'desc',limit:'1'}));
  if(!response.ok)throw Error('OpenCode session lookup failed');
  const listed=await response.json();
  if(!Array.isArray(listed.data))throw Error('Invalid OpenCode session response');
  let session=listed.data[0];
  if(!session){
    const created=await runtime.request('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:{directory}})});
    if(!created.ok)throw Error('OpenCode session creation failed');
    session=(await created.json()).data;
  }
  if(!session?.id||session.location?.directory?.toLowerCase()!==directory.toLowerCase())throw Error('Invalid OpenCode session location');
  return session;
}

// The pinned GUI has no pairing returnTo parameter. This loopback gateway keeps
// its cookie authentication and streams HTTP/SSE/WebSocket traffic unchanged.
// Only a successful, single-use pairing navigation gets our start page.
export async function startGui(runtime,directory,session) {
  const upstream=new URL(runtime.url),sockets=new Set();
  let origin,pairPath;
  const server=createServer((req,res)=>{
    if(req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin)){res.writeHead(403).end();return;}
    const proxy=httpRequest({hostname:upstream.hostname,port:upstream.port,path:req.url,method:req.method,headers:req.headers},reply=>{
      reply.on('error',()=>res.destroy());
      if(req.method==='GET'&&req.url===pairPath&&reply.statusCode===302&&reply.headers['set-cookie']){
        pairPath=undefined;reply.resume();
        const nonce=randomBytes(18).toString('base64');
        const payload=JSON.stringify({directory,origin,path:'/server/'+Buffer.from(origin).toString('base64url')+'/session/'+encodeURIComponent(session.id)}).replaceAll('<','\\u003c');
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Set-Cookie':reply.headers['set-cookie'],'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`});
        res.end(`<!doctype html><meta charset="utf-8"><title>en-agent</title><p id="status">Открываем игру…</p><script nonce="${nonce}">
          try {
            const input=${payload},key='opencode.global.dat:server';
            const state=JSON.parse(localStorage.getItem(key)||'null')||{list:[],hidden:{},projects:{},lastProject:{},recentlyClosed:{}};
            for(const scope of ['local',input.origin]){
              state.projects??={};state.lastProject??={};state.recentlyClosed??={};
              const list=state.projects[scope]||[];
              if(!list.some(p=>p.worktree===input.directory))list.unshift({worktree:input.directory,expanded:true});
              state.projects[scope]=list;state.lastProject[scope]=input.directory;
              state.recentlyClosed[scope]=(state.recentlyClosed[scope]||[]).filter(p=>p!==input.directory);
            }
            localStorage.setItem(key,JSON.stringify(state));
            location.replace(input.path);
          } catch {document.getElementById('status').textContent='Не удалось открыть игру. Разрешите локальное хранилище браузера и повторите запуск.';}
        </script>`);
      }else {res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);}
    });
    proxy.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    req.on('aborted',()=>proxy.destroy());res.on('close',()=>proxy.destroy());req.pipe(proxy);
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.on('upgrade',(req,socket,head)=>{
    if(req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin)){socket.destroy();return;}
    const proxy=httpRequest({hostname:upstream.hostname,port:upstream.port,path:req.url,headers:req.headers});
    socket.on('error',()=>proxy.destroy());
    proxy.on('upgrade',(reply,remote,upstreamHead)=>{
      sockets.add(remote);remote.on('close',()=>sockets.delete(remote));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers).map(([k,v])=>k+': '+v).join('\r\n')}\r\n\r\n`);
      if(upstreamHead.length)socket.write(upstreamHead);if(head.length)remote.write(head);
      remote.on('error',()=>socket.destroy());socket.on('error',()=>remote.destroy());
      socket.on('close',()=>remote.destroy());remote.on('close',()=>socket.destroy());socket.pipe(remote).pipe(socket);
    });
    proxy.on('response',reply=>{reply.resume();socket.destroy();});proxy.on('error',()=>socket.destroy());proxy.end();
  });
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
  origin='http://127.0.0.1:'+server.address().port;
  return {url:origin,pair:async()=>{pairPath=new URL(await runtime.pair()).pathname;return origin+pairPath;},close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(ok=>server.close(ok));}};
}
