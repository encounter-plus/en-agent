import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {authenticationFailure} from './account-core.mjs';

const child=new Client({name:'en-agent-account-bridge',version:'1.0.0'});
const environment={...process.env};delete environment.EN_AGENT_ACCOUNT_TOKEN;delete environment.EN_AGENT_ACCOUNT_URL;
const transport=new StdioClientTransport({command:process.execPath,args:[process.argv[2]],env:environment,stderr:'pipe'});
await child.connect(transport);transport.stderr?.resume();
const server=new Server({name:'encounter-author',version:'0.2.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async request=>{const result=await child.listTools(request.params);return {...result,tools:[...result.tools,
{name:'encounter_connect_domain',description:'Connect the saved application account to an Encounter domain confirmed by the author or taken from their game URL. Determine this later in the game folder chat. Drafting and saving credentials require no game. Never ask for passwords in chat. Legacy login opens a managed browser. Selecting a domain is not successful sign-in. Check encounter_account_status afterwards; saved:false/connected:false requires the Account window, not repeated connect or game calls.',inputSchema:{type:'object',properties:{domain:{type:'string'}},required:['domain'],additionalProperties:false}},
{name:'encounter_account_status',description:'Check account connection without exposing credentials.',inputSchema:{type:'object',properties:{},additionalProperties:false}}
]};});
server.setRequestHandler(CallToolRequestSchema,async request=>{
  if(['encounter_connect_domain','encounter_account_status'].includes(request.params.name)){
    try{const connect=request.params.name==='encounter_connect_domain';const response=await fetch(process.env.EN_AGENT_ACCOUNT_URL+(connect?'/connect':'/status'),{method:connect?'POST':'GET',headers:{Authorization:'Bearer '+process.env.EN_AGENT_ACCOUNT_TOKEN,'Content-Type':'application/json'},...(connect?{body:JSON.stringify({domain:request.params.arguments?.domain})}:{}),signal:AbortSignal.timeout(10000)});return {isError:!response.ok,content:[{type:'text',text:JSON.stringify(await response.json())}]};}catch{return {isError:true,content:[{type:'text',text:'Account service unavailable.'}]};}
  }
  const result=await child.callTool(request.params,undefined,{timeout:120000});
  if(!authenticationFailure(result))return result;
  let status='login-required';
  try{const r=await fetch(process.env.EN_AGENT_ACCOUNT_URL+'/recover',{method:'POST',headers:{Authorization:'Bearer '+process.env.EN_AGENT_ACCOUNT_TOKEN,...(request.params.arguments?.profile?{'X-En-Profile':String(request.params.arguments.profile)}:{})},signal:AbortSignal.timeout(25000)});if(r.status===409)return result;if(r.ok)status=(await r.json()).status;}catch{}
  const message=status==='connecting'?'Account connection is in progress. Complete the managed browser sign-in if shown, then check encounter_account_status. Do not replay edits.':status==='domain-required'?'No domain selected. Continue drafting without authentication, or determine the domain from the author in this game folder and use encounter_connect_domain. Never ask for passwords in chat.':status==='restored'?'Account session restored. Re-read the game and revalidate the plan before editing. The failed operation was NOT replayed.':'Encounter sign-in is required. Use the separate Account Encounter window or the launcher Account button. Never request a password in chat. After sign-in, re-read the game before editing. The failed operation was NOT replayed.';
  return {isError:true,content:[{type:'text',text:JSON.stringify({ok:false,code:'ACCOUNT_AUTH_REQUIRED',status,message})}]};
});
await server.connect(new StdioServerTransport());
process.stdin.on('end',async()=>{await child.close();await server.close();});
