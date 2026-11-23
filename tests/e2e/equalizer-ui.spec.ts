import {randomUUID} from 'node:crypto';
import {test,expect,type Page} from '@playwright/test';
import type {AssetRecord,Scene} from '@asmr-studio/contracts';
import {wavFixture} from '../fixtures/audio.js';
import {defaultLoop} from '../../apps/web/src/features/mixer/sound-utils.js';

interface SourceEvidence {id:number;source:AudioBufferSourceNode;starts:number;stops:number}
interface AudioEvidence {meter:AnalyserNode|null;filters:BiquadFilterNode[];sources:SourceEvidence[]}

async function observeAudio(page:Page):Promise<void> {
  await page.addInitScript(() => {
    const evidence:AudioEvidence={meter:null,filters:[],sources:[]};
    Object.assign(window,{asmrEqualizerAudio:evidence});
    const createAnalyser=AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser=function(){
      const node=createAnalyser.call(this);evidence.meter=node;return node;
    };
    const createFilter=AudioContext.prototype.createBiquadFilter;
    AudioContext.prototype.createBiquadFilter=function(){
      const node=createFilter.call(this);evidence.filters.push(node);return node;
    };
    const createSource=AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource=function(){
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

async function audioSnapshot(page:Page) {
  return page.evaluate(() => {
    const evidence=(window as unknown as {asmrEqualizerAudio:AudioEvidence}).asmrEqualizerAudio;
    const samples=new Float32Array(evidence.meter?.fftSize??0);
    evidence.meter?.getFloatTimeDomainData(samples);
    return {
      created:evidence.sources.length,
      starts:evidence.sources.reduce((sum,record)=>sum+record.starts,0),
      stops:evidence.sources.reduce((sum,record)=>sum+record.stops,0),
      loopIds:evidence.sources.filter(record=>record.starts>0&&record.stops===0&&record.source.loop&&record.source.buffer!==null).map(record=>record.id),
      time:evidence.meter?.context.currentTime??0,
      state:evidence.meter?.context.state??null,
      peak:Math.max(0,...Array.from(samples,value=>Math.abs(value))),
      filters:evidence.filters.map(node=>({type:node.type,frequency:node.frequency.value,gain:Number(node.gain.value.toFixed(3))}))
        // Neutral filters use an exact identity endpoint; identify bands by their stable type.
        .sort((a,b)=>['lowshelf','peaking','highshelf'].indexOf(a.type)-['lowshelf','peaking','highshelf'].indexOf(b.type)||a.gain-b.gain),
    };
  });
}

async function createFixture(page:Page,baseURL:string|undefined) {
  if(!baseURL)throw new Error('Equalizer UI tests require a configured baseURL');
  const origin=new URL(baseURL).origin;
  const title='Equalizer fixture '+randomUUID().slice(0,8);
  const bytes=wavFixture({frames:48_000,channels:2});
  const pcm=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(const [index,character] of [...randomUUID()].entries())pcm.setInt16(44+index*2,1000+character.charCodeAt(0),true);
  const imported=await page.request.post('/api/assets',{headers:{origin,'content-type':'audio/wav',
    'x-asmr-metadata':JSON.stringify({displayName:title,roles:['texture'],
      provenance:{kind:'original',source:'Generated PCM for native equalizer interaction checks'},
      rights:{privateUse:'permitted',redistribution:'permitted'}})},data:Buffer.from(bytes)});
  expect(imported.status(),await imported.text()).toBe(201);
  const asset=await imported.json() as AssetRecord;
  // Omit the optional EQ fields to exercise an existing, neutral recipe.
  const scene:Scene={schemaVersion:1,id:randomUUID(),title,revision:0,masterGain:0.4,durationSeconds:null,
    layers:[{id:'eq-loop',assetId:asset.id,role:'texture',gain:0.25,pan:0,muted:false,solo:false,startSeconds:0,
      loop:{...defaultLoop(asset.durationSeconds),crossfadeSeconds:0}}]};
  const saved=await page.request.post('/api/scenes',{headers:{origin},data:scene});
  expect(saved.status(),await saved.text()).toBe(201);
  await page.goto('/?scene='+scene.id);
  await expect(page.getByRole('textbox',{name:'Session name'})).toHaveValue(title);
  return {asset,scene};
}

test('rotary EQ supports native input, continuous playback, bypass, reset and saved sessions',async({page,baseURL},testInfo)=>{
  await page.setViewportSize({width:1280,height:900});
  await observeAudio(page);
  const {asset,scene}=await createFixture(page,baseURL);
  const master=page.getByRole('group',{name:'Master equalizer',exact:true});
  const layer=page.getByRole('group',{name:'Texture: eq-loop',exact:true});
  const layerEq=page.getByRole('group',{name:asset.displayName+' equalizer',exact:true});
  const masterBand=(name:string)=>master.getByRole('slider',{name:'Master equalizer '+name,exact:true});
  const layerBand=(name:string)=>layerEq.getByRole('slider',{name:asset.displayName+' equalizer '+name,exact:true});
  for(const name of ['Bass','Mid','Treble'])await expect(masterBand(name)).toHaveValue('0');
  await expect(layer.locator('.layer-equalizer > summary')).toContainText('Flat');
  await page.getByRole('button',{name:'Start listening',exact:true}).click();
  await expect.poll(async()=>(await audioSnapshot(page)).peak).toBeGreaterThan(0.0001);
  const before=await audioSnapshot(page);
  expect(before.state).toBe('running');
  expect(before.loopIds).toHaveLength(1);
  expect(before.filters).toHaveLength(6);
  expect(before.filters.every(filter=>filter.gain===0)).toBe(true);

  const bass=masterBand('Bass');
  await bass.scrollIntoViewIfNeeded();
  const box=await bass.boundingBox();
  if(!box)throw new Error('Bass knob must be visible');
  const around=(degrees:number)=>({
    x:box.x+box.width/2+Math.sin(degrees*Math.PI/180)*box.width*.4,
    y:box.y+box.height/2-Math.cos(degrees*Math.PI/180)*box.height*.4,
  });
  await page.mouse.move(around(0).x,around(0).y);
  await page.mouse.down();
  await expect(bass).toHaveValue('0'); // Pointer-down does not jump to a horizontal track position.
  for(let angle=5;angle<=45;angle+=5)await page.mouse.move(around(angle).x,around(angle).y);
  await expect(bass).toHaveValue('4');
  await page.mouse.move(around(22.5).x,around(22.5).y);
  await expect(bass).toHaveValue('2');
  await page.mouse.move(around(45).x,around(45).y);
  await page.mouse.up();
  await expect(bass).toHaveValue('4');
  await expect(bass).toBeFocused();
  await expect(bass).toHaveAttribute('aria-valuetext','+4 decibels');
  const focus=await bass.evaluate(input=>getComputedStyle(input.parentElement!).outlineStyle);
  expect(focus).not.toBe('none');
  await masterBand('Mid').press('ArrowDown');
  await expect(masterBand('Mid')).toHaveValue('-0.5');
  await masterBand('Treble').press('End');
  await expect(masterBand('Treble')).toHaveValue('12');
  await masterBand('Treble').press('Home');
  await expect(masterBand('Treble')).toHaveValue('-12');
  await masterBand('Treble').dblclick();
  await expect(masterBand('Treble')).toHaveValue('0');
  await masterBand('Treble').fill('-2');
  await masterBand('Treble').hover();
  await page.mouse.wheel(0,40);
  await expect(masterBand('Treble')).toHaveValue('-2');

  await layer.locator('.layer-equalizer > summary').click();
  await layerBand('Bass').fill('-3');
  await layerBand('Mid').fill('1.5');
  await layerBand('Treble').fill('-4');
  await expect(layer.locator('.layer-equalizer > summary')).toContainText('Adjusted');
  const activeFilters=[
    {type:'lowshelf',frequency:200,gain:-3},{type:'lowshelf',frequency:200,gain:4},
    {type:'peaking',frequency:1000,gain:-0.5},{type:'peaking',frequency:1000,gain:1.5},
    {type:'highshelf',frequency:4000,gain:-4},{type:'highshelf',frequency:4000,gain:-2},
  ];
  await expect.poll(async()=>(await audioSnapshot(page)).filters).toEqual(activeFilters);

  await master.getByRole('button',{name:'Bypass',exact:true}).click();
  await expect(master.getByRole('button',{name:'Bypass',exact:true})).toHaveAttribute('aria-pressed','true');
  for(const name of ['Bass','Mid','Treble'])await expect(masterBand(name)).toBeDisabled();
  await expect(masterBand('Bass')).toHaveValue('4');
  await expect.poll(async()=>(await audioSnapshot(page)).filters.map(filter=>filter.gain)).toEqual([-3,0,0,1.5,-4,0]);
  await layerEq.getByRole('button',{name:'Bypass',exact:true}).click();
  await expect(layer.locator('.layer-equalizer > summary')).toContainText('Bypassed');
  await expect.poll(async()=>(await audioSnapshot(page)).filters.every(filter=>filter.gain===0)).toBe(true);
  await master.getByRole('button',{name:'Bypass',exact:true}).click();
  await expect(masterBand('Bass')).toBeEnabled();
  await expect.poll(async()=>(await audioSnapshot(page)).filters.map(filter=>filter.gain)).toEqual([0,4,-0.5,0,-2,0]);
  await expect.poll(async()=>(await audioSnapshot(page)).time).toBeGreaterThan(before.time+0.3);
  const after=await audioSnapshot(page);
  expect(after).toMatchObject({created:before.created,starts:before.starts,stops:before.stops,loopIds:before.loopIds,state:'running'});
  expect(after.peak).toBeGreaterThan(0.0001);
  await testInfo.attach('continuous-audio-through-eq-edits',{body:Buffer.from(JSON.stringify({before,after},null,2)),contentType:'application/json'});

  await page.getByRole('button',{name:'Save session',exact:true}).click();
  await expect(page.getByText('Saved revision 2',{exact:true})).toBeVisible();
  const savedResponse=await page.request.get('/api/scenes/'+scene.id);
  expect(savedResponse.status()).toBe(200);
  const saved=await savedResponse.json() as Scene;
  expect(saved.masterEqualizer).toEqual({bassDb:4,midDb:-0.5,trebleDb:-2,bypassed:false});
  expect(saved.layers[0]?.equalizer).toEqual({bassDb:-3,midDb:1.5,trebleDb:-4,bypassed:true});
  await page.reload();
  await expect(masterBand('Bass')).toHaveValue('4');
  await expect(masterBand('Mid')).toHaveValue('-0.5');
  await expect(masterBand('Treble')).toHaveValue('-2');
  await layer.locator('.layer-equalizer > summary').click();
  await expect(layerBand('Bass')).toHaveValue('-3');
  await expect(layerBand('Mid')).toHaveValue('1.5');
  await expect(layerBand('Treble')).toHaveValue('-4');
  await expect(layerBand('Bass')).toBeDisabled();
  await expect(layerEq.getByRole('button',{name:'Bypass',exact:true})).toHaveAttribute('aria-pressed','true');
  await layerEq.getByRole('button',{name:'Reset',exact:true}).click();
  await master.getByRole('button',{name:'Reset',exact:true}).click();
  for(const group of [master,layerEq]){
    await expect(group.getByRole('button',{name:'Bypass',exact:true})).toHaveAttribute('aria-pressed','false');
    for(const knob of await group.getByRole('slider').all()){
      await expect(knob).toHaveValue('0');await expect(knob).toBeEnabled();
    }
  }
  await expect(layer.locator('.layer-equalizer > summary')).toContainText('Flat');

  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    for(const group of [master,layerEq])for(const knob of await group.getByRole('slider').all()){
      const bounds=await knob.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44);expect(bounds?.height).toBeGreaterThanOrEqual(44);
    }
  }
});
