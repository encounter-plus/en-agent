import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {startAccountService} from '../dist/account-service.mjs';
let saved=false;const manager={message:'',status:async()=>({username:saved?'Author':'',saved,busy:false,connected:!saved,message:''}),login:async()=>{await new Promise(r=>setTimeout(r,1200));saved=true;return {ok:true};}};
const service=await startAccountService({manager,open:async()=>{}});await mkdir('.local/account-check',{recursive:true});
let source=await readFile('Account.ps1','utf8');const result=resolve('.local/account-check/regression.json');
await rm(result,{force:true});
const driver=`
$script:phase=0
$testTimer=New-Object Windows.Forms.Timer; $testTimer.Interval=300
$testTimer.Add_Tick({try {
 if(!$script:initialized){return}
 if($script:phase -eq 0){
  if($status.Text -eq 'Аккаунт сохранён.'){throw 'False saved status for session without saved account'}
  $username.Text='Author'; $password.Text='synthetic'; $login.PerformClick(); $script:phase=1; return
 }
 if($script:phase -eq 1){if($script:pending){if($status.Text -eq 'Аккаунт сохранён.'){throw 'Premature saved status'};return};if($status.Text -ne 'Аккаунт сохранён.'){return};$password.Text='changed';$script:phase=2;return}
 if($script:phase -eq 2){if($status.Text -eq 'Аккаунт сохранён.'){throw 'Saved status shown for edited fields'};if(!$back){throw 'Missing Back button'};[IO.File]::WriteAllText('${result.replaceAll("'","''")}','{"ok":true}');$back.PerformClick();$testTimer.Stop()}
 }catch{[IO.File]::WriteAllText('${result.replaceAll("'","''")}', $_.Exception.Message);$testTimer.Stop();$form.Close()}})
$form.Add_Shown({$testTimer.Start()})
`;
const marker='$timer.Start(); [void]$form.ShowDialog(); $timer.Dispose()';assert(source.includes(marker));const path=resolve('.local/account-check/regression.ps1');await writeFile(path,'\uFEFF'+source.replace(/^\uFEFF/,'').replace(marker,driver+'\n'+marker));
const children=[];const launch=p=>{const c=spawn('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',p,'-AccountUrl',service.url],{windowsHide:false,stdio:['ignore','ignore','pipe']});children.push(c);c.stderr.resume();return c;};
try{const first=launch(path);await new Promise(r=>setTimeout(r,1500));const second=launch(resolve('Account.ps1'));await new Promise(r=>setTimeout(r,2000));assert.equal(second.exitCode,0,'Duplicate account process must exit');await new Promise((ok,fail)=>{if(first.exitCode!==null)return ok();const timer=setTimeout(()=>fail(Error('Form regression timed out')),12000);first.once('exit',()=>{clearTimeout(timer);ok();});});assert.equal(JSON.parse(await readFile(result,'utf8')).ok,true);console.log('Single window, truthful saved state, edited fields and Back passed.');}finally{for(const c of children)if(c.exitCode===null)c.kill();await service.close();}
