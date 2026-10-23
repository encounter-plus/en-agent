import {detectBrowsers,chooseBrowser,browserLaunchOptions} from '../src/browser-choice.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {legacyBrowserLogin} from '../src/account-browser.mjs';
import {startAccountService} from '../dist/account-service.mjs';
await mkdir('.local/account-check',{recursive:true});
let checked=false;
const attempt=legacyBrowserLogin('',{domain:'fixture.en.cx',username:'Тестовый автор'},'synthetic-only',{launchBrowser:async()=>{
 const choice=chooseBrowser(await detectBrowsers('.', {playwright:await import('playwright')}));const b=await chromium.launch(browserLaunchOptions(choice));const create=b.newContext.bind(b);
 b.newContext=async()=>{const context=await create();await context.route('https://fixture.en.cx/**',route=>route.fulfill({contentType:'text/html',body:'<form action="/Login.aspx" method="post"><input type="text"><input type="password"><button>Войти</button></form>'}));context.on('page',page=>{void (async()=>{await page.locator('input[type=password]').waitFor();await page.waitForFunction(()=>document.querySelector('input[type=password]').value==='synthetic-only');assert.equal(await page.locator('input[type=text]').inputValue(),'Тестовый автор');checked=true;await context.addCookies([{name:'auth',value:'synthetic-cookie',url:'https://fixture.en.cx',httpOnly:true,secure:true}]);await page.setContent('<a href="/Login.aspx?action=logout">Выход</a><a class="white bold no_decoration" href="/UserDetails.aspx">'+(process.env.EN_TEST_DIFFERENT_USER?'Другой автор':'Тестовый автор')+'</a><a id="lnkUserName" href="/UserDetails.aspx">My profile</a>');})();});return context;};return b;
}});
let jar;if(process.env.EN_TEST_DIFFERENT_USER){await assert.rejects(attempt,/другим пользователем/);}else{jar=await attempt;assert(jar.cookies.some(c=>c.name==='auth'));}assert(checked);console.log('Selected legacy browser autofill/session capture passed with synthetic fixtures.');
