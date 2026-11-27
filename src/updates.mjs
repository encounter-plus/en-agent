import {join} from 'node:path';
import {optionalJson} from './storage.mjs';
import {classify} from './diagnostics.mjs';
import {stageUpdate} from './releases.mjs';
import {updateEnSkills} from './skills-update.mjs';

// One in-flight check per launcher. Startup can await just the mandatory skills download.
export function updateChecker(home,bundle,{signal,progress,appUpdate=stageUpdate,skillsUpdate=updateEnSkills}){
  let active;
  function check(){
    if(active)return active;
    async function run(name,operation){
      let result;
      try{
        await progress({[name]:{status:'checking'}});
        result=await operation();
      }catch(error){
        result={status:signal.aborted?'cancelled':'failed',category:classify(error)};
      }
      await progress({[name]:result});
      return result;
    }
    const app=run('app',async()=>{
      const channel=await optionalJson(join(home,'channel.json'));
      if(!channel)return {status:'unconfigured'};
      return appUpdate(home,channel,{signal});
    });
    const skills=run('skills',()=>skillsUpdate(home,bundle.root,{signal,minimum:bundle.manifest.minimumSkillsVersion}));
    const done=Promise.all([app,skills]).finally(()=>{active=null;});
    // Manual checks run in the background. A diagnostic write failure must not kill OpenCode.
    done.catch(()=>{});
    active={skills,done};
    return active;
  }
  return {check,finish:()=>active?.done};
}
