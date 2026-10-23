import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {extractWikipedia,wikipediaRead} from '../src/wiki.mjs';
import {startPreview} from '../src/preview.mjs';

test('Wikipedia preserves table fields and literal answers separately from article',async()=>{
  const html='<table class="infobox"><tr><th>Имя</th><td>Конь6<br>кон66</td></tr><tr><td colspan="2">Заголовок</td></tr></table><p>Статья</p><script>bad()</script>';
  const result=extractWikipedia(html);
  assert.equal(result.infoboxes[0].rows[0].cells[1].text,'Конь6\nкон66');
  assert.equal(result.article,'Статья');
  const read=await wikipediaRead('ru','Проверка',async()=>new Response(JSON.stringify({parse:{title:'Проверка',text:html,revid:42,sections:[]}})));
  assert.equal(read.revision,42);assert.equal(read.infoboxStatus,'present');
  const card=await wikipediaRead('ru','Проверка',async()=>Response.json({parse:{title:'Проверка',text:html,revid:42,sections:[]}}),'infobox');
  assert.deepEqual(card.infoboxes,read.infoboxes);assert.equal(card.revision,42);
  for(const key of ['article','articleTruncated','sections'])assert.ok(!(key in card));
  const absent=await wikipediaRead('ru','Без карточки',async()=>Response.json({parse:{title:'Без карточки',text:'<p>Текст</p>',revid:1}}),'infobox');
  assert.equal(absent.infoboxStatus,'absent_in_returned_html');assert.deepEqual(absent.infoboxes,[]);
});

test('preview serves only artifacts and changes reload version when a sibling asset changes',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'en-preview-'));let preview;
  try {
    await mkdir(join(workspace,'artifacts'));await writeFile(join(workspace,'GAME.md'),'private');
    await writeFile(join(workspace,'artifacts','index.html'),'<h1>Level</h1>');
    await writeFile(join(workspace,'artifacts','.secret'),'private');
    preview=await startPreview(workspace);
    const response=await fetch(preview.url+'index.html');assert.equal(response.status,200);assert.match(await response.text(),/location.reload/);
    const before=await (await fetch(preview.url+'__version')).text();
    await writeFile(join(workspace,'artifacts','style.css'),'body {color: red}');
    const after=await (await fetch(preview.url+'__version')).text();assert.notEqual(before,after);
    assert.equal((await fetch(preview.url+'%2e%2e%2fGAME.md')).status,404);
    assert.equal((await fetch(preview.url+'.secret')).status,404);
    assert.equal((await fetch(preview.url+'index.html',{method:'POST'})).status,405);
  }finally{if(preview)await preview.close();await rm(workspace,{recursive:true,force:true});}
});
