import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import process from 'node:process';
import {test,expect,type JSHandle,type Page} from '@playwright/test';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport,getDefaultEnvironment} from '@modelcontextprotocol/client/stdio';
import {parseAssistantDeviceView,parseAssistantCommandReceipt,type AssistantCommandRequest,type AssistantDeviceView,type AssetRecord} from '@asmr-studio/contracts';
import {wavFixture} from '../fixtures/audio.js';
import {defaultLoop} from '../../apps/web/src/features/mixer/sound-utils.js';

interface AudioEvidence {meter:AnalyserNode|null;starts:number;decodes:number}
async function observeAudio(page:Page){
  await page.addInitScript(()=>{
    const evidence:AudioEvidence={meter:null,starts:0,decodes:0};
    Object.assign(window,{asmrAssistantAudio:evidence});
    const analyser=AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser=function(){const node=analyser.call(this);evidence.meter=node;return node;};
    const source=AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource=function(){
      const node=source.call(this);const start=node.start.bind(node);
      node.start=(...args:Parameters<AudioBufferSourceNode['start']>)=>{evidence.starts++;start(...args);};
      return node;
    };
    const decode=AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData=function(data,success,failure){
      const task=decode.call(this,data,success,failure);void task.then(()=>{evidence.decodes++;},()=>{});return task;
    };
  });
}
async function signal(page:Page){
  return page.evaluate(()=>{
    const evidence=(window as unknown as {asmrAssistantAudio:AudioEvidence}).asmrAssistantAudio;
    const pcm=new Float32Array(evidence.meter?.fftSize??0);evidence.meter?.getFloatTimeDomainData(pcm);
    return {peak:Math.max(0,...Array.from(pcm,Math.abs)),starts:evidence.starts,decodes:evidence.decodes};
  });
}
async function importFixture(page:Page,origin:string):Promise<AssetRecord>{
  const response=await page.request.post('/api/assets',{headers:{origin,'content-type':'audio/wav',
    'x-asmr-metadata':JSON.stringify({displayName:'Assistant fixture '+randomUUID(),roles:['texture'],
      provenance:{kind:'original',source:'Generated acceptance-test PCM'},rights:{privateUse:'permitted',redistribution:'permitted'}})},
    data:Buffer.from(wavFixture({frames:48_000,channels:2}))});
  expect(response.status(),await response.text()).toBe(201);return await response.json() as AssetRecord;
}
async function playingTab(page:Page,origin:string,name:string,listen=true){
  await observeAudio(page);
  const asset=await importFixture(page,origin);const id=randomUUID();
  const response=await page.request.post('/api/scenes',{headers:{origin},data:{
    schemaVersion:1,id,title:name,revision:0,masterGain:0.4,durationSeconds:null,
    layers:[{id:'texture',assetId:asset.id,role:'texture',gain:0.4,pan:0,muted:false,solo:false,startSeconds:0,
      loop:{...defaultLoop(asset.durationSeconds),crossfadeSeconds:0}}],
  }});
  expect(response.status(),await response.text()).toBe(201);
  await page.goto('/?scene='+id);
  await expect(page.getByRole('textbox',{name:'Session name',exact:true})).toHaveValue(name);
  if(listen){
    await page.getByRole('button',{name:'Start listening',exact:true}).click();
    await expect.poll(async()=>(await signal(page)).peak).toBeGreaterThan(0.0001);
  }
  return {asset,id};
}
async function enable(page:Page,name:string){
  const panel=page.getByRole('region',{name:'Assistant controls',exact:true});
  await panel.locator('summary').click();
  await panel.getByRole('textbox',{name:'Playback device name'}).fill(name);
  await panel.getByRole('button',{name:'Enable for this browser'}).click();
  await expect(panel.getByRole('button',{name:'Disconnect assistant'})).toBeVisible();
  await panel.getByRole('button',{name:'Connection settings'}).click();
  const config=JSON.parse((await panel.getByLabel('MCP environment settings').textContent())!) as Record<string,string>;
  await panel.getByRole('button',{name:'Connection settings'}).click();
  const client=new Client({name:'asmr-browser-acceptance',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,
    args:[fileURLToPath(new URL('../../apps/mcp/dist/main.js',import.meta.url))],
    env:{...getDefaultEnvironment(),...config},stderr:'pipe'});
  transport.stderr?.on('data',()=>{});
  try{await client.connect(transport);}catch(error){await transport.close();throw error;}
  return {client,panel};
}
function structured(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('A structured MCP result is required');
  return value as Record<string,unknown>;
}
async function call(client:Client,name:string,args:Record<string,unknown>={}):Promise<Record<string,unknown>>{
  const value=await client.callTool({name,arguments:args});
  expect(value.isError,JSON.stringify(value.structuredContent??value.content)).not.toBe(true);
  return structured(value.structuredContent);
}
const target=(device:AssistantDeviceView)=>({deviceId:device.deviceId,epoch:device.epoch});
async function selected(client:Client){
  const value=await call(client,'list_playback_devices');
  expect(value['devices']).toBeInstanceOf(Array);
  const devices=value['devices'] as unknown[];expect(devices).toHaveLength(1);
  return parseAssistantDeviceView(devices[0]);
}
async function state(client:Client,device:AssistantDeviceView){
  return parseAssistantDeviceView((await call(client,'get_playback_device',target(device)))['device']);
}
function command(device:AssistantDeviceView,action:AssistantCommandRequest['action']):AssistantCommandRequest{
  return {...target(device),requestId:randomUUID(),expectedStateVersion:device.state.stateVersion,action};
}
async function completed(client:Client,request:AssistantCommandRequest){
  let receipt= parseAssistantCommandReceipt((await call(client,'get_command_result',
    {deviceId:request.deviceId,epoch:request.epoch,requestId:request.requestId}))['receipt']);
  await expect.poll(async()=>{
    receipt=parseAssistantCommandReceipt((await call(client,'get_command_result',
      {deviceId:request.deviceId,epoch:request.epoch,requestId:request.requestId}))['receipt']);
    return ['queued','dispatched'].includes(receipt.status);
  },{timeout:12_000,intervals:[100,200,300]}).toBe(false);
  return receipt;
}
async function submit(client:Client,request:AssistantCommandRequest){
  await call(client,'submit_session_command',request);return completed(client,request);
}

test('a real MCP connection controls only its paired tab and reconciles edits, undo, save and disconnect',async({page,context,baseURL})=>{
  test.setTimeout(60_000);const origin=new URL(baseURL!).origin;
  const a=await playingTab(page,origin,'MCP selected tab');
  const other=await context.newPage();await playingTab(other,origin,'Other listening tab');
  const first=await enable(page,'Selected browser');const second=await enable(other,'Other browser');
  try{
    const tools=await first.client.listTools();
    expect(tools.tools.map(tool=>tool.name)).toEqual(expect.arrayContaining(['submit_session_command','get_command_result','undo_session_command']));
    let current=await selected(first.client);const unselected=await selected(second.client);
    expect(current.deviceId).not.toBe(unselected.deviceId);expect(current.name).toBe('Selected browser');
    expect((await call(first.client,'list_assets',target(current)))['assets']).toEqual(expect.arrayContaining([expect.objectContaining({id:a.asset.id})]));
    expect((await call(first.client,'list_saved_sessions',target(current)))['sessions']).toEqual(expect.arrayContaining([expect.objectContaining({id:a.id})]));
    const mute=command(current,{type:'edit',command:{type:'setMasterGain',gain:0}});
    expect((await submit(first.client,mute)).status).toBe('applied');
    await expect(page.getByRole('slider',{name:'Master volume',exact:true})).toHaveValue('0');
    await expect.poll(async()=>(await signal(page)).peak).toBeLessThan(0.000001);
    await expect(other.getByRole('slider',{name:'Master volume',exact:true})).toHaveValue('40');
    await expect.poll(async()=>(await signal(other)).peak).toBeGreaterThan(0.0001);
    current=await state(first.client,current);
    expect(current.state).toMatchObject({dirty:true,savedRevision:1,playback:{state:'playing'}});
    expect(parseAssistantCommandReceipt((await call(first.client,'submit_session_command',mute))['receipt']).status).toBe('applied');
    expect((await state(first.client,current)).state.stateVersion).toBe(current.state.stateVersion);
    const cross=await first.client.callTool({name:'submit_session_command',arguments:command(unselected,{type:'stop'})});
    expect(cross.isError).toBe(true);expect(structured(cross.structuredContent)['code']).toBe('ASSISTANT_UNAUTHORIZED');
    const undo=command(current,{type:'undo',requestId:mute.requestId});
    await call(first.client,'undo_session_command',{...target(current),requestId:undo.requestId,
      expectedStateVersion:undo.expectedStateVersion,originalRequestId:mute.requestId});
    expect((await completed(first.client,undo)).status).toBe('applied');
    await expect.poll(async()=>(await signal(page)).peak).toBeGreaterThan(0.0001);
    current=await state(first.client,current);
    const quieter=command(current,{type:'edit',command:{type:'setMasterGain',gain:0.2}});
    expect((await submit(first.client,quieter)).status).toBe('applied');
    await page.getByRole('slider',{name:'Master volume',exact:true}).fill('55');
    await expect.poll(async()=>(await state(first.client,current)).state.scene.masterGain).toBe(0.55);
    current=await state(first.client,current);
    expect((await submit(first.client,command(current,{type:'undo',requestId:quieter.requestId}))).status).toBe('rejected');
    current=await state(first.client,current);
    expect((await submit(first.client,command(current,{type:'save'}))).status).toBe('applied');
    current=await state(first.client,current);expect(current.state).toMatchObject({savedRevision:2,dirty:false});
    expect((await (await page.request.get('/api/scenes/'+a.id)).json()).masterGain).toBe(0.55);
    await first.panel.getByRole('button',{name:'Disconnect assistant'}).click();
    await expect.poll(async()=>(await state(first.client,current)).connected).toBe(false);
    const disconnected=await first.client.callTool({name:'submit_session_command',arguments:command(current,{type:'play'})});
    expect(disconnected.isError).toBe(true);expect(structured(disconnected.structuredContent)['code']).toBe('DEVICE_DISCONNECTED');
    await expect.poll(async()=>(await signal(other)).peak).toBeGreaterThan(0.0001);
  }finally{await first.client.close();await second.client.close();await other.close();}
});

test('an opt-in gesture enables MCP transport and survives saved-session changes',async({page,baseURL})=>{
  test.setTimeout(60_000);const origin=new URL(baseURL!).origin;
  const original=await playingTab(page,origin,'MCP transport original',false);
  expect(await signal(page)).toMatchObject({peak:0,starts:0});
  const connected=await enable(page,'MCP transport browser');
  let originalContext:JSHandle<BaseAudioContext>|null=null;
  try{
    let current=await selected(connected.client);
    expect(current.state).toMatchObject({dirty:false,playback:{state:'idle',audioContextState:'running'}});
    expect(await signal(page)).toMatchObject({peak:0,starts:0});
    const apply=async(action:AssistantCommandRequest['action'],playback:AssistantDeviceView['state']['playback']['state'])=>{
      current=await state(connected.client,current);
      const receipt=await submit(connected.client,command(current,action));
      expect(receipt.status,receipt.message??'The browser must acknowledge this action').toBe('applied');
      current=await state(connected.client,current);
      expect(current.state.playback.state).toBe(playback);
    };

    // Every transport action below comes through the actual stdio server, without
    // clicking Start listening or another browser control to grant a new gesture.
    await apply({type:'play'},'playing');
    await expect.poll(async()=>(await signal(page)).peak).toBeGreaterThan(0.0001);
    originalContext=await page.evaluateHandle(()=>{
      const evidence=(window as unknown as {asmrAssistantAudio:AudioEvidence}).asmrAssistantAudio;
      if(!evidence.meter)throw new Error('Playing must create a native analyser');
      return evidence.meter.context;
    });
    await apply({type:'pause'},'paused');
    await expect.poll(async()=>(await signal(page)).peak).toBeLessThan(0.000001);
    const pausedAt=current.state.playback.positionSeconds;expect(pausedAt).toBeGreaterThan(0);
    await apply({type:'play'},'playing');
    expect(current.state.playback.positionSeconds).toBeGreaterThanOrEqual(pausedAt);
    await expect.poll(async()=>(await signal(page)).peak).toBeGreaterThan(0.0001);
    await apply({type:'stop'},'ready');
    expect(current.state.playback.positionSeconds).toBe(0);
    await expect.poll(async()=>(await signal(page)).peak).toBeLessThan(0.000001);

    const replacement={...current.state.scene,id:randomUUID(),title:'MCP transport replacement',revision:0,masterGain:0.2};
    const created=await page.request.post('/api/scenes',{headers:{origin},data:replacement});
    expect(created.status(),await created.text()).toBe(201);
    await apply({type:'openSavedSession',sceneId:replacement.id,discardUnsaved:false},'idle');
    expect(current.state).toMatchObject({scene:{id:replacement.id},savedRevision:1,dirty:false,
      playback:{audioContextState:'running'}});
    await expect(page.getByRole('textbox',{name:'Session name',exact:true})).toHaveValue(replacement.title);
    await expect(page.getByRole('slider',{name:'Master volume',exact:true})).toHaveValue('20');
    await apply({type:'play'},'playing');
    await expect.poll(async()=>(await signal(page)).peak).toBeGreaterThan(0.0001);
    expect(await page.evaluate(first=>{
      const evidence=(window as unknown as {asmrAssistantAudio:AudioEvidence}).asmrAssistantAudio;
      return evidence.meter?.context===first;
    },originalContext)).toBe(true);

    await apply({type:'edit',command:{type:'setMasterGain',gain:0.25}},'playing');
    const rejected=await submit(connected.client,command(current,
      {type:'openSavedSession',sceneId:original.id,discardUnsaved:false}));
    expect(rejected).toMatchObject({status:'rejected',message:expect.stringContaining('UNSAVED_CHANGES')});
    current=await state(connected.client,current);
    expect(current.state).toMatchObject({scene:{id:replacement.id,masterGain:0.25},dirty:true,playback:{state:'playing'}});
    await expect(page.getByRole('textbox',{name:'Session name',exact:true})).toHaveValue(replacement.title);
    await expect.poll(async()=>(await signal(page)).peak).toBeGreaterThan(0.0001);
    await apply({type:'stop'},'ready');
    await expect.poll(async()=>(await signal(page)).peak).toBeLessThan(0.000001);
  }finally{await originalContext?.dispose();await connected.client.close();}
});

for(const interrupt of ['local edit','disconnect'] as const){
  test('a pending assistant decode cannot commit after '+interrupt,async({page,baseURL})=>{
    test.setTimeout(40_000);const origin=new URL(baseURL!).origin;
    await playingTab(page,origin,'Pending assistant audio');
    const added=await importFixture(page,origin);const connected=await enable(page,'Pending browser');
    let release!:()=>void;let arrived!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});const requested=new Promise<void>(resolve=>{arrived=resolve;});
    await page.route('**/api/assets/'+added.id+'/content',async route=>{arrived();await gate;await route.continue();});
    try{
      const device=await selected(connected.client);const before=await signal(page);
      const request=command(device,{type:'edit',command:{type:'addLayer',layer:{id:'pending-layer',assetId:added.id,role:'texture',gain:0.3,
        pan:0,muted:false,solo:false,startSeconds:0,loop:{...defaultLoop(added.durationSeconds),crossfadeSeconds:0}}}});
      await call(connected.client,'submit_session_command',request);await requested;
      if(interrupt==='local edit')await page.getByRole('slider',{name:'Master volume',exact:true}).fill('0');
      else await connected.panel.getByRole('button',{name:'Disconnect assistant'}).click();
      release();await expect.poll(async()=>(await signal(page)).decodes).toBeGreaterThan(before.decodes);
      expect((await signal(page)).starts).toBe(before.starts);
      const receipt=await completed(connected.client,request);
      expect(receipt.status).toBe(interrupt==='local edit'?'failed':'unconfirmed');
      if(interrupt==='local edit'){
        await expect(page.getByRole('slider',{name:'Master volume',exact:true})).toHaveValue('0');
        await expect.poll(async()=>(await signal(page)).peak).toBeLessThan(0.000001);
      }else await expect.poll(async()=>(await signal(page)).peak).toBeGreaterThan(0.0001);
    }finally{release();await connected.client.close();}
  });
}
