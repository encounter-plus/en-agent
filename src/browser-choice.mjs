import {access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const exists=async p=>{try{await access(p);return true;}catch{return false;}};
export async function detectBrowsers(root,{env=process.env,platform=process.platform,fileExists=exists,playwright}={}) {
 const result=[];
 const paths=platform==='win32'?{
 chrome:[env.LOCALAPPDATA,env.PROGRAMFILES,env['PROGRAMFILES(X86)']].filter(Boolean).map(p=>join(p,'Google/Chrome/Application/chrome.exe')),
 msedge:[env['PROGRAMFILES(X86)'],env.PROGRAMFILES,env.LOCALAPPDATA].filter(Boolean).map(p=>join(p,'Microsoft/Edge/Application/msedge.exe'))
 }:platform==='darwin'?{chrome:['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],msedge:['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']}:{chrome:['/opt/google/chrome/chrome','/usr/bin/google-chrome'],msedge:['/opt/microsoft/msedge/msedge','/usr/bin/microsoft-edge']};
 for(const [id,candidates] of Object.entries(paths))for(const executablePath of candidates)if(await fileExists(executablePath)){result.push({id,label:id==='chrome'?'Google Chrome':'Microsoft Edge',engine:'chromium',executablePath});break;}
 if(!playwright)playwright=await import(pathToFileURL(join(root,'browser/node_modules/playwright/index.mjs')));
 for(const id of ['chromium','firefox']){const executablePath=playwright[id].executablePath();if(await fileExists(executablePath))result.push({id,label:id==='firefox'?'Firefox (Playwright)':'Chromium (Playwright)',engine:id,executablePath});}
 return result;
}
export function chooseBrowser(browsers,preference='auto') {
 if(!['auto','chrome','msedge','chromium','firefox'].includes(preference))throw Error('Неизвестный браузер агента. Выберите браузер при запуске.');
 const selected=preference==='auto'?browsers[0]:browsers.find(b=>b.id===preference);
 if(!selected)throw Error('Браузер агента не найден. Установите Chrome или Edge, либо выберите доступный браузер при запуске.');
 return selected;
}
export function browserLaunchOptions(browser){if(!browser)throw Error('Браузер агента не выбран');return {executablePath:browser.executablePath,headless:false};}
export function browserMcpArgs(browser,home){if(!browser)throw Error('Браузер агента не выбран');return ['--browser',browser.engine==='firefox'?'firefox':'chrome','--executable-path',browser.executablePath,'--user-data-dir',join(home,'data','browser',browser.id)];}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await detectBrowsers(resolve(process.argv[2]))));}catch{console.error('Не удалось определить браузеры агента.');process.exitCode=1;}}
