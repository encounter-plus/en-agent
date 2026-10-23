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
import {installed,activatePending,stageUpdate,markHealthy,rejectCurrent,syncBootstrap} from './releases.mjs';
import {startOpenCode,openGui,waitForMcp} from './opencode.mjs';

// Bootstrap holds the installation lock and verifies the selected bundle before importing this entry.
export async function run(home,values,state) {
  let runtime,gui,update,account,accountTimer,accountOpening=false;
  let restart=false;
  const status={stage:"verify",version:state.current};
  const progress=async fields=>{Object.assign(status,fields);await report(home,status);};
  const controller=new AbortController();
  try {
    await progress({stage:'verify'});
    const preferences=await optionalJson(join(home,'preferences.json'));
    if(!values.game&&!preferences?.game)throw new Error('Choose a game folder in the launcher');
    const workspace=resolve(values.game??preferences.game);
    const bundle=await installed(home,state.current);
    await progress({stage:'browser'});
    const browserChoice=bundle.manifest.browserPath?chooseBrowser(await detectBrowsers(bundle.root),preferences?.browser??'auto'):undefined;
    await progress({stage:'workspace',browser:browserChoice?.id});
    const metadata=await optionalJson(join(workspace,'.en-agent','project.json'));
    if(!metadata&&!values.name)throw new Error('A new game requires a name');
    const initializer=await import(pathToFileURL(join(bundle.root,bundle.manifest.skillsPath,'game-author/scripts/init-workspace.mjs')));
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
    runtime=await startOpenCode(bundle,home,workspace,{accountEnvironment:account?.environment,browserChoice});
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
    const channel=await optionalJson(join(home,'channel.json'));
    if(channel&&!values.smoke)update=stageUpdate(home,channel,{signal:controller.signal}).then(async result=>{await progress({update:result.status});
      if(result.status==='staged')console.log('Обновление '+result.id+' подготовлено к следующему запуску.');
    }).catch(async()=>{if(!controller.signal.aborted)await progress({update:'failed'});if(!controller.signal.aborted)console.log('Проверка обновления не завершена. Используется установленная версия.');});
    if(values.smoke)console.log('Configured MCP servers connected; no model calls or game mutations performed.');
    else await new Promise(resolve=>{
      let checking=false;
      const finish=()=>{clearInterval(timer);process.removeListener('SIGINT',finish);process.removeListener('SIGTERM',finish);resolve();};
      const timer=setInterval(async()=>{
        if(checking)return;checking=true;
        try{
          if(values['parent-pid']&&await processIdentity(Number(values['parent-pid']))!==values['parent-birth'])return finish();
          try{await unlink(join(home,'restart.request'));restart=true;return finish();}catch(e){if(e.code!=='ENOENT')throw e;}
          try{await unlink(join(home,'export.request'));await exportDiagnostics(home,join(home,'diagnostic-export.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
          await access(join(home,'stop.request')).then(finish,()=>{});
        }catch{finish();}finally{checking=false;}
      },1000);
      runtime.child.once('exit',()=>{status.runtimeExited=true;finish();});process.once('SIGINT',finish);process.once('SIGTERM',finish);
    });
    if(status.runtimeExited)throw Error('OpenCode stopped unexpectedly');
    return restart;
  } catch(error){await progress({stage:'error',category:classify(error)});throw error;
  } finally {
    controller.abort();clearInterval(accountTimer);if(update)await update;if(gui)await gui.close();if(runtime)await runtime.stop();if(account)await account.close();
  }
}

async function runSelectedRelease(home, values, state) {
  const bundle = await installed(home, state.current);
  const selected = bundle.manifest.launcherPath
    ? await import(pathToFileURL(join(bundle.root, bundle.manifest.launcherPath)))
    : {run};
  while (await selected.run(home, values, state)) {}
}

async function main() {
  const {values}=parseArgs({options:{home:{type:'string'},game:{type:'string'},name:{type:'string'},request:{type:'string'},'parent-pid':{type:'string'},'parent-birth':{type:'string'},'no-browser':{type:'boolean'},smoke:{type:'boolean'},help:{type:'boolean'}}});
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
      state={...previous,rejected:previous.pending,pending:null};await atomicJson(join(home,'state.json'),state);
      console.log('Подготовленное обновление не прошло проверку. Запущена предыдущая версия.');
    }
    if(!state.current)throw new Error('No approved bundle installed. Install an en-agent release first.');
    try {
      await runSelectedRelease(home, values, state);
    } catch (error) {
      const failed = await json(join(home, 'state.json'));
      if (!failed.probation || !failed.previous) throw error;
      await rejectCurrent(home);
      console.log('Проверка нового комплекта не пройдена; выполнен возврат.');
      await runSelectedRelease(home, values, await json(join(home, 'state.json')));
    }
  }catch(error){await report(home,{stage:'error',category:classify(error)});throw error;}finally{await releaseLock();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error('Запуск не завершён. Категория: '+classify(error)+'. Откройте диагностику launcher.');process.exitCode=1;});
