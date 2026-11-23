import {randomUUID} from 'node:crypto';
import {test,expect,type Page} from '@playwright/test';
import type {AssetRecord,Scene} from '@asmr-studio/contracts';
import {wavFixture} from '../fixtures/audio.js';
import {defaultLoop} from '../../apps/web/src/features/mixer/sound-utils.js';

interface SourceEvidence {id:number;source:AudioBufferSourceNode;starts:number;stops:number}
interface OutputEvidence {context:AudioContext|null;sources:SourceEvidence[]}

async function observeSources(page:Page):Promise<void> {
  await page.addInitScript(()=>{
    const evidence:OutputEvidence={context:null,sources:[]};
    Object.assign(window,{asmrOutputAudio:evidence});
    const createSource=AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource=function(){
      evidence.context=this;
      const source=createSource.call(this);
      const record:SourceEvidence={id:evidence.sources.length,source,starts:0,stops:0};
      evidence.sources.push(record);
      const start=source.start.bind(source),stop=source.stop.bind(source);
      source.start=(...args:Parameters<AudioBufferSourceNode['start']>)=>{record.starts++;start(...args);};
      source.stop=(...args:Parameters<AudioBufferSourceNode['stop']>)=>{record.stops++;stop(...args);};
      return source;
    };
  });
}

async function sourceSnapshot(page:Page) {
  return page.evaluate(()=>{
    const evidence=(window as unknown as {asmrOutputAudio:OutputEvidence}).asmrOutputAudio;
    return {
      created:evidence.sources.length,
      starts:evidence.sources.reduce((sum,record)=>sum+record.starts,0),
      stops:evidence.sources.reduce((sum,record)=>sum+record.stops,0),
      loopIds:evidence.sources.filter(record=>record.starts>0&&record.stops===0&&record.source.loop&&record.source.buffer!==null).map(record=>record.id),
      time:evidence.context?.currentTime??0,
      state:evidence.context?.state??null,
    };
  });
}

async function createFixture(page:Page,baseURL:string|undefined) {
  if(!baseURL)throw new Error('Output UI tests require a configured baseURL');
  const origin=new URL(baseURL).origin;
  const title='Output fixture '+randomUUID().slice(0,8);
  const bytes=wavFixture({frames:48_000,channels:2});
  const pcm=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let frame=0;frame<48_000;frame++){
    pcm.setInt16(44+frame*4,12000,true);
    pcm.setInt16(46+frame*4,6000,true);
  }
  const imported=await page.request.post('/api/assets',{headers:{origin,'content-type':'audio/wav',
    'x-asmr-metadata':JSON.stringify({displayName:title,roles:['texture'],
      provenance:{kind:'original',source:'Generated PCM for native output meter and limiter checks'},
      rights:{privateUse:'permitted',redistribution:'permitted'}})},data:Buffer.from(bytes)});
  expect(imported.status(),await imported.text()).toBe(201);
  const asset=await imported.json() as AssetRecord;
  const scene:Scene={schemaVersion:1,id:randomUUID(),title,revision:0,masterGain:1,durationSeconds:null,
    layers:Array.from({length:3},(_,index)=>({id:'output-loop-'+index,assetId:asset.id,role:'texture' as const,gain:1,pan:0,
      muted:false,solo:false,startSeconds:0,loop:{...defaultLoop(asset.durationSeconds),crossfadeSeconds:0}}))};
  const saved=await page.request.post('/api/scenes',{headers:{origin},data:scene});
  expect(saved.status(),await saved.text()).toBe(201);
  await page.goto('/?scene='+scene.id);
  await expect(page.getByRole('textbox',{name:'Session name'})).toHaveValue(title);
  return scene;
}

test('output meters capture stereo peaks while limiter edits preserve playback and saved settings',async({page,baseURL},testInfo)=>{
  await page.setViewportSize({width:1280,height:1000});
  await observeSources(page);
  const scene=await createFixture(page,baseURL);
  const panel=page.getByRole('group',{name:'Output levels',exact:true});
  const toggle=panel.getByRole('button',{name:'Peak limiter',exact:true});
  const ceiling=panel.getByRole('slider',{name:'Output ceiling',exact:true});
  const level=(channel:'Left'|'Right')=>panel.getByRole('meter',{name:channel+' output level',exact:true});
  await expect(toggle).toHaveAttribute('aria-pressed','false');
  await expect(ceiling).toBeDisabled();
  await page.getByRole('button',{name:'Start listening',exact:true}).click();
  await expect(panel.getByText('Full scale reached',{exact:true})).toBeVisible();
  await expect.poll(async()=>Number(await level('Left').getAttribute('value'))).toBe(0);
  await expect.poll(async()=>Number(await level('Right').getAttribute('value'))).toBeGreaterThan(-6);
  await expect(page.getByText('Unsaved changes',{exact:true})).not.toBeVisible();
  const before=await sourceSnapshot(page);
  expect(before.loopIds).toHaveLength(3);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed','true');
  await expect(ceiling).toBeEnabled();
  await expect.poll(async()=>Number(await level('Left').getAttribute('value'))).toBeCloseTo(-1,2);
  await ceiling.press('ArrowDown');
  await expect(ceiling).toHaveValue('-1.1');
  await ceiling.press('Home');
  await expect(ceiling).toHaveValue('-12');
  await ceiling.press('End');
  await expect(ceiling).toHaveValue('-0.1');
  await ceiling.fill('-4.2');
  await expect.poll(async()=>Number(await level('Left').getAttribute('value'))).toBeCloseTo(-4.2,2);
  const left=Number(await level('Left').getAttribute('value'));
  const right=Number(await level('Right').getAttribute('value'));
  expect(right-left).toBeCloseTo(-6.0206,2);
  await expect.poll(async()=>parseFloat(await panel.getByLabel('Gain reduction').innerText())).toBeGreaterThan(4);
  await panel.getByRole('button',{name:'Reset peaks',exact:true}).click();
  await expect(panel.getByText('Full scale reached',{exact:true})).not.toBeVisible();
  await expect.poll(async()=>(await sourceSnapshot(page)).time).toBeGreaterThan(before.time+.3);
  const after=await sourceSnapshot(page);
  expect(after).toMatchObject({created:before.created,starts:before.starts,stops:before.stops,loopIds:before.loopIds,state:'running'});
  await testInfo.attach('continuous-audio-through-limiter-edits',{body:Buffer.from(JSON.stringify({before,after,left,right},null,2)),contentType:'application/json'});

  await page.getByRole('button',{name:'Save session',exact:true}).click();
  await expect(page.getByText('Saved revision 2',{exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'Reset peaks',exact:true}).click();
  await expect(page.getByText('Unsaved changes',{exact:true})).not.toBeVisible();
  const saved=await(await page.request.get('/api/scenes/'+scene.id)).json() as Scene;
  expect(saved.outputLimiter).toEqual({enabled:true,ceilingDb:-4.2});
  await toggle.click();
  await expect(ceiling).toBeDisabled();
  await expect(ceiling).toHaveValue('-4.2');
  await expect.poll(async()=>Number(await level('Left').getAttribute('value'))).toBe(0);
  await page.getByRole('button',{name:'Save session',exact:true}).click();
  await expect(page.getByText('Saved revision 3',{exact:true})).toBeVisible();
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed','false');
  await expect(ceiling).toHaveValue('-4.2');
  await expect(ceiling).toBeDisabled();
  await expect(panel.getByText('Start listening to see levels.',{exact:true})).toBeVisible();
  await toggle.click();
  await expect(ceiling).toHaveValue('-4.2');
  await page.getByRole('button',{name:'Start listening',exact:true}).click();
  await expect.poll(async()=>Number(await level('Left').getAttribute('value'))).toBeCloseTo(-4.2,2);

  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(toggle).toBeVisible();
    await expect(ceiling).toBeVisible();
    const bounds=await panel.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);
  }
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await expect.poll(async()=>Number(await level('Left').getAttribute('value'))).toBe(-60);
});
