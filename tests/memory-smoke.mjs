// Real OpenCode, synthetic local model and games; no external MCP or paid inference.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,cp,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {json} from '../src/storage.mjs';
import {installed} from '../src/releases.mjs';
import {pathToFileURL} from 'node:url';
const home=resolve(process.argv[2]);
const bundle=await installed(home,(await json(join(home,'state.json'))).current);
const {startOpenCode}=await import(pathToFileURL(join(bundle.root,'launcher/src/opencode.mjs')));
const base=await mkdtemp(resolve('.local/memory-smoke-'));
const root=join(base,'bundle');await mkdir(root);
await copyFile(join(bundle.root,bundle.manifest.nodePath),join(root,'node.exe'));
await copyFile(join(bundle.root,bundle.manifest.opencode.path),join(root,'opencode.exe'));
await cp(join(bundle.root,bundle.manifest.skillsPath),join(root,'skills'),{recursive:true});
await mkdir(join(root,'launcher/src'),{recursive:true});
await copyFile(join(bundle.root,'launcher/src/agent-instructions.md'),join(root,'launcher/src/agent-instructions.md'));
await mkdir(join(root,'runtime/scripts'),{recursive:true});
await copyFile(join(bundle.root,'runtime/scripts/windows-credential.ps1'),join(root,'runtime/scripts/windows-credential.ps1'));
const skills=join(root,'skills');
const template=JSON.parse(await readFile(join(skills,'game-author/scripts/workspace-template.json'),'utf8'));
let active,runtime,failure;
const server=createServer(async(req,res)=>{
 try{
  let raw='';for await(const chunk of req)raw+=chunk;
  const input=JSON.parse(raw),text=JSON.stringify(input.messages);
  assert.ok(!text.includes('FOREIGN_INSTRUCTION'),'Other game or parent instruction leaked');
  if(!input.tools?.some(t=>t.function.name==='skill')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Memory fixture'},finish_reason:'stop'}]}));return;}
  const step=active.step++;
  let call;
  const previous=input.messages.findLast(m=>m.role==='tool');
  if(step===0){assert.ok(text.includes(active.marker),'Selected AGENTS.md missing');assert.ok(text.includes('Пиши автору по-русски'),'Installed communication policy missing');call=['skill',{id:active.skill}];}
  else if(step===1){assert.ok(JSON.stringify(previous??input.messages).includes('game-workspace.md'),'Skill must link shared memory contract');call=['read',{path:join(skills,active.skill,'references/game-workspace.md')}];}
  else if(step===2){assert.ok(JSON.stringify(previous??input.messages).includes('GAME.md'),'Shared memory contract missing');call=['read',{path:join(active.work,'GAME.md')}];}
  else if(step===3){assert.ok(JSON.stringify(previous??input.messages).includes('неизвестно'),'GAME.md was not read');call=['read',{path:join(active.work,'decisions.md')}];}
  else if(step===4){call=['read',{path:join(active.work,'tasks.md')}];}
  else if(step===5){call=['read',{path:join(active.work,'GAME.md')}];}
  else if(step===6){call=['write',{path:join(active.work,'GAME.md'),content:active.expected}];}
  else if(step===7){call=['read',{path:join(active.work,'GAME.md')}];}
  else {assert.ok(JSON.stringify(previous??input.messages).includes('424242'),'Updated file was not read back');active.done=true;}
  if(call)assert.ok(input.tools.some(t=>t.function.name===call[0]),'Missing tool '+call[0]);
  const delta=call?{tool_calls:[{index:0,id:'call_memory_'+step,type:'function',function:{name:call[0],arguments:JSON.stringify(call[1])}}]}:{content:'MEMORY_OK'};
  res.writeHead(200,{'content-type':'text/event-stream'});
  const chunk=(delta,finish_reason=null)=>'data: '+JSON.stringify({id:'memory',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n';
  res.end(chunk({role:'assistant'})+chunk(delta)+chunk({},call?'tool_calls':'stop')+'data: [DONE]\n\n');
 }catch(e){failure=e;res.writeHead(400);res.end('Fixture assertion failed');}
});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const config=join(base,'provider.json');
await writeFile(config,JSON.stringify({providers:{fixture:{package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'synthetic'},models:{fixture:{capabilities:{tools:true},limit:{context:64000,output:2000}}}}}}));
const previous=process.env.OPENCODE_CONFIG;process.env.OPENCODE_CONFIG=config;
try{
 await writeFile(join(base,'AGENTS.md'),'FOREIGN_INSTRUCTION parent');
 for(const skill of ['game-author','game-import']){
  const work=join(base,skill);await mkdir(work);
  for(const [name,content]of Object.entries(template.files))await writeFile(join(work,name),content.replaceAll('{{GAME_NAME}}',skill));
  const marker='SELECTED_GAME_'+skill;
  await writeFile(join(work,'AGENTS.md'),template.files['AGENTS.md']+'\n'+marker);
  // Invalid project config must remain ignored, including when instructions are opted in.
  await writeFile(join(work,'opencode.json'),'{INVALID PROJECT CONFIG');
  active={skill,work,marker,step:0,done:false,expected:`# ${skill}\n\n- Домен: synthetic.invalid\n- ID игры: 424242\n\nИсточник: синтетический запрос автора.\n`};
  const manifest={...bundle.manifest,nodePath:'node.exe',opencode:{...bundle.manifest.opencode,path:'opencode.exe'},skillsPath:'skills'};delete manifest.accountProxyPath;delete manifest.toolsPath;delete manifest.browserPath;
  // A local inert MCP process cannot access any real engine.
  manifest.mcpPath='inert.mjs';await writeFile(join(root,manifest.mcpPath),'process.stdin.resume();');
  runtime=await startOpenCode({root,manifest},join(base,'state-'+skill),work);
  const post=async(path,body)=>{const r=await runtime.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();};
  const session=(await post('/api/session',{location:{directory:work},model:{providerID:'fixture',id:'fixture'},permissions:[{action:'*',resource:'*',effect:'allow'}]})).data;
  await post(`/api/session/${session.id}/prompt`,{text:`Используй ${skill}. Запомни домен synthetic.invalid и ID игры 424242. Обнови память игры, без внешних операций.`});
  const deadline=Date.now()+60000;
  while(!active.done&&!failure&&Date.now()<deadline)await new Promise(ok=>setTimeout(ok,100));
  if(failure)throw failure;assert.ok(active.done,'Model loop timed out at step '+active.step);
  assert.equal(await readFile(join(work,'GAME.md'),'utf8'),active.expected);
  await runtime.stop();runtime=null;
  console.log('PASS '+skill+': selected AGENTS, packaged shared contract, read → write → read GAME.md; project config ignored');
 }
}finally{if(runtime)await runtime.stop();server.closeAllConnections();await new Promise(ok=>server.close(ok));if(previous===undefined)delete process.env.OPENCODE_CONFIG;else process.env.OPENCODE_CONFIG=previous;}
