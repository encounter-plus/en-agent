// Real OpenCode question tool and GUI with a deterministic local model; no paid inference.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {json} from '../src/storage.mjs';
import {installed} from '../src/releases.mjs';
import {startOpenCode} from '../src/opencode.mjs';

const home=resolve(process.argv[2]??'.local/exa-ready');
const work=resolve('.local/question-gui');await mkdir(work,{recursive:true});
let answered=false,requests=0,runtime,browser;
const model=createServer(async(req,res)=>{
  if(!req.url.endsWith('/chat/completions')){res.writeHead(404);res.end();return;}
  let raw='';for await(const chunk of req)raw+=chunk;
  const input=JSON.parse(raw);requests++;
  const result=input.messages.findLast(m=>m.role==='tool');
  if(result){answered=JSON.stringify(result).includes('Обсерватория');}
  const question=input.tools?.find(t=>t.function.name==='question');
  if(!result&&!question){console.log('Advertised tools:',input.tools?.map(t=>t.function.name));res.writeHead(400);res.end('Question tool missing');return;}
  const delta=result?{content:'GUI_CHECK_OK: Обсерватория'}:{tool_calls:[{index:0,id:'call_question_test',type:'function',function:{name:'question',arguments:JSON.stringify({questions:[{header:'Тема игры',question:'Какую тему выбрать для тестовой игры?',options:[{label:'Обсерватория',description:'Космос и астрономия'},{label:'Музей',description:'История и экспонаты'}]}]})}}]};
  res.writeHead(200,{'content-type':'text/event-stream'});
  const chunk=(delta,finish_reason=null)=>'data: '+JSON.stringify({id:'chatcmpl-test',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n';
  res.end(chunk({role:'assistant'})+chunk(delta)+chunk({},result?'stop':'tool_calls')+'data: [DONE]\n\n');
});
await new Promise(ok=>model.listen(0,'127.0.0.1',ok));
const config=join(work,'provider.json');
await writeFile(config,JSON.stringify({providers:{fixture:{name:'Local GUI test',package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'synthetic'},models:{fixture:{name:'Local fixture',capabilities:{tools:true},limit:{context:32000,output:2000}}}}}}));
const previous=process.env.OPENCODE_CONFIG;process.env.OPENCODE_CONFIG=config;
try {
  const bundle=await installed(home,(await json(join(home,'state.json'))).current);
  runtime=await startOpenCode(bundle,join(work,'state'),work);
  const post=async(path,body)=>{const response=await runtime.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const text=await response.text();assert.ok(response.ok,`${path}: ${response.status} ${text}`);return text?JSON.parse(text):null;};
  const title='en-agent question GUI check '+Date.now();
  const session=(await post('/api/session',{title,location:{directory:work},model:{providerID:'fixture',id:'fixture'},permissions:[{action:'question',resource:'*',effect:'allow'}]})).data;
  console.log('Session created');
  browser=await chromium.launch({channel:'msedge',headless:false});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  try{await page.goto(await runtime.pair(),{waitUntil:'domcontentloaded'});}catch(error){if(!error.message.includes('ERR_ABORTED'))throw error;}
  await page.goto(runtime.url,{waitUntil:'domcontentloaded'});
  await post(`/api/session/${session.id}/prompt`,{text:'Задай тестовый вопрос о теме игры через question и после ответа подтверди выбор.'});
  await page.waitForTimeout(4000);
  await page.screenshot({path:join(work,'initial.png')});
  await page.getByText(title,{exact:true}).first().click({timeout:20000});
  await page.getByText('Какую тему выбрать для тестовой игры?',{exact:true}).waitFor({timeout:45000});
  await page.screenshot({path:join(work,'question.png')});
  await page.getByText('Обсерватория',{exact:true}).first().click();
  await page.getByRole('button',{name:/submit|continue|отправить|подтвердить/i}).last().click();
  await page.getByText('GUI_CHECK_OK: Обсерватория',{exact:false}).first().waitFor({timeout:30000});
  assert.ok(answered,'Selected GUI answer must reach the next model request');
  await page.screenshot({path:join(work,'answered.png')});
  console.log('PASS: actual question tool → visible GUI → selected answer → next model turn; requests='+requests);
}finally{
  if(browser)await browser.close();if(runtime)await runtime.stop();
  await new Promise(ok=>model.close(ok));
  if(previous===undefined)delete process.env.OPENCODE_CONFIG;else process.env.OPENCODE_CONFIG=previous;
}
