import {ensureSession,startGui} from './gui-start.mjs';
import {report,classify,exportDiagnostics} from './diagnostics.mjs';
import {processIdentity} from './process-identity.mjs';
import {detectBrowsers,chooseBrowser} from './browser-choice.mjs';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {spawn} from 'node:child_process';
import {access,unlink} from 'node:fs/promises';
import {lock,optionalJson,json,atomicJson} from './storage.mjs';
import {installed,activatePending,markHealthy,rejectCurrent,syncBootstrap} from './releases.mjs';
import {startOpenCode,openGui,waitForMcp} from './opencode.mjs';
import {updateChecker} from './updates.mjs';
import {prepareSkills} from './skills-store.mjs';
import {setTimeout as delay} from 'node:timers/promises';

async function waitForWorkspace(values,signal){
  if(!values['wait-request'])return;
  for(;;){
    signal.throwIfAborted();
    const request=await optionalJson(values['wait-request']);
    if(request){values.game=request.game;values.name=request.name;return;}
    await delay(200,undefined,{signal});
  }
}

// Bootstrap holds the installation lock and verifies the selected bundle before importing this entry.
export async function run(home,values,state) {
  let runtime,gui,updates,controlTimer,account,accountTimer,accountOpening=false;
  let restart=false;
  const status={stage:"verify",version:state.current};
  let writes=Promise.resolve();
  const progress=fields=>{
    Object.assign(status,fields);
    const snapshot={...status};
    writes=writes.catch(()=>{}).then(()=>report(home,snapshot));
    return writes;
  };
  const controller=new AbortController();
  try {
    await progress({stage:'verify'});
    const bundle=await installed(home,state.current);
    let selectedSkills;
    updates=updateChecker(home,bundle,{signal:controller.signal,progress});
    let polling=false;
    let retrySkills;
    if(!values.smoke){
      controlTimer=setInterval(async()=>{
        if(polling)return;
        polling=true;
        try{
          if(values['parent-pid'] && await processIdentity(Number(values['parent-pid']))!==values['parent-birth'])controller.abort();
          if(await access(join(home,'stop.request')).then(()=>true,()=>false))controller.abort();
          try{
            await unlink(join(home,'updates.request'));
            if(!controller.signal.aborted){
              const check=updates.check();
              retrySkills?.(check);
            }
          }catch(error){if(error.code!=='ENOENT')throw error;}
        }catch(error){controller.abort(error);}finally{polling=false;}
      },1000);
    }
    let startupCheck;
    if(bundle.manifest.minimumSkillsVersion){
      await progress({stage:'skills'});
      selectedSkills=await prepareSkills(bundle,home);
      if(selectedSkills)await progress({loadedSkills:selectedSkills.version});
      if(!values.smoke || !selectedSkills)startupCheck=updates.check();
      while(!selectedSkills){
        await startupCheck.skills;
        controller.signal.throwIfAborted();
        selectedSkills=await prepareSkills(bundle,home);
        if(selectedSkills)break;
        if(values.smoke || !values['parent-pid']){
          throw Object.assign(Error('Compatible skills download required'),{code:'SKILLS_REQUIRED'});
        }
        // Keep the window and the independent application download alive for a retry.
        startupCheck=await new Promise((resolve,reject)=>{
          const cancel=()=>reject(controller.signal.reason);
          controller.signal.addEventListener('abort',cancel,{once:true});
          retrySkills=check=>{
            controller.signal.removeEventListener('abort',cancel);
            retrySkills=null;
            resolve(check);
          };
          if(controller.signal.aborted)cancel();
        });
      }
    }else if(!values.smoke)updates.check();
    await waitForWorkspace(values,controller.signal);
    const preferences=await optionalJson(join(home,'preferences.json'));
    if(!values.game&&!preferences?.game)throw new Error('Choose a game folder in the launcher');
    const workspace=resolve(values.game??preferences.game);
    await progress({stage:'browser'});
    const browserChoice=bundle.manifest.browserPath?chooseBrowser(await detectBrowsers(bundle.root),preferences?.browser??'auto'):undefined;
    await progress({stage:'workspace',browser:browserChoice?.id});
    const metadata=await optionalJson(join(workspace,'.en-agent','project.json'));
    if(!metadata&&!values.name)throw new Error('A new game requires a name');
    const initializer=await import(pathToFileURL(join(bundle.root,bundle.manifest.minimumSkillsVersion?'launcher/workspace/init-workspace.mjs':bundle.manifest.skillsPath+'/game-author/scripts/init-workspace.mjs')));
    await initializer.initializeWorkspace(workspace,values.name??metadata.name);
    await atomicJson(join(home,'preferences.json'),{...preferences,game:workspace});
    await progress({stage:'account'});
    if(bundle.manifest.accountPath){
      const {startAccountService}=await import(pathToFileURL(join(bundle.root,bundle.manifest.accountPath)));
      account=await startAccountService({root:bundle.root,home,browserChoice,open:url=>{
        if(process.platform!=='win32')throw new Error('Account window currently requires Windows');
        return new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',join(bundle.root,'launcher/Account.ps1'),'-AccountUrl',url],{windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',resolve);});
      }});
      accountTimer=setInterval(async()=>{if(accountOpening)return;accountOpening=true;try{await unlink(join(home,'account.request'));await account.show();}catch(e){if(e.code!=='ENOENT')console.log('Откройте аккаунт повторно кнопкой в launcher.');}finally{accountOpening=false;}},500);
    }
    await progress({stage:'opencode'});
    if(selectedSkills){
      selectedSkills=await prepareSkills(bundle,home);
      if(!selectedSkills)throw Object.assign(Error('Compatible skills download required'),{code:'SKILLS_REQUIRED'});
      await progress({loadedSkills:selectedSkills.version});
    }
    runtime=await startOpenCode(bundle,home,workspace,{accountEnvironment:account?.environment,browserChoice,selectedSkills});
    await waitForMcp(runtime,workspace,['encounter',...(bundle.manifest.toolsPath?['author_tools']:[]),...(bundle.manifest.browserPath?['browser']:[])],{onStatus:mcp=>progress({stage:'mcp',mcp})});

    if(!values.smoke){
      const session=await ensureSession(runtime,workspace);
      gui=await startGui(runtime,workspace,session);
      if(!values['no-browser'])await openGui(await gui.pair());
    }
    await syncBootstrap(home,bundle);
    await markHealthy(home);
    await progress({stage:'ready'});
    console.log('en-agent '+bundle.manifest.id+' — OpenCode '+bundle.manifest.opencode.version+' — готов');
    if(values.smoke)console.log('Configured MCP servers connected; no model calls or game mutations performed.');
    else await new Promise(resolve=>{
      let checking=false;
      const finish=()=>{clearInterval(timer);process.removeListener('SIGINT',finish);process.removeListener('SIGTERM',finish);resolve();};
      const timer=setInterval(async()=>{
        if(checking)return;checking=true;
        try{
          if(controller.signal.aborted)return finish();
          try{await unlink(join(home,'restart.request'));restart=true;return finish();}catch(e){if(e.code!=='ENOENT')throw e;}
          try{await unlink(join(home,'export.request'));await exportDiagnostics(home,join(home,'diagnostic-export.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
          await access(join(home,'stop.request')).then(finish,()=>{});
        }catch{finish();}finally{checking=false;}
      },1000);
      runtime.child.once('exit',()=>{status.runtimeExited=true;finish();});process.once('SIGINT',finish);process.once('SIGTERM',finish);
    });
    if(status.runtimeExited)throw Error('OpenCode stopped unexpectedly');
    return restart;
  } catch(error){if(controller.signal.aborted)return false;await progress({stage:'error',category:classify(error)});throw error;
  } finally {
    clearInterval(controlTimer);
    controller.abort();
    clearInterval(accountTimer);
    try{await updates?.finish();}
    finally{if(gui)await gui.close();if(runtime)await runtime.stop();if(account)await account.close();}
  }
}

async function runSelectedRelease(home, values, state) {
  const bundle = await installed(home, state.current);
  const selected = bundle.manifest.launcherPath
    ? await import(pathToFileURL(join(bundle.root, bundle.manifest.launcherPath)))
    : {run};
  if(values['wait-request']&&!bundle.manifest.minimumSkillsVersion){
    // Rollback can select a launcher predating deferred workspace selection.
    while(!values.game){
      const request=await optionalJson(values['wait-request']);
      if(request){Object.assign(values,{game:request.game,name:request.name});break;}
      if(await access(join(home,'stop.request')).then(()=>true,()=>false))return;
      if(values['parent-pid'] && await processIdentity(Number(values['parent-pid']))!==values['parent-birth'])return;
      await delay(500);
    }
  }
  while (await selected.run(home, values, state)) {}
}

async function main() {
  const {values}=parseArgs({options:{home:{type:'string'},game:{type:'string'},name:{type:'string'},request:{type:'string'},'wait-request':{type:'string'},'parent-pid':{type:'string'},'parent-birth':{type:'string'},'no-browser':{type:'boolean'},smoke:{type:'boolean'},help:{type:'boolean'}}});
  if(values.help){console.log('en-agent --game <folder> [--name <new game>] [--home <installation state>] [--no-browser] [--smoke]');return;}
  if(values.request){const request=await json(resolve(values.request));values.game=request.game;values.name=request.name;}
  const home=resolve(values.home??process.env.EN_AGENT_HOME??join(process.env.LOCALAPPDATA??homedir(),'en-agent'));
  const releaseLock=await lock(home);
  try {
    await unlink(join(home,'stop.request')).catch(e=>{if(e.code!=='ENOENT')throw e;});
    let state;
    try{state=await activatePending(home);}catch(error){
      const previous=await json(join(home,'state.json'));if(!previous.current)throw error;
      await installed(home,previous.current);
      if(error.code==='SKILLS_BUSY'){
        state=previous;
        console.log('Обновление скиллов ещё завершается. Обновление приложения сохранено для следующего запуска.');
      }else{
        state={...previous,rejected:previous.pending,pending:null};await atomicJson(join(home,'state.json'),state);
        console.log('Подготовленное обновление не прошло проверку. Запущена предыдущая версия.');
      }
    }
    if(!state.current)throw new Error('No approved bundle installed. Install an en-agent release first.');
    try {
      await runSelectedRelease(home, values, state);
    } catch (error) {
      const failed = await json(join(home, 'state.json'));
      if (error.code==='SKILLS_REQUIRED')throw error;
      if (!failed.probation || !failed.previous) throw error;
      await rejectCurrent(home);
      console.log('Проверка нового комплекта не пройдена; выполнен возврат.');
      await runSelectedRelease(home, values, await json(join(home, 'state.json')));
    }
  }catch(error){if(error.code!=='SKILLS_REQUIRED')await report(home,{stage:'error',category:classify(error)});throw error;}finally{await releaseLock();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{if(error.code==='SKILLS_REQUIRED')console.error('Для запуска нужны скиллы. Проверьте подключение и нажмите «Проверить обновления».');else console.error('Запуск не завершён. Категория: '+classify(error)+'. Откройте диагностику launcher.');process.exitCode=1;});
