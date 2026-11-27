import {prepareSkills,updateSkills} from '../src/skills-store.mjs';

// Model checks use a separate application home and the verified skills from the test installation.
export async function copyTestSkills(bundle,sourceHome,targetHome){
  const source=await prepareSkills(bundle,sourceHome);
  if(!source)throw Error('Initialize the test installation with a launcher smoke run first');
  await updateSkills(targetHome,async()=>({...source,source:'test-installation'}));
  return source;
}
