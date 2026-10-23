import {resolve,join} from 'node:path';
import {installed} from './releases.mjs';
import {json} from './storage.mjs';
const home=resolve(process.argv[2]);
try{await installed(home,(await json(join(home,'state.json'))).current);}catch{console.error('Installation integrity check failed');process.exitCode=1;}
