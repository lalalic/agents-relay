/** Optional project-declared Stage completion gate. Runs after any code/model
 * node reports COMPLETED and before the canonical DAG accepts its result. */
import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep,join} from 'node:path';
const within=(root:string,target:string):boolean=>{const rel=relative(root,target);return rel===''||(rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel));};
export async function validateShortcutStageGate(options:{projectPath:string;agent:string;runPath:string;execute:(args:string[],cwd:string)=>Promise<{stdout:string;stderr:string;code:number}>}):Promise<void>{
 const root=await realpath(options.projectPath);
 let manifest:unknown;
 try{manifest=JSON.parse(await readFile(join(root,'project.run.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 const config=(manifest as Record<string,unknown>)?.stageValidation;
 if(!config||typeof config!=='object'||Array.isArray(config))return;
 const declaration=config as {script?:unknown;agents?:unknown};
 if(!declaration.agents||typeof declaration.agents!=='object'||Array.isArray(declaration.agents))throw new Error('Invalid Stage validator agent mapping');
 const stage=(declaration.agents as Record<string,unknown>)[options.agent];
 if(stage===undefined)return;
 if(typeof stage!=='string'||!/^[-a-z]+$/.test(stage))throw new Error('Invalid declared Stage ID');
 const script=declaration.script;
 if(typeof script!=='string'||!/^scripts\/[a-zA-Z0-9._-]+\.mjs$/.test(script))throw new Error('Invalid Stage validator script');
 const file=await realpath(resolve(root,script));
 if(!within(root,file))throw new Error('Stage validator escaped project root');
 const run=await realpath(options.runPath);
 if(!within(await realpath(resolve(root,'runs')),run)||run===root)throw new Error('Stage validator run escaped project runs');
 const response=await options.execute([process.execPath,file,stage,run],root);
 let outcome:unknown;
 try{outcome=JSON.parse(response.stdout);}catch{throw new Error('Stage validator did not return a structured contract result');}
 const report=outcome as {stage?:unknown;status?:unknown;errors?:unknown};
 if(response.code!==0||report.stage!==stage||report.status!=='PASS'||(Array.isArray(report.errors)&&report.errors.length>0)){
   const detail=Array.isArray(report.errors)?JSON.stringify(report.errors).slice(0,1200):response.stderr.slice(0,1200);
   throw new Error('STAGE_CONTRACT_FAILED '+stage+': '+detail);
 }
}
