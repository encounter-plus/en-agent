import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AccountStore} from './account-store.mjs';

export function exaStore(root,home) {
  const scope=createHash('sha256').update(resolve(home).toLowerCase()).digest('hex');
  return new AccountStore(join(root,'runtime/scripts/windows-credential.ps1'),'en-agent.exa:'+scope+':');
}
export function validKey(value) {
  if(typeof value!=='string'||!value.trim()||value.trim().length>2048||/[^\x21-\x7e]/.test(value.trim()))throw new Error('Введите корректный API-ключ Exa.');
  return value.trim();
}
export async function exaEnvironment(store,env) {
  const saved=await store.get('api-key');
  return saved?{...env,EXA_API_KEY:validKey(saved)}:{...env};
}
export async function exaAction(store,action,key='',{env=process.env,request=fetch}={}) {
  if(action==='status')return {ok:true,message:await store.get('api-key')?'Ключ сохранён для этой установки.':env.EXA_API_KEY?'Используется EXA_API_KEY из окружения.':'Ключ не сохранён. Добавьте свой ключ Exa.'};
  if(action==='save') { await store.set('api-key',validKey(key));return {ok:true,changed:true,message:'Ключ сохранён. Для применения к чату перезапустите en-agent.'}; }
  if(action==='delete') { await store.delete('api-key');return {ok:true,changed:true,message:env.EXA_API_KEY?'Сохранённый ключ удалён. После перезапуска используется EXA_API_KEY из окружения.':'Ключ удалён. Изменение применяется после перезапуска.'}; }
  if(action!=='test')throw new Error('Неизвестное действие.');
  const candidate=validKey(key||await store.get('api-key')||env.EXA_API_KEY);
  let response;
  try { response=await request('https://api.exa.ai/search',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','x-api-key':candidate},body:JSON.stringify({query:'Exa search documentation',type:'fast',numResults:1}),signal:AbortSignal.timeout(15000)}); }
  catch { return {ok:false,message:'Не удалось связаться с Exa. Проверьте интернет и повторите проверку.'}; }
  if(!response.ok) {
    await response.body?.cancel();
    const message=({401:'Ключ не принят Exa. Проверьте или замените его.',403:'Exa отказал в доступе. Проверьте права ключа в кабинете.',402:'Exa требует оплату. Проверьте баланс и тариф в кабинете.',429:'Превышен лимит запросов Exa. Подождите и проверьте лимиты.'})[response.status]??'Exa вернул ошибку. Попробуйте позже.';
    return {ok:false,message};
  }
  try { if(!Array.isArray((await response.json()).results))throw new Error(); }
  catch { return {ok:false,message:'Получен неожиданный ответ Exa. Проверка не подтверждена.'}; }
  return {ok:true,message:'Поиск работает. Проверка не сохраняет введённый ключ.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>8192)throw new Error();}
    const {action,key}=JSON.parse(input);
    const result=await exaAction(exaStore(process.argv[2],process.argv[3]),action,key);
    console.log(JSON.stringify(result));
  } catch { console.log(JSON.stringify({ok:false,message:'Операция не выполнена. Проверьте ключ и доступ к Windows Credential Manager.'}));process.exitCode=1; }
}
