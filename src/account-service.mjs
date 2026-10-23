import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {AccountManager} from './account-core.mjs';
import {AccountStore} from './account-store.mjs';
import {legacyBrowserLogin} from './account-browser.mjs';
export {AccountManager,authenticationFailure} from './account-core.mjs';

export async function startAccountService({root,home,browserChoice,open,manager:injected,onRequest=()=>{}}) {
  const nonce=randomBytes(24).toString('hex'),ipc=randomBytes(32).toString('hex');let browser,closed=false,recovery,connection,promptShown=false;
  const manager=injected??new AccountManager({home,dataDir:join(home,'data/encounter'),store:new AccountStore(join(root,'runtime/scripts/windows-credential.ps1')),legacyLogin:(p,password)=>legacyBrowserLogin(root,p,password,{browserChoice,onBrowser:b=>browser=b})});
  let origin;const prefix='/account/'+nonce+'/';
  const show=async()=>{if(!closed)await open(origin+prefix);};
  const server=createServer(async(req,res)=>{
    onRequest({method:req.method,hostMatches:req.headers.host===new URL(origin).host,pathMatches:req.url?.startsWith(prefix)});
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`);
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    if(req.headers.host!==new URL(origin).host)return send(403,{error:'Forbidden'});
    if(req.method==='POST'&&req.url==='/connect'){
      if(req.headers.authorization!=='Bearer '+ipc)return send(403,{error:'Forbidden'});
      if(connection||recovery||manager.busy)return send(200,{status:'connecting'});
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>1024)return send(413,{error:'Request too large'});}
      let body;try{body=JSON.parse(raw);}catch{return send(400,{error:'Invalid JSON'});}
      connection=(async()=>{try{const result=await manager.connect(body.domain);if(result.status==='login-required'&&!promptShown){promptShown=true;await show();}}catch{manager.message='Не удалось подключить домен. Проверьте адрес в чате.';}finally{connection=null;}})();
      return send(200,{status:'connecting'});
    }
    if(req.method==='GET'&&req.url==='/status'){
      if(req.headers.authorization!=='Bearer '+ipc)return send(403,{error:'Forbidden'});
      try{return send(200,await manager.status());}catch{return send(503,{status:'unavailable'});}
    }
    if(req.method==='POST'&&req.url==='/recover'){
      if(req.headers.authorization!=='Bearer '+ipc)return send(403,{error:'Forbidden'});
      if(connection)return send(200,{status:'connecting'});
      if(req.headers['x-en-profile']&&req.headers['x-en-profile']!==(await manager.active())?.name)return send(409,{status:'profile-mismatch'});
      try{recovery??=(async()=>{const result=await manager.recover();if(result.status==='login-required'&&!promptShown){promptShown=true;await show();}return result;})();const result=await recovery;return send(200,result);}catch{return send(503,{status:'unavailable'});}finally{recovery=null;}
    }
    if(!req.url?.startsWith(prefix))return send(404,{error:'Not found'});
    const action=req.url.slice(prefix.length);
    try {

      if(req.method==='GET'&&action==='status')return send(200,await manager.status());
      if(req.method!=='POST'||req.headers.origin!==origin||req.headers['x-en-agent-ui']!==nonce)return send(403,{error:'Forbidden'});
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>8192)return send(413,{error:'Request too large'});}
      let body;try{body=JSON.parse(raw);}catch{return send(400,{error:'Некорректные данные формы.'});}
      if(action==='login'){const result=await manager.login(body);promptShown=false;return send(200,result);}
      if(action==='forget'){const result=await manager.forget();promptShown=false;return send(200,result);}
      return send(404,{error:'Not found'});
    } catch(e){manager.message=e.message;return send(400,{error:e.message});}
  });
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});origin='http://127.0.0.1:'+server.address().port;
  return {show,environment:{EN_AGENT_ACCOUNT_URL:origin,EN_AGENT_ACCOUNT_TOKEN:ipc},url:origin+prefix,async close(){closed=true;if(browser)await browser.close().catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
