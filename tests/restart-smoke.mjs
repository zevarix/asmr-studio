import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';

const directory=mkdtempSync(join(tmpdir(),'asmr-restart-proof-'));
const listener=createServer();
await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
const port=listener.address().port;
await new Promise(resolve=>listener.close(resolve));
let child=null;
const origin='http://127.0.0.1:'+port;
async function start() {
  child=spawn(process.execPath,['apps/server/dist/main.js'],{
    env:{...process.env,PORT:String(port),ASMR_DATA_DIR:directory},
    stdio:['ignore','pipe','pipe'],
  });
  let earlyExit=false;
  child.on('exit',()=>{earlyExit=true;});
  for(let attempt=0;attempt<80;attempt++){
    if(earlyExit) throw new Error('Server exited before readiness');
    try{
      const result=await fetch(origin+'/api/health');
      if(result.ok) return;
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('Server did not start');
}
async function stop(){
  if(!child)return;
  const running=child;
  const closed=new Promise(resolve=>running.once('exit',resolve));
  running.kill('SIGTERM');
  await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Server failed to close')),5000))]);
  child=null;
}
function wav(){
  const frames=4800,channels=1,sampleRate=48000,dataLength=frames*2;
  const bytes=Buffer.alloc(44+dataLength);
  bytes.write('RIFF',0);bytes.writeUInt32LE(36+dataLength,4);bytes.write('WAVE',8);bytes.write('fmt ',12);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(channels,22);
  bytes.writeUInt32LE(sampleRate,24);bytes.writeUInt32LE(sampleRate*channels*2,28);
  bytes.writeUInt16LE(channels*2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);
  bytes.writeUInt32LE(dataLength,40);
  for(let i=44;i<bytes.length;i+=2)bytes.writeInt16LE(1000,i);
  return bytes;
}
try {
  await start();
  const body=wav();
  const meta={displayName:'Synthetic restart test',roles:['ambience'],
    provenance:{kind:'original',source:null},rights:{privateUse:'permitted',redistribution:'unknown'}};
  const imported=await fetch(origin+'/api/assets',{method:'POST',
    headers:{Origin:origin,'content-type':'audio/wav','x-asmr-metadata':JSON.stringify(meta)},body});
  assert.equal(imported.status,201);
  const asset=await imported.json();
  const scene={schemaVersion:1,id:'restarted-session',title:'Restart proof',revision:0,masterGain:0.25,
    durationSeconds:null,layers:[{id:'ambience',assetId:asset.id,role:'ambience',gain:.5,pan:0,
      muted:false,solo:false,startSeconds:0,loop:null}]};
  const created=await fetch(origin+'/api/scenes',{method:'POST',
    headers:{Origin:origin,'content-type':'application/json'},body:JSON.stringify(scene)});
  assert.equal(created.status,201);
  assert.equal((await created.json()).revision,1);
  await stop();
  await start();
  const list=await fetch(origin+'/api/assets').then(response=>response.json());
  assert.equal(list.length,1);
  assert.equal(list[0].id,asset.id);
  const reopened=await fetch(origin+'/api/scenes/restarted-session');
  assert.equal(reopened.status,200);
  const stored=await reopened.json();
  assert.equal(stored.layers[0].assetId,asset.id);
  assert.equal(stored.revision,1);
  const content=await fetch(origin+'/api/assets/'+asset.id+'/content');
  assert.equal(content.status,200);
  const digest=createHash('sha256').update(Buffer.from(await content.arrayBuffer())).digest('hex');
  assert.equal(digest,createHash('sha256').update(body).digest('hex'));
  console.log('RESTART_SMOKE_PASS: new process reopened saved scene, media metadata, and exact WAV bytes');
}finally{
  await stop();
  rmSync(directory,{recursive:true,force:true});
}
