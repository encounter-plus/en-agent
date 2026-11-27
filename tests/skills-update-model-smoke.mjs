// Opt-in: real model, actual bundled MCP/update implementation, synthetic release only.
import {lastAssistantMessage} from './model-message.mjs';
import {copyTestSkills} from './copied-skills.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {installed} from '../src/releases.mjs';
import {json} from '../src/storage.mjs';

const seed=resolve(process.argv[2]),model=process.argv[3]??'big-pickle';
const bundle=await installed(seed,(await json(join(seed,'state.json'))).current);
const {startOpenCode,waitForMcp}=await import(pathToFileURL(join(bundle.root,'launcher/src/opencode.mjs')));
const {skillsStatus}=await import(pathToFileURL(join(bundle.root,'launcher/src/skills-store.mjs')));
const {detectBrowsers,chooseBrowser}=await import(pathToFileURL(join(bundle.root,'launcher/src/browser-choice.mjs')));
const base=await mkdtemp(resolve('.local/skills-model-')),home=join(base,'home'),game=join(base,'game'),fixture=join(base,'fixture');
await copyTestSkills(bundle,seed,home);
await mkdir(game);await mkdir(join(fixture,'game-author'),{recursive:true});
await writeFile(join(fixture,'game-author/SKILL.md'),'---\nname: game-author\ndescription: Synthetic updated skill\n---\nSynthetic update fixture.');
const archive=join(base,'skills.zip'),quote=s=>"'"+s.replaceAll("'","''")+"'";
await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quote(fixture)},${quote(archive)})`],{windowsHide:true});
const bytes=await readFile(archive),sha=createHash('sha256').update(bytes).digest('hex'),version='9.0.0',name='en-skills-'+version+'.zip';
const url='https://github.com/encounter-plus/en-skills/releases/download/'+version+'/'+name;
const network=join(base,'network.mjs'),trace=join(base,'requests.jsonl');
await writeFile(network,`import {readFile,appendFile} from 'node:fs/promises';
globalThis.fetch=async url=>{
 await appendFile(${JSON.stringify(trace)},JSON.stringify({url})+'\\n');
 if(url==='https://api.github.com/repos/encounter-plus/en-skills/releases/latest')return Response.json(${JSON.stringify({tag_name:version,draft:false,prerelease:false,assets:[{name,browser_download_url:url,digest:'sha256:'+sha},{name:name+'.sha256',browser_download_url:url+'.sha256'}]})});
 if(url===${JSON.stringify(url+'.sha256')})return new Response(${JSON.stringify(sha+'  '+name+'\n')});
 if(url===${JSON.stringify(url)})return new Response(await readFile(${JSON.stringify(archive)}));
 throw Error('External tool network forbidden in this synthetic test');
};`);
const permissions=[{action:'*',resource:'*',effect:'deny'},...['en_skills_*','author_tools_en_skills_*'].map(action=>({action,resource:'*',effect:'allow'}))];
const previous=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS='--import='+pathToFileURL(network).href;
const previousConfig=process.env.OPENCODE_CONFIG;let modelServer,fixtureFailure,checkingLoadedSkill=false,loadedSkillVerified=false;
if(model==='fixture'){
 modelServer=createServer(async(req,res)=>{
  try{
   let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);
   if(!input.tools?.length){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Synthetic skills update'},finish_reason:'stop'}]}));return;}
   assert.match(JSON.stringify(input.messages),checkingLoadedSkill?/Проверь загруженный навык/:/Обнови en-skills/);
   const name=input.tools.find(t=>checkingLoadedSkill?t.function.name==='skill':t.function.name.endsWith('en_skills_update'))?.function.name;assert.ok(name,'Required tool must be available');
   const result=input.messages.some(m=>m.role==='tool'&&JSON.stringify(m).includes(checkingLoadedSkill?'Synthetic update fixture.':'updated'));
   if(checkingLoadedSkill&&result)loadedSkillVerified=true;
   const delta=result?{content:checkingLoadedSkill?'Новый навык загружен.':'Обновлено до 9.0.0. Перезапустите en-agent и откройте новый чат.'}:{tool_calls:[{index:0,id:'skills_update',type:'function',function:{name,arguments:checkingLoadedSkill?JSON.stringify({id:'game-author'}):'{}'}}]};
   res.writeHead(200,{'content-type':'text/event-stream'});
   const chunk=(delta,finish_reason=null)=>'data: '+JSON.stringify({id:'skills-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n';
   res.end(chunk({role:'assistant'})+chunk(delta)+chunk({},result?'stop':'tool_calls')+'data: [DONE]\n\n');
  }catch(error){fixtureFailure=error;res.writeHead(500);res.end('Synthetic model assertion failed');}
 });
 await new Promise(done=>modelServer.listen(0,'127.0.0.1',done));
 const config=join(base,'provider.json');await writeFile(config,JSON.stringify({providers:{fixture:{name:'Synthetic skills test',package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:`http://127.0.0.1:${modelServer.address().port}/v1`,apiKey:'synthetic'},models:{fixture:{name:'Local fixture',capabilities:{tools:true},limit:{context:32000,output:2000}}}}}}));process.env.OPENCODE_CONFIG=config;
}
let runtime;
try{
 runtime=await startOpenCode(bundle,home,game,{browserChoice:chooseBrowser(await detectBrowsers(bundle.root))});await waitForMcp(runtime,game,['encounter','author_tools','browser']);
 const post=async(path,body)=>{const response=await runtime.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(response.ok,await response.clone().text());return response.json();};
 const session=(await post('/api/session',{location:{directory:game},model:{providerID:model==='fixture'?'fixture':'opencode',id:model},permissions})).data;
 await post('/api/session/'+session.id+'/prompt',{text:'Обнови en-skills'});
 const deadline=Date.now()+180000;let final;
 while(Date.now()<deadline){
  const database=new DatabaseSync(join(home,'data/share/opencode/opencode.db'),{readOnly:true});
  try{
   const message=lastAssistantMessage(database,session.id);
   if(fixtureFailure)throw fixtureFailure;
   if(message?.error)throw Error('Model failed: '+message.error.type+' / '+message.error.message);
   if(message?.time?.completed&&message.content?.some(c=>c.type==='text')&&!message.content.some(c=>c.type==='tool')){final=message.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');break;}
  }finally{database.close();}
  await new Promise(done=>setTimeout(done,500));
 }
 await writeFile(join(base,'final.txt'),final??'No completed model answer');
 assert.ok(final,'Model must complete the request');assert.equal((await skillsStatus(home)).version,version);
 const requests=(await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(requests.filter(r=>r.url===url).length,1);
 assert.match(final,/перезап|запуст|запуск/i);
 await runtime.stop();runtime=undefined;
 runtime=await startOpenCode(bundle,home,game,{browserChoice:chooseBrowser(await detectBrowsers(bundle.root))});
 await waitForMcp(runtime,game,['encounter','author_tools','browser']);
 assert.equal((await skillsStatus(home)).version,version,'Restart must retain the independently updated skills');
 if(model==='fixture'){
  checkingLoadedSkill=true;
  const check=(await post('/api/session',{location:{directory:game},model:{providerID:'fixture',id:'fixture'},permissions:[{action:'*',resource:'*',effect:'deny'},{action:'skill',resource:'game-author',effect:'allow'}]})).data;
  await post('/api/session/'+check.id+'/prompt',{text:'Проверь загруженный навык game-author.'});
  const deadline=Date.now()+30000;
  while(!loadedSkillVerified&&!fixtureFailure&&Date.now()<deadline)await new Promise(done=>setTimeout(done,100));
  if(fixtureFailure)throw fixtureFailure;
  assert.ok(loadedSkillVerified,'OpenCode must load the new generation content through its real skill tool');
 }
 await installed(seed,bundle.manifest.id);
 console.log('PASS ('+model+'): literal Russian request invoked actual update tool, synthetic verified archive installed once, model explained restart, restart retained updated skills, signed bundle unchanged. Evidence: '+base);
} finally {
 if(previous===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previous;
 if(previousConfig===undefined)delete process.env.OPENCODE_CONFIG;else process.env.OPENCODE_CONFIG=previousConfig;
 if(runtime)await runtime.stop();if(modelServer)await new Promise(done=>modelServer.close(done));
}
