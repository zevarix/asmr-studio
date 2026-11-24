import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const args=process.argv.slice(2);
if(args.length>1 || (args[0]!==undefined && args[0]!=='--built')) throw new Error('Usage: node scripts/test-stack.mjs [--built]');
const built=args[0]==='--built';
const builtPort=Number(process.env.ASMR_TEST_PORT??4318);
if(built && (!Number.isInteger(builtPort)||builtPort<1||builtPort>65535)) throw new Error('ASMR_TEST_PORT must be a valid TCP port');
const data=mkdtempSync(join(tmpdir(),'asmr-e2e-'));
const children=[];
let ending=false;
function spawnOwned(command,args,env) {
  const child=spawn(command,args,{cwd:root,env:{...process.env,...env},stdio:'inherit'});
  children.push(child);
  child.on('error',error=>{console.error('Test stack process failed:',error.message);finish(1);});
  child.on('exit',code=>{if(!ending) finish(code===0?1:(code??1));});
}
function finish(code) {
  if(ending) return;
  ending=true;
  for(const child of children) if(child.exitCode===null) child.kill('SIGTERM');
  const pending=children.filter(child=>child.exitCode===null);
  if(pending.length===0) {
    rmSync(data,{recursive:true,force:true});
    process.exit(code);
  }
  let count=pending.length;
  for(const child of pending) child.once('exit',()=>{
    if(--count===0){rmSync(data,{recursive:true,force:true});process.exit(code);}
  });
}
process.once('SIGINT',()=>finish(0));
process.once('SIGTERM',()=>finish(0));
if(built) {
  spawnOwned(process.execPath,['apps/server/dist/main.js','--serve-ui'],{PORT:String(builtPort),ASMR_DATA_DIR:data,ASMR_ALLOWED_ORIGIN:`http://127.0.0.1:${builtPort}`});
} else {
  spawnOwned(process.execPath,['apps/server/dist/main.js'],{PORT:'4319',ASMR_DATA_DIR:data,ASMR_ALLOWED_ORIGIN:'http://127.0.0.1:4318'});
  spawnOwned(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','4318','--strictPort'],{});
}
