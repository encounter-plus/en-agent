import {browserLaunchOptions} from './browser-choice.mjs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
export async function legacyBrowserLogin(root,profile,password,{onBrowser=()=>{},launchBrowser,browserChoice}={}) {
  if(!launchBrowser){const playwright=await import(pathToFileURL(join(root,'browser/node_modules/playwright/index.mjs')));launchBrowser=()=>playwright[browserChoice.engine].launch(browserLaunchOptions(browserChoice));}
  const browser=await launchBrowser();onBrowser(browser);
  try {
    const context=await browser.newContext();const page=await context.newPage();let submittedPassword=password,loginAction,passwordName;
    const origin='https://'+profile.domain;
    page.on('request',request=>{if(passwordName&&request.method()==='POST'&&request.url()===loginAction){const value=new URLSearchParams(request.postData()??'').get(passwordName);if(value&&value.length<=512)submittedPassword=value;}});
    await page.goto(origin+'/Login.aspx',{waitUntil:'domcontentloaded',timeout:30000});
    // Autofill only an unambiguous password form submitting to the selected HTTPS tenant.
    if(new URL(page.url()).origin===origin){
      const form=page.locator('form').filter({has:page.locator('input[type=password]')});
      if(await form.count()===1){
        const action=await form.getAttribute('action');
        if(new URL(action||page.url(),page.url()).origin===origin){
          const user=form.locator('input[type=text], input[type=email], input:not([type])');const pass=form.locator('input[type=password]');
          if(await pass.count()===1){passwordName=await pass.getAttribute('name');loginAction=new URL(action||page.url(),page.url()).href;}
          if(await user.count()===1&&await pass.count()===1){
            await user.fill(profile.username);await pass.fill(password);
            const submit=form.getByRole('button',{name:/^(sign\s*in|log\s*in|войти|вход)$/i});
            // Send once through the site's button, preserving validation and hidden fields.
            // If a CAPTCHA or disabled button prevents it, leave the browser for the user.
            if(await submit.count()===1&&await submit.isVisible()&&await submit.isEnabled())await submit.click({timeout:5000}).catch(()=>{});
          }
        }
      }
    }
    const deadline=Date.now()+5*60*1000;
    while(Date.now()<deadline){
      if(!browser.isConnected()||page.isClosed())throw new Error('Вход отменён. Можно повторить в окне аккаунта.');
      if(new URL(page.url()).origin===origin){
        const logout=page.locator('a[href="/Login.aspx?action=logout"]');
        const profileLink=page.locator('a#lnkUserName[href="/UserDetails.aspx"]');
        const identity=page.locator('a.white.bold[href="/UserDetails.aspx"]');
        if(await logout.count()>0&&await profileLink.count()===1&&await identity.count()===1){
          const observed=(await identity.innerText()).trim();
          if(observed.toLowerCase()!==profile.username.toLowerCase())throw new Error('В браузере выполнен вход другим пользователем. Укажите его логин в окне аккаунта.');
          return {cookies:await context.cookies(origin),userAgent:await page.evaluate(()=>navigator.userAgent),submittedPassword};
        }
      }
      await new Promise(r=>setTimeout(r,750));
    }
    throw new Error('Время ожидания входа истекло. Попробуйте снова.');
  } catch(e) {
    const safe=['Вход отменён. Можно повторить в окне аккаунта.','В браузере выполнен вход другим пользователем. Укажите его логин в окне аккаунта.','Время ожидания входа истекло. Попробуйте снова.'];
    throw new Error(safe.includes(e.message)?e.message:'Не удалось завершить вход в браузере агента. Закройте окно и попробуйте снова.');
  } finally {await browser.close().catch(()=>{});onBrowser(null);}
}
