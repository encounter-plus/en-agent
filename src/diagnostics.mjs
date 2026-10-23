import {mkdir,readdir,stat,unlink,appendFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {atomicJson} from './storage.mjs';
const stages=new Set(['verify','browser','workspace','account','opencode','mcp','ready','stopped','error']);
const categories=new Set(['network','browser','authorization','model','bundle','startup']);
export function classify(error){
  const message=String(error?.message??'');
  if(/integrity|manifest|release|signature|bundle|ENOENT/i.test(message))return 'bundle';
  if(/браузер|browser|pairing/i.test(message))return 'browser';
  if(/auth|credential|401/i.test(message))return 'authorization';
  if(/model|provider|quota/i.test(message))return 'model';
  if(/fetch|network|download|ECONN|ENOTFOUND|offline/i.test(message))return 'network';
  return 'startup';
}
// Allowlisted structural events only: never serialize exceptions, URLs, prompts or paths.
export function safeEvent(event,{preserveTime=false}={}){
  const validTime=typeof event.time==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.time) && Number.isFinite(Date.parse(event.time));
  const value={time:preserveTime?(validTime?event.time:null):new Date().toISOString(),stage:stages.has(event.stage)?event.stage:'error'};
  if(categories.has(event.category))value.category=event.category;
  if(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(event.version??''))value.version=event.version;
  if(['auto','chrome','msedge','chromium','firefox'].includes(event.browser))value.browser=event.browser;
  if(event.mcp)value.mcp=Object.fromEntries(['encounter','author_tools','browser'].map(name=>[name,['connected','pending','failed','disabled','needs_auth'].includes(event.mcp[name])?event.mcp[name]:'pending']));
  if(['checking','staged','current','failed'].includes(event.update))value.update=event.update;
  return value;
}
export async function report(home,event){
  const value=safeEvent(event),dir=join(home,'diagnostics');await mkdir(dir,{recursive:true});
  for(const name of await readdir(dir))if(/^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)){
    const file=join(dir,name),info=await stat(file);
    if(Date.now()-info.mtimeMs>7*86400000||info.size>256*1024)await unlink(file);
  }
  await appendFile(join(dir,'events-'+value.time.slice(0,10)+'.jsonl'),JSON.stringify(value)+'\n');
  await atomicJson(join(home,'status.json'),value);
}
export async function exportDiagnostics(home,destination){
  const events=[];const dir=join(home,'diagnostics');
  for(const name of (await readdir(dir).catch(()=>[])).filter(x=>/^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort().slice(-7)){
    const file=join(dir,name);if((await stat(file)).size>257*1024)continue;
    for(const line of (await readFile(file,'utf8')).trim().split('\n'))try{events.push(safeEvent(JSON.parse(line),{preserveTime:true}));}catch{}
  }
  await atomicJson(destination,{schemaVersion:1,exportedAt:new Date().toISOString(),platform:process.platform,arch:process.arch,events});
}

if(process.argv[1]&&import.meta.url===(await import('node:url')).pathToFileURL((await import('node:path')).resolve(process.argv[1])).href)await exportDiagnostics(process.argv[2],process.argv[3]);
