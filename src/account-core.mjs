import {createHash,randomUUID} from 'node:crypto';
import {saveProfile,readProfiles,writeProfiles} from '../../en-skills/runtime/src/config.ts';
import {resolveEngineProfile} from '../../en-skills/src/engine-profile.ts';
import {parseLegacyCookieJar,legacyCredentialKey} from '../../en-skills/src/node-legacy-session.ts';

export function profileFor(home,domain,username) {
  const engine=resolveEngineProfile(domain).engine;
  return {name:'en-agent-'+createHash('sha256').update(home+'\0'+domain).digest('hex').slice(0,24),domain,username,apiBaseUrl:'https://api.en.cx',webBaseUrl:'https://'+domain,engine};
}
export function authenticationFailure(result) {
  if(!result?.isError)return false;
  const e=result.structuredContent?.error;
  const text=e?.message??result.content?.filter(x=>x.type==='text').map(x=>x.text).join(' ')??'';
  // A 403, network failure, human checkpoint or uncertain write is not an invalid password.
  if(/403|unknown-after-dispatch|outcome unknown|human-verification|Network error/i.test(text))return false;
  return /HTTP 401\b|not authenticated|Author authentication required|No active profile|Import an authorized legacy browser session|Legacy browser session expired|Legacy authorization\/redirect checkpoint|Legacy authenticated author\/CAPTCHA checkpoint/i.test(text);
}
export class AccountManager {
  constructor({home,dataDir,store,fetchImpl=fetch,legacyLogin}) {Object.assign(this,{home,dataDir,store,fetchImpl,legacyLogin});this.message='';this.busy=false;this.needsLogin=false;this.recoveryUsed=false;}
  async active(){const f=await readProfiles(this.dataDir);return f.profiles[f.activeProfile]??null;}
  accountKey(){return 'account:en-agent-'+createHash('sha256').update(this.home).digest('hex').slice(0,24);}
  async savedAccount(){const raw=await this.store.get(this.accountKey());try{return raw?JSON.parse(raw):null;}catch{throw new Error('Не удалось прочитать сохранённый аккаунт. Введите пароль повторно.');}}
  async status(){const p=await this.active(),account=await this.savedAccount();return {domain:p?.domain??'',username:account?.username??'',saved:!!account,connected:!!p&&!this.needsLogin&&!!await this.store.get(this.sessionKey(p)),busy:this.busy,message:this.message};}
  sessionKey(p){return resolveEngineProfile(p.domain).engine==='legacy'?legacyCredentialKey(p.name):p.name;}
  async modern(p,password){
    let r;try{r=await this.fetchImpl('https://api.en.cx/login',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-En-Domain':p.domain},body:JSON.stringify({login:p.username,password,shared_computer:false}),signal:AbortSignal.timeout(20000)});}catch{throw new Error('Сеть или сервер недоступны. Сохранённый пароль не изменён.');}
    if(r.status===401||r.status===400){const e=new Error('Вход отклонён. Проверьте логин и пароль.');e.auth=true;throw e;}
    if(!r.ok)throw new Error('Сервер не завершил вход (HTTP '+r.status+'). Попробуйте позже.');
    let body;try{body=await r.json();}catch{throw new Error('Некорректный ответ сервера входа.');}
    const token=body.token??body.access_token??body.accessToken;if(typeof token!=='string'||!token)throw new Error('Сервер не вернул сессию.');return token;
  }
  async login({domain,username,password,useSaved=false},recovering=false) {
    if(this.busy)throw new Error('Вход уже выполняется.');
    username=String(username??'').trim();
    if(!username||username.length>200)throw new Error('Укажите логин.');
    this.busy=true;
    try {
    if(useSaved){const value=await this.savedAccount();if(value?.username!==username)throw new Error('Введите пароль для этого логина.');password=value.password;}
    if(typeof password!=='string'||!password||password.length>512)throw new Error('Введите пароль (до 512 символов).');
    domain=String(domain??(await this.active())?.domain??'').trim().toLowerCase();
    if(!domain){await this.store.set(this.accountKey(),JSON.stringify({username,password}));this.needsLogin=false;this.recoveryUsed=false;this.message='Аккаунт сохранён. Игра пока не нужна. Вход будет проверен после выбора домена в чате.';return {ok:true,verified:false};}
    const p=profileFor(this.home,domain,username);
    this.busy=true;this.message=p.engine==='legacy'?'Откроется браузер агента. Поля и Sign in выполняются автоматически; при необходимости пройдите проверку сайта.':'Выполняется вход…';
      let secret;
      if(p.engine==='modern')secret=await this.modern(p,password);
      else{const browserSession=await this.legacyLogin(p,password);if(browserSession.submittedPassword)password=browserSession.submittedPassword;secret=JSON.stringify(parseLegacyCookieJar({...browserSession,importId:randomUUID()},p.domain));}
      const sessionKey=this.sessionKey(p),accountKey=this.accountKey();
      const previous=await this.active(),oldSession=await this.store.get(sessionKey),oldAccount=await this.store.get(accountKey);
      try{await this.store.set(sessionKey,secret);await this.store.set(accountKey,JSON.stringify({username,password}));await saveProfile(p,{activate:true,dataDir:this.dataDir});}
      catch(e){for(const [key,value] of [[sessionKey,oldSession],[accountKey,oldAccount]]){if(value===null)await this.store.delete(key);else await this.store.set(key,value);}throw e;}
      if(previous&&previous.name!==p.name&&previous.name===profileFor(this.home,previous.domain,previous.username).name){await this.store.delete(this.sessionKey(previous));const f=await readProfiles(this.dataDir);delete f.profiles[previous.name];await writeProfiles(f,this.dataDir);}
      this.needsLogin=false;if(!recovering)this.recoveryUsed=false;this.message='Аккаунт подключён. Вернитесь в чат; перед изменением агент должен перечитать игру.';
      return {ok:true};
    }catch(e){this.message=e.message;if(e.auth)this.needsLogin=true;throw e;}finally{this.busy=false;password='';}
  }
  async connect(domain){
    if(this.busy)throw new Error('Вход уже выполняется.');
    domain=String(domain??'').trim().toLowerCase();const saved=await this.savedAccount();const p=profileFor(this.home,domain,saved?.username??'');
    const active=await this.active();
    if(active?.name===p.name&&!this.needsLogin&&await this.store.get(this.sessionKey(p)))return {status:'connected',domain};
    await saveProfile(p,{activate:true,dataDir:this.dataDir});
    if(active&&active.name!==p.name&&active.name===profileFor(this.home,active.domain,active.username).name){await this.store.delete(this.sessionKey(active));const f=await readProfiles(this.dataDir);delete f.profiles[active.name];await writeProfiles(f,this.dataDir);}
    if(!saved){this.message='Домен выбран в чате. Введите логин и пароль в окне аккаунта.';return {status:'login-required'};}
    try{await this.login({domain,username:saved.username,useSaved:true});return {status:'connected',domain};}catch{return {status:'login-required'};}
  }
  async recover(){
    if(this.busy||this.needsLogin)return {status:'login-required'};
    this.needsLogin=true;
    const p=await this.active();
    if(!p){this.needsLogin=false;return {status:'domain-required'};}
    if(p&&!this.recoveryUsed&&resolveEngineProfile(p.domain).engine==='modern'){
      this.recoveryUsed=true;
      try {const saved=await this.savedAccount();await this.login({domain:p.domain,username:saved?.username??p.username,useSaved:true},true);return {status:'restored',rereadRequired:true};}catch{}
    }
    this.message='Нужно восстановить вход. Проверьте аккаунт и нажмите «Войти». Для старого движка откроется браузер агента.';
    return {status:'login-required'};
  }
  async forget(){if(this.busy)throw new Error('Сначала завершите или закройте окно входа.');const p=await this.active();if(p){await this.store.delete(this.sessionKey(p));const f=await readProfiles(this.dataDir);delete f.profiles[p.name];delete f.activeProfile;await writeProfiles(f,this.dataDir);}await this.store.delete(this.accountKey());this.needsLogin=false;this.message='Аккаунт удалён из en-agent.';return {ok:true};}
}
