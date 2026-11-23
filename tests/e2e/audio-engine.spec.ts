import {test,expect,type Page} from '@playwright/test';
async function render(page:Page,settings:{gain:number;master:number;crossfade:number;disposeFirst?:boolean;mute?:boolean;durationSeconds?:number}){
  return page.evaluate(async settings=>{
    const modulePath='/packages/audio-engine/src/engine.ts';const {createMixer}=await import(modulePath);
    const context=new OfflineAudioContext(2,9600,48000);const buffer=context.createBuffer(2,2400,48000);buffer.getChannelData(0).fill(0.25);buffer.getChannelData(1).fill(-0.125);
    const scene={schemaVersion:1,id:'signal',title:'Signal fixture',revision:0,masterGain:settings.master,durationSeconds:settings.durationSeconds??null,layers:[{id:'one',assetId:'fixture',role:'texture',gain:settings.gain,pan:0,muted:settings.mute??false,solo:false,startSeconds:0,loop:{startSeconds:0,endSeconds:0.05,crossfadeSeconds:settings.crossfade}}]};
    const make=()=>createMixer({context,loadAsset:async()=>buffer,decodedBudgetBytes:1024*1024});
    if(settings.disposeFirst){const old=make();await old.setScene(scene);await old.play();old.dispose();}
    const mixer=make();await mixer.setScene(scene);await mixer.play();const rendered=await context.startRendering();
    const left=Array.from(rendered.getChannelData(0));const right=Array.from(rendered.getChannelData(1));mixer.dispose();return{left,right};
  },settings);
}
test.beforeEach(async({page})=>{await page.goto('/tests/harness/audio.html');});

test('centered stereo preserves both channels and half gain has known amplitude',async({page})=>{
  const output=await render(page,{gain:0.5,master:0.5,crossfade:0});
  expect(Math.max(...output.left.map((x,i)=>Math.abs(x-0.0625*Math.min(1,i/960))))).toBeLessThan(1e-6);
  expect(Math.max(...output.right.map((x,i)=>Math.abs(x+0.03125*Math.min(1,i/960))))).toBeLessThan(1e-6);
});
test('zero gain and muted layer produce silence',async({page})=>{
  for(const settings of [{gain:0,master:1,crossfade:0},{gain:1,master:1,crossfade:0,mute:true}]){
    const output=await render(page,settings);expect(Math.max(...output.left.map(Math.abs),...output.right.map(Math.abs))).toBeLessThan(1e-8);
  }
});
test('linear loop overlap has no constant-signal amplitude step or boost',async({page})=>{
  const output=await render(page,{gain:1,master:1,crossfade:0.01});
  expect(Math.max(...output.left.map((x,i)=>Math.abs(x-0.25*Math.min(1,i/960))))).toBeLessThan(1e-6);
  expect(Math.max(...output.right.map((x,i)=>Math.abs(x+0.125*Math.min(1,i/960))))).toBeLessThan(1e-6);
});
test('two create and dispose cycles do not double the output',async({page})=>{
  const output=await render(page,{gain:1,master:1,crossfade:0,disposeFirst:true});
  expect(Math.max(...output.left.map((x,i)=>Math.abs(x-0.25*Math.min(1,i/960))))).toBeLessThan(1e-6);
});
test('real context pause resume and interruption report actual transport state',async({page})=>{
  await page.evaluate(async()=>{
    const modulePath='/packages/audio-engine/src/engine.ts';const {createMixer}=await import(modulePath);
    const context=new AudioContext();const buffer=context.createBuffer(2,context.sampleRate*4,context.sampleRate);
    const mixer=createMixer({context,loadAsset:async()=>buffer,decodedBudgetBytes:1024*1024*4});
    const holder=window as unknown as {snapshot:{state:string;positionSeconds:number};cleanup:()=>Promise<void>};
    mixer.subscribe((state:{state:string;positionSeconds:number})=>{holder.snapshot=state;});
    await mixer.setScene({schemaVersion:1,id:'transport',title:'Transport fixture',revision:0,masterGain:0,durationSeconds:null,layers:[{id:'one',assetId:'fixture',role:'texture',gain:1,pan:0,muted:false,solo:false,startSeconds:0,loop:null}]});
    document.getElementById('play')!.onclick=()=>{void mixer.play();};document.getElementById('pause')!.onclick=()=>mixer.pause();document.getElementById('interrupt')!.onclick=()=>{void context.suspend();};
    holder.cleanup=async()=>{mixer.dispose();await context.close();};
  });
  const snapshot=()=>page.evaluate(()=>(window as unknown as {snapshot:{state:string;positionSeconds:number}}).snapshot);
  await page.click('#play');await expect.poll(async()=>(await snapshot()).state).toBe('playing');
  await expect.poll(async()=>(await snapshot()).positionSeconds).toBeGreaterThan(0.05);
  await page.click('#pause');const paused=await snapshot();expect(paused.state).toBe('paused');
  await page.waitForTimeout(120);expect((await snapshot()).positionSeconds).toBe(paused.positionSeconds);
  await page.click('#play');await expect.poll(async()=>(await snapshot()).positionSeconds).toBeGreaterThan(paused.positionSeconds+0.05);
  await page.click('#interrupt');await expect.poll(async()=>(await snapshot()).state).toBe('interrupted');
  await page.evaluate(()=>(window as unknown as {cleanup:()=>Promise<void>}).cleanup());
});

test('a finite crossfaded session stops at its scheduled sample without extending the intro',async({page})=>{
  const output=await render(page,{gain:1,master:1,crossfade:0.01,durationSeconds:0.12});
  expect(Math.max(...output.left.slice(0,5760).map((x,i)=>Math.abs(x-0.25*Math.min(1,i/960,(5760-i)/960))))).toBeLessThan(1e-6);
  expect(Math.max(...output.left.slice(5760).map(Math.abs),...output.right.slice(5760).map(Math.abs))).toBeLessThan(1e-8);
});
