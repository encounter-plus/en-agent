import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {startAccountService} from '../dist/account-service.mjs';
const manager={message:'',status:async()=>({domain:'',username:'',busy:false,connected:false,message:manager.message}),login:async input=>{assert.equal(input.domain,undefined);assert.equal(input.username,'Synthetic Author');assert.equal(input.password,'synthetic-only');manager.called=true;manager.message='Synthetic login received';return {ok:true};}};
const service=await startAccountService({manager,open:async()=>{}});
await mkdir('.local/account-check',{recursive:true});
const source=await readFile('Account.ps1','utf8');
const driver=`
$testTimer = New-Object System.Windows.Forms.Timer; $testTimer.Interval = 500
$testTimer.Add_Tick({ if($script:initialized) {
  $testTimer.Stop()
  if(![EnAgentAccountConsole]::IsWindowVisible($form.Handle)){throw 'Account GUI must be visible'}
  if([EnAgentAccountConsole]::IsWindowVisible([EnAgentAccountConsole]::GetConsoleWindow())){throw 'Console must be hidden'}
  if(!$password.UseSystemPasswordChar){throw 'Password masking must be enabled'}
  $username.Text='Synthetic Author'; $password.Text='synthetic-only'
  $bitmap = New-Object Drawing.Bitmap($form.Width,$form.Height)
  $form.DrawToBitmap($bitmap,[Drawing.Rectangle]::new(0,0,$form.Width,$form.Height))
  $bitmap.Save('${resolve('.local/account-check/native.png').replaceAll("'","''")}'); $bitmap.Dispose()
  $login.PerformClick()
} })
$form.Add_Shown({$testTimer.Start()})
`;
const marker='$timer.Start(); [void]$form.ShowDialog(); $timer.Dispose()';assert(source.includes(marker));
const testScript=resolve('.local/account-check/native-fixture.ps1');await writeFile(testScript,'\uFEFF'+source.replace(/^\uFEFF/,'').replace(marker,driver+'\n'+marker));
const child=spawn('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',testScript,'-AccountUrl',service.url],{windowsHide:true,stdio:['ignore','ignore','pipe']});let nativeError='';child.stderr.on('data',x=>nativeError+=x);
try {
 await new Promise((ok,fail)=>{child.once('spawn',ok);child.once('error',fail);});
 const deadline=Date.now()+30000;while(!manager.called&&Date.now()<deadline&&child.exitCode===null)await new Promise(r=>setTimeout(r,100));assert(manager.called,'Native form must submit to the real account endpoint');console.log('Native form rendered with password masking and delivered credentials through its button handler to the local host.');
}catch(e){if(nativeError)console.error(nativeError);throw e;}finally{child.kill();await service.close();}
