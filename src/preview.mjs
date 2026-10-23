import {createServer} from 'node:http';
import {readFile,stat,readdir} from 'node:fs/promises';
import {join,extname,resolve} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {inside,noLinks} from './storage.mjs';

const mime={'.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2'};
export async function startPreview(workspace) {
  const root=resolve(workspace,'artifacts');await noLinks(root);
  const token=randomBytes(18).toString('hex');
  async function stamp(dir=root){const records=[];for(const item of await readdir(dir,{withFileTypes:true})){if(item.name.startsWith('.')||item.isSymbolicLink())continue;const path=join(dir,item.name);if(item.isDirectory())records.push(await stamp(path));else{const s=await stat(path);records.push([path,s.mtimeMs,s.size]);}}return createHash('sha256').update(JSON.stringify(records)).digest('hex');}
  const server=createServer(async(req,res)=>{
    try {
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
      const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      if(!path.startsWith('/'+token+'/')){res.writeHead(404).end();return;}
      const file=path.slice(token.length+2);
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
      if(file==='__version'){res.setHeader('Content-Type','text/plain');res.end(await stamp());return;}
      if(file.split('/').some(p=>p.startsWith('.')))throw new Error('Hidden path');
      const full=inside(root,file);await noLinks(full);
      const s=await stat(full);if(!s.isFile()||s.size>20*1024*1024)throw new Error('Invalid preview file');
      let body=await readFile(full);const extension=extname(full).toLowerCase();
      if(['.html','.htm'].includes(extension)) {
        const version=await stamp();
        const script=`<script>(()=>{const initial=${JSON.stringify(version)};setInterval(async()=>{try{const r=await fetch('/${token}/__version',{cache:'no-store'});if(r.ok&&(await r.text())!==initial)location.reload();}catch{}},1000)})();</script>`;
        body=Buffer.from(body.toString('utf8')+script);
      }
      res.setHeader('Content-Type',mime[extension]??'application/octet-stream');res.end(req.method==='HEAD'?undefined:body);
    }catch{res.writeHead(404).end('Not found');}
  });
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
  return {url:`http://127.0.0.1:${server.address().port}/${token}/`,close:()=>new Promise(ok=>server.close(ok))};
}
