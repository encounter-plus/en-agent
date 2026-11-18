import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {prepareSkills,inspectSkills,updateSkills} from '../src/skills-store.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('built author MCP exposes tools and serves a preview through real stdio protocol',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'en-mcp-'));
  const client=new Client({name:'en-agent-test',version:'1.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/tools-server.mjs')],cwd:workspace,stderr:'pipe'});
  try {
    await mkdir(join(workspace,'artifacts'));await writeFile(join(workspace,'artifacts','level.html'),'<h1>Уровень</h1>');
    await client.connect(transport);
    const tools=(await client.listTools()).tools;
    const names=tools.map(t=>t.name);
    for(const name of ['wikipedia_search','wikipedia_read','google_public_read','preview_html'])assert.ok(names.includes(name));
    assert.ok(!names.includes('web_search'));
    for(const name of ['google_private_doc_read','google_sheet_read','google_sheet_prepare']) {
      assert.ok(!names.includes(name),name+' must be removed from the catalog');
      const removed=await client.callTool({name,arguments:{}});
      assert.equal(removed.isError,true,'Retired tool must not remain callable');
    }
    assert.deepEqual(tools.find(t=>t.name==='wikipedia_read').inputSchema.properties.mode.enum,['article','infobox']);
    const result=await client.callTool({name:'preview_html',arguments:{path:'level.html'}});
    assert.ok(!result.isError);
    const url=JSON.parse(result.content[0].text).url;
    assert.match(await (await fetch(url)).text(),/Уровень/);
  }finally{await client.close();await rm(workspace,{recursive:true,force:true});}
});

test('managed author MCP exposes skills status/update and calls the safe updater',async()=>{
  const home=await mkdtemp(join(tmpdir(),'en-skills-mcp-')),root=join(home,'bundle'),skills=join(root,'skills');
  const client=new Client({name:'skills-update-test',version:'1.0'});
  try {
    await mkdir(join(skills,'game-author'),{recursive:true});
    await writeFile(join(skills,'game-author/SKILL.md'),'---\nname: game-author\ndescription: Synthetic\n---\nSynthetic skill');
    const files=(await inspectSkills(skills)).map(f=>({...f,path:'skills/'+f.path}));
    const selected=await prepareSkills({root,manifest:{id:'0.1.0',skillsVersion:'1.0.0',skillsPath:'skills',files}},home);
    const preload=join(home,'network-fixture.mjs');
    await writeFile(preload,"globalThis.fetch=async url=>{if(url!=='https://api.github.com/repos/encounter-plus/en-skills/releases/latest')throw Error('Unexpected external request');return Response.json({tag_name:'0.0.1',draft:false,prerelease:false,assets:[]});};");
    const transport=new StdioClientTransport({command:process.execPath,args:['--import',pathToFileURL(preload).href,resolve('dist/tools-server.mjs')],cwd:home,stderr:'pipe',env:{...process.env,EN_AGENT_HOME:home,EN_AGENT_BUNDLE_ROOT:root,EN_AGENT_SKILLS_ACTIVE:selected.directory}});
    await client.connect(transport);
    const names=(await client.listTools()).tools.map(t=>t.name);assert.ok(names.includes('en_skills_update'));assert.ok(names.includes('en_skills_status'));
    const status=await client.callTool({name:'en_skills_status',arguments:{}});assert.ok(!status.isError);assert.equal(JSON.parse(status.content[0].text).version,'1.0.0');
    const update=await client.callTool({name:'en_skills_update',arguments:{}});assert.ok(!update.isError);assert.deepEqual(JSON.parse(update.content[0].text),{status:'current',version:'1.0.0',restartRequired:false});
    await updateSkills(home,async()=>({directory:skills,version:'1.1.0',source:'synthetic'}));
    const repeated=await client.callTool({name:'en_skills_update',arguments:{}});assert.ok(!repeated.isError);assert.deepEqual(JSON.parse(repeated.content[0].text),{status:'current',version:'1.1.0',restartRequired:true});
  }finally{await client.close();await rm(home,{recursive:true,force:true});}
});
