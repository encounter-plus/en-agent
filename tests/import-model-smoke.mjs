// Opt-in real-model evaluation. No production MCP, credentials, browser, shell or web tools.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,cp,copyFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {installed} from '../src/releases.mjs';
import {json} from '../src/storage.mjs';
const home=resolve(process.argv[2]),model=process.argv[3]??'big-pickle';
const bundle=await installed(home,(await json(join(home,'state.json'))).current);
const installedMode=process.argv.includes('--installed');
const {startOpenCode,waitForMcp}=await import(pathToFileURL(installedMode?join(bundle.root,'launcher/src/opencode.mjs'):resolve('src/opencode.mjs')));
const base=await mkdtemp(resolve('.local/import-model-')),root=installedMode?bundle.root:join(base,'bundle'),work=join(base,'game'),evidence=join(base,'evidence');
await mkdir(work);await mkdir(evidence);
let manifest={...bundle.manifest},accountEnvironment={},browserChoice;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fingerprints(directory){const result={};async function walk(p){for(const e of await readdir(p,{withFileTypes:true})){const file=join(p,e.name);if(e.isDirectory())await walk(file);else if(e.isFile())result[file]=hash(await readFile(file));else throw Error('Unexpected link');}}await walk(directory);return result;}
const preferences=installedMode?await json(join(home,'preferences.json')):null;
const preserved=installedMode?{game:await fingerprints(preferences.game),data:await fingerprints(join(home,'data')),preferences:hash(await readFile(join(home,'preferences.json'))),state:hash(await readFile(join(home,'state.json')))}:null;
if(!installedMode){
await mkdir(root);
await copyFile(join(bundle.root,bundle.manifest.nodePath),join(root,'node.exe'));
await copyFile(join(bundle.root,bundle.manifest.opencode.path),join(root,'opencode.exe'));
await cp(resolve('../en-skills/dist/skills'),join(root,'skills'),{recursive:true});
await mkdir(join(root,'launcher/src'),{recursive:true});
await copyFile(resolve('src/agent-instructions.md'),join(root,'launcher/src/agent-instructions.md'));
await build({entryPoints:[resolve('../en-skills/runtime/tests/import-model-server.ts')],outfile:join(root,'fixture.mjs'),bundle:true,platform:'node',format:'esm',target:'node24'});
// startOpenCode's managed command invokes this wrapper with the fixture's sole local output root.
await writeFile(join(root,'mcp.mjs'),`process.argv[2]=${JSON.stringify(evidence)};await import('./fixture.mjs');`);
manifest={...bundle.manifest,nodePath:'node.exe',skillsPath:'skills',mcpPath:'mcp.mjs',opencode:{...bundle.manifest.opencode,path:'opencode.exe'}};
delete manifest.accountProxyPath;delete manifest.toolsPath;delete manifest.browserPath;
}else{
 const isolatedHome=join(base,'launcher-home');
 await cp(bundle.root,join(isolatedHome,'releases',manifest.id),{recursive:true});
 await writeFile(join(isolatedHome,'state.json'),JSON.stringify({current:manifest.id,highestSequence:manifest.sequence,probation:false}));
 const smokeArgs=[join(bundle.root,manifest.launcherPath),'--home',isolatedHome,'--game',work,'--name','Synthetic installed import','--no-browser','--smoke'];
 let smoke;
 try{smoke=await promisify(execFile)(join(bundle.root,manifest.nodePath),smokeArgs,{windowsHide:true,timeout:120000});}
 catch(error){await writeFile(join(base,'launcher-first-attempt.log'),error.stdout+'\n'+error.stderr);console.log('Initial launcher startup failed; recorded diagnostics, retrying once.');smoke=await promisify(execFile)(join(bundle.root,manifest.nodePath),smokeArgs,{windowsHide:true,timeout:120000});}
 await writeFile(join(base,'launcher-smoke.log'),smoke.stdout+smoke.stderr);console.log(smoke.stdout.trim());
 const {detectBrowsers,chooseBrowser}=await import(pathToFileURL(join(bundle.root,'launcher/src/browser-choice.mjs')));
 browserChoice=chooseBrowser(await detectBrowsers(bundle.root));
 await build({entryPoints:[resolve('../en-skills/runtime/tests/installed-import-fixture.ts')],outfile:join(base,'fixture.mjs'),bundle:true,platform:'node',format:'esm',target:'node24'});
 const serverUrl=pathToFileURL(join(bundle.root,manifest.mcpPath)).href;
 const preload=join(base,'installed-preload.mjs');
 await writeFile(preload,`import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {fixture} from './fixture.mjs';
import {pathToFileURL} from 'node:url';
const target=${JSON.stringify(serverUrl)};
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===target){
 globalThis.__installedFixture=await fixture(${JSON.stringify(evidence)});
 globalThis.fetch=async()=>{throw Error('Synthetic runtime blocks external network');};
 registerHooks({load(url,context,next){if(url!==target)return next(url,context);
 let source=readFileSync(new URL(url),'utf8');
 const anchor='var server = new McpServer({ name: "encounter-author", version: "${manifest.mcpVersion}" });';
 const host='runtimePlanHost(await operations(profile))';
 if(source.split(anchor).length!==2||source.split(host).length!==2)throw Error('Installed fixture seam drift');
 source=source.replace(anchor,anchor+'\\nglobalThis.__installedFixture.attach(server);').replace(host,'globalThis.__installedFixture.host');
 return {format:'module',source,shortCircuit:true};}});
}`);
 accountEnvironment={NODE_OPTIONS:'--import='+pathToFileURL(preload).href};
 await writeFile(join(base,'installed-provenance.json'),JSON.stringify({home,release:manifest.id,root,server:manifest.mcpPath,serverSha256:hash(await readFile(join(root,manifest.mcpPath))),launcher:manifest.launcherPath,installedTools:true,testBoundary:'Only PlanHost dependency and tracing are injected in memory; installed handlers, schemas, journal and instructions unchanged. Synthetic table and engine, real external model. Production runtime network blocked.'},null,2));
}
const template=JSON.parse(await readFile(join(root,'skills/game-author/scripts/workspace-template.json'),'utf8'));
await writeFile(join(work,'AGENTS.md'),template.files['AGENTS.md']+'\nUse game-import. This is a synthetic test. Use only the supplied synthetic MCP for table and game operations. Never access a real game.');
for(const name of ['GAME.md','decisions.md','tasks.md'])await writeFile(join(work,name),template.files[name].replaceAll('{{GAME_NAME}}','Synthetic'));
const config=join(base,'config.json');
const permissions=[{action:'*',resource:'*',effect:'deny'},{action:'skill',resource:'game-import',effect:'allow'},{action:'read',resource:join(root,'skills').replaceAll('\\','/')+'/*',effect:'allow'},{action:'external_directory',resource:join(root,'skills').replaceAll('\\','/')+'/*',effect:'allow'},...['GAME.md','decisions.md','tasks.md'].flatMap(resource=>[{action:'read',resource,effect:'allow'},{action:'edit',resource,effect:'allow'}]),{action:'encounter_*',resource:'*',effect:'allow'}];
await writeFile(config,JSON.stringify({permissions}));
const previous=process.env.OPENCODE_CONFIG;process.env.OPENCODE_CONFIG=config;
let runtime;
try{
 runtime=await startOpenCode({root,manifest},join(base,'state'),work,{accountEnvironment,browserChoice});
 await waitForMcp(runtime,work,installedMode?['encounter','author_tools','browser']:['encounter']);
 const post=async(path,body)=>{const r=await runtime.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();};
 const session=(await post('/api/session',{location:{directory:work},model:{providerID:'opencode',id:model},permissions})).data;
 await writeFile(join(base,'run.json'),JSON.stringify({model,session:session.id,base}));console.log('REAL_MODEL_RUN '+base);
 await post(`/api/session/${session.id}/prompt`,{text:'Используй game-import. Прочитай synthetic://table через google_public_read. В synthetic.invalid игре 42 существующий уровень ID 100 переименуй в «Брифинг», обнови его задание ID 7 буквальным брифингом из таблицы. Служебное задание ID 8 сохрани. Создай один новый уровень «Нейродиалог 1»: реплики первого диалога оформи HTML, перенеси сектор с точными ответами, бонус, подсказку и дополнительное задание из таблицы. Второй диалог исключи. CSS загрузи отдельным файлом и подключи ссылкой в общем сообщении организатора. Настройки прохождения не меняй. Все перечисленные изменения подтверждаю. Сначала прочитай существующий уровень и подготовь общий план, затем выполни и проверь. В тесте возможен потерянный ответ: восстанови журнал через reconcile и продолжи тем же планом без дублей. Реальных игр и внешних источников не касайся.'});
 const deadline=Date.now()+720000;let traces=[],finished=false;
 while(Date.now()<deadline){
  try{traces=(await readFile(join(evidence,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);}catch{}
  if(traces.some(t=>t.name==='encounter_verify_import_plan'&&JSON.stringify(t.result).includes('complete'))){
   const db=new DatabaseSync(join(base,'state/data/share/opencode/opencode.db'),{readOnly:true});
   try{const row=db.prepare('SELECT data FROM session_message WHERE session_id=? AND type=? ORDER BY seq DESC LIMIT 1').get(session.id,'assistant');const message=row?JSON.parse(row.data):null;
    if(message?.time?.completed&&message.content?.some(c=>c.type==='text')&&!message.content.some(c=>c.type==='tool')){finished=true;await writeFile(join(base,'final-message.json'),JSON.stringify(message.content.filter(c=>c.type==='text'),null,2));break;}
   }finally{db.close();}
  }
  await new Promise(ok=>setTimeout(ok,1000));
 }
 await writeFile(join(base,'session.json'),JSON.stringify(await (await runtime.request('/api/session/'+session.id)).json(),null,2));
 const state=JSON.parse(await readFile(join(evidence,'state.json'),'utf8'));
 assert.ok(finished,'Model must finish its turn after verification');
 const finalText=JSON.parse(await readFile(join(base,'final-message.json'),'utf8')).map(c=>c.text).join('\n');
 assert.ok((finalText.match(/\p{Script=Cyrillic}/gu)??[]).length>50,'Final answer must contain Russian explanatory text');
 assert.ok(!/\p{Script=Han}/u.test(finalText),'Final answer unexpectedly switched to Chinese');
 assert.deepEqual(state.levels.map(l=>l.level_name),['Брифинг','Нейродиалог 1']);
 assert.equal(state.levels[0].tasks[0].task_text,'Добро пожаловать в Обсерваторию. Код старта выдаёт ведущий.');
 const dialogue=state.levels[1].tasks[0].task_text;
 assert.ok(dialogue.includes('Почему звёзды мерцают?')&&dialogue.includes('Из-за неоднородности атмосферы.'));
 assert.ok(/<[^>]+>/.test(dialogue));assert.ok(!dialogue.includes('Луна')&&!dialogue.includes('Общие стили поместить'));
 assert.equal(state.messages.length,1);assert.equal(state.messages[0].all_levels,true);assert.match(state.messages[0].message_text,/<link[ >]/i);assert.equal(Object.keys(state.assets).length,1);
 const classes=[...dialogue.matchAll(/class=["']([^"']+)["']/g)].flatMap(match=>match[1].split(/\s+/));
 assert.ok(classes.some(name=>Object.values(state.assets).some(a=>a.content.includes('.'+name))),'CSS must target a dialogue class');
 assert.equal(state.levels[0].tasks.length,2);assert.equal(state.levels[0].tasks.find(t=>t.task_id===8).task_text,'Сохранить служебное задание');
 assert.deepEqual(state.levels[1].answers.map(a=>a.answer_text),['001','Конь6']);assert.equal(state.levels[1].sectors[0].sector_name,'Звёзды');
 assert.equal(state.levels[1].bonuses[0].bonus_name,'Наблюдатель');assert.equal(state.levels[1].bonuses[0].reward_seconds,60);assert.equal(state.levels[1].bonuses[0].answers[0].answer_text,'БОНУС');
 assert.equal(state.levels[1].helps[0].help_text,'Посмотри вверх');assert.equal(state.levels[1].helps[0].timeout,30);assert.equal(state.levels[1].tasks.length,2);assert.ok(state.levels[1].tasks.some(t=>t.task_text==='Запишите наблюдение.'));
 assert.ok(traces.some(t=>t.name==='encounter_reconcile_import_plan'),'Recovery tool must be exercised');assert.equal(state.calls.filter(c=>c==='create').length,2);assert.equal(state.calls.filter(c=>c==='asset').length,1);
 assert.ok(traces.some(t=>t.name==='encounter_verify_import_plan'&&JSON.stringify(t.result).includes('complete')),'Explicit final verification missing');
 assert.ok(state.levels.every(l=>Object.keys(l.settings).length===0),'Passage settings must remain unchanged');
 const memory=await readFile(join(work,'GAME.md'),'utf8');
 assert.ok(memory.includes('synthetic.invalid')&&memory.includes('42'),'Completed import must update GAME.md');
 await writeFile(join(base,'memory-result.json'),JSON.stringify({updated:memory.includes('synthetic.invalid')&&memory.includes('42')},null,2));
 await writeFile(join(base,'result.json'),JSON.stringify({status:'passed',model,session:session.id,checks:['names','brief-literal','dialogue-1-only','html','organizer-css-all-levels','css-targets-dialogue','whole-plan-complete','lost-response-recovery','existing-level','preserve-unrelated-task','sectors-exact-answers','bonus','hint','additional-task','external-css','finished-turn','russian-final','unchanged-settings','game-memory']},null,2));
 console.log('PASS REAL MODEL '+model+' '+base);
}finally{if(runtime)await runtime.stop();if(previous===undefined)delete process.env.OPENCODE_CONFIG;else process.env.OPENCODE_CONFIG=previous;
 if(preserved){assert.deepEqual(await fingerprints(preferences.game),preserved.game);assert.deepEqual(await fingerprints(join(home,'data')),preserved.data);assert.equal(hash(await readFile(join(home,'preferences.json'))),preserved.preferences);assert.equal(hash(await readFile(join(home,'state.json'))),preserved.state);await installed(home,manifest.id);await writeFile(join(base,'preservation.json'),JSON.stringify({realGameUnchanged:true,installedDataUnchanged:true,preferencesUnchanged:true,installedStateUnchanged:true,bundleIntegrityVerified:true},null,2));}
}
