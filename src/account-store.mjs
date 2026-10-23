import {spawn} from 'node:child_process';
export class AccountStore {
  constructor(script,prefix='en-skills.encounter:profile:'){this.script=script;this.prefix=prefix;}
  async execute(action,key,secret='') {
    return new Promise((resolve,reject)=>{
      const quote=s=>"'"+s.replaceAll("'","''")+"'";
      const command='[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); & '+[this.script,action,this.prefix+key].map(quote).join(' ')+'; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }';
      const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',command],{windowsHide:true,stdio:['pipe','pipe','pipe']});
      let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',x=>output+=x);child.stderr.resume();child.stdin.on('error',()=>{});
      child.once('error',()=>reject(new Error('Не удалось открыть Windows Credential Manager.')));
      child.once('exit',code=>code===0?resolve(output):code===2&&action!=='set'?resolve(null):reject(new Error('Не удалось сохранить или прочитать данные в Windows Credential Manager.')));
      child.stdin.end(secret);
    });
  }
  get(key){return this.execute('get',key);}
  set(key,value){return this.execute('set',key,value);}
  delete(key){return this.execute('delete',key);}
}
