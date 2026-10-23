import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {detectBrowsers,chooseBrowser,browserLaunchOptions} from '../src/browser-choice.mjs';
import {legacyBrowserLogin} from '../src/account-browser.mjs';
import {resolve} from 'node:path';
const choice=chooseBrowser(await detectBrowsers(resolve('.'),{playwright:await import('playwright')}));let posts=0;let deadline;
const jar=await legacyBrowserLogin('',{domain:'fixture.en.cx',username:'Author'},'synthetic-only',{launchBrowser:async()=>{
 const browser=await chromium.launch(browserLaunchOptions(choice));deadline=setTimeout(()=>browser.close().catch(()=>{}),20000);const original=browser.newContext.bind(browser);
 browser.newContext=async()=>{const context=await original();await context.route('https://fixture.en.cx/**',async route=>{
 if(route.request().method()==='POST'){posts++;const data=new URLSearchParams(route.request().postData());assert.equal(data.get('Login'),'Author');assert.equal(data.get('Password'),'synthetic-only');assert.equal(data.get('hidden'),'preserved');await context.addCookies([{name:'auth',value:'synthetic-cookie',url:'https://fixture.en.cx'}]);return route.fulfill({contentType:'text/html',body:'<a class="white bold" href="/UserDetails.aspx">Author</a><a id="lnkUserName" href="/UserDetails.aspx">Profile</a><a href="/Login.aspx?action=logout">Logout</a>'});}
 return route.fulfill({contentType:'text/html',body:'<form method="post" action="/Login.aspx"><input type="hidden" name="hidden" value="preserved"><input name="Login" type="text"><input name="Password" type="Password"><input type="submit" value="Sign In"></form>'});});return context;};return browser;
}});clearTimeout(deadline);assert.equal(posts,1);assert(jar.cookies.some(c=>c.name==='auth'));console.log('Sign In submitted once, hidden fields preserved, authenticated identity confirmed.');
