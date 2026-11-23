import {randomUUID} from 'node:crypto';
import {test,expect,type Page} from '@playwright/test';
import type {AssetRecord,Scene} from '@asmr-studio/contracts';
import {wavFixture} from '../fixtures/audio.js';
import {defaultLoop} from '../../apps/web/src/features/mixer/sound-utils.js';

interface SourceEvidence {id:number;source:AudioBufferSourceNode;starts:number;stops:number}
interface MovementEvidence {meter:AnalyserNode|null;sources:SourceEvidence[]}

async function observeAudio(page:Page):Promise<void> {
  await page.addInitScript(()=>{
    const evidence:MovementEvidence={meter:null,sources:[]};
    Object.assign(window,{asmrMovementAudio:evidence});
    const createAnalyser=AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser=function(){
      const node=createAnalyser.call(this);evidence.meter=node;return node;
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
  return page.evaluate(()=>{
    const evidence=(window as unknown as {asmrMovementAudio:MovementEvidence}).asmrMovementAudio;
    const samples=new Float32Array(evidence.meter?.fftSize??0);
    evidence.meter?.getFloatTimeDomainData(samples);
    return {
      created:evidence.sources.length,
      starts:evidence.sources.reduce((sum,source)=>sum+source.starts,0),
      stops:evidence.sources.reduce((sum,source)=>sum+source.stops,0),
      loopIds:evidence.sources.filter(source=>source.starts>0&&source.stops===0&&source.source.loop&&source.source.buffer!==null).map(source=>source.id),
      time:evidence.meter?.context.currentTime??0,
      state:evidence.meter?.context.state??null,
      peak:Math.max(0,...Array.from(samples,value=>Math.abs(value))),
    };
  });
}

async function createFixture(page:Page,baseURL:string|undefined) {
  if(!baseURL)throw new Error('Movement UI tests require a configured baseURL');
  const origin=new URL(baseURL).origin;
  const title='Movement fixture '+randomUUID().slice(0,8);
  const bytes=wavFixture({frames:48_000,channels:2});
  const pcm=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(const [index,character] of [...randomUUID()].entries())pcm.setInt16(44+index*2,1000+character.charCodeAt(0),true);
  const imported=await page.request.post('/api/assets',{headers:{origin,'content-type':'audio/wav',
    'x-asmr-metadata':JSON.stringify({displayName:title,roles:['texture'],
      provenance:{kind:'original',source:'Generated PCM for native movement interaction checks'},
      rights:{privateUse:'permitted',redistribution:'permitted'}})},data:Buffer.from(bytes)});
  expect(imported.status(),await imported.text()).toBe(201);
  const asset=await imported.json() as AssetRecord;
  const scene:Scene={schemaVersion:1,id:randomUUID(),title,revision:0,masterGain:.4,durationSeconds:null,
    layers:[{id:'movement-loop',assetId:asset.id,role:'texture',gain:.3,pan:0,muted:false,solo:false,startSeconds:0,
      loop:{...defaultLoop(asset.durationSeconds),crossfadeSeconds:0}}]};
  const saved=await page.request.post('/api/scenes',{headers:{origin},data:scene});
  expect(saved.status(),await saved.text()).toBe(201);
  await page.goto('/?scene='+scene.id);
  await expect(page.getByRole('textbox',{name:'Session name'})).toHaveValue(title);
  return {asset,scene};
}

test('movement controls preserve live sources, support keyboard edits, and retain saved/copy settings on desktop and narrow layouts',async({page,baseURL},testInfo)=>{
  await page.setViewportSize({width:1280,height:1000});
  await observeAudio(page);
  const {asset,scene}=await createFixture(page,baseURL);
  const layer=page.getByRole('group',{name:'Texture: movement-loop',exact:true});
  const details=layer.locator('.layer-movement');
  const panel=page.getByRole('group',{name:asset.displayName+' movement',exact:true});
  const mode=panel.getByRole('combobox',{name:'Movement mode',exact:true});
  const width=panel.getByRole('slider',{name:'Width',exact:true});
  const cycle=panel.getByRole('spinbutton',{name:'Cycle time',exact:true});
  const center=layer.getByRole('slider',{name:'Stereo position',exact:true});
  await expect(details.locator('summary')).toContainText('Off');
  await expect(details).not.toHaveAttribute('open');
  await details.locator('summary').click();
  await expect(mode).toHaveValue('off');
  await expect(width).toBeDisabled();await expect(width).toHaveValue('30');
  await expect(cycle).toBeDisabled();await expect(cycle).toHaveValue('30');
  await expect(page.getByText('Unsaved changes',{exact:true})).not.toBeVisible();

  await page.getByRole('button',{name:'Start listening',exact:true}).click();
  await expect.poll(async()=>(await audioSnapshot(page)).peak).toBeGreaterThan(.0001);
  const before=await audioSnapshot(page);
  expect(before.loopIds).toHaveLength(1);
  await mode.selectOption('sway');
  await expect(width).toBeEnabled();await expect(cycle).toBeEnabled();
  await width.press('ArrowRight');await expect(width).toHaveValue('31');
  await width.press('Home');await expect(width).toHaveValue('0');
  await expect(panel.getByText('Width is zero; the stereo position stays fixed.')).toBeVisible();
  await width.press('End');await expect(width).toHaveValue('100');
  await width.fill('45');
  await cycle.press('ArrowUp');await expect(cycle).toHaveValue('31');
  await cycle.press('ArrowDown');await expect(cycle).toHaveValue('30');
  await cycle.fill('8.5');await expect(cycle).toHaveValue('8.5');
  expect(await cycle.evaluate(input=>(input as HTMLInputElement).validity.valid)).toBe(true);
  await expect(details.locator('summary')).toContainText('Sway · 45% · 8.5 s');
  await center.fill('90');
  await expect(panel.getByText('Travel: Right 80% to Right 100%.')).toBeVisible();
  await expect(panel.getByText('Width is limited by the stereo position.')).toBeVisible();
  await center.press('End');
  await expect(panel.getByText('Move the stereo position away from the edge to hear sway.')).toBeVisible();
  await center.fill('20');
  await expect(panel.getByText('Travel: Left 25% to Right 65%.')).toBeVisible();
  await cycle.fill('601');await expect(cycle).toHaveAttribute('aria-invalid','true');
  await cycle.press('Tab');await expect(cycle).toHaveValue('8.5');
  await mode.selectOption('off');
  await expect(width).toBeDisabled();await expect(width).toHaveValue('45');
  await expect(cycle).toBeDisabled();await expect(cycle).toHaveValue('8.5');
  await mode.selectOption('sway');
  await expect.poll(async()=>(await audioSnapshot(page)).time).toBeGreaterThan(before.time+.3);
  const after=await audioSnapshot(page);
  expect(after).toMatchObject({created:before.created,starts:before.starts,stops:before.stops,loopIds:before.loopIds,state:'running'});
  expect(after.peak).toBeGreaterThan(.0001);
  await testInfo.attach('continuous-audio-through-movement-edits',{body:Buffer.from(JSON.stringify({before,after},null,2)),contentType:'application/json'});

  await page.getByRole('button',{name:'Save session',exact:true}).click();
  await expect(page.getByText('Saved revision 2',{exact:true})).toBeVisible();
  let saved=await(await page.request.get('/api/scenes/'+scene.id)).json() as Scene;
  expect(saved.layers[0]?.movement).toEqual({enabled:true,width:.45,cycleSeconds:8.5});
  expect(saved.layers[0]?.pan).toBe(.2);
  await mode.selectOption('off');
  await page.getByRole('button',{name:'Save session',exact:true}).click();
  await expect(page.getByText('Saved revision 3',{exact:true})).toBeVisible();
  saved=await(await page.request.get('/api/scenes/'+scene.id)).json() as Scene;
  expect(saved.layers[0]?.movement).toEqual({enabled:false,width:.45,cycleSeconds:8.5});
  const copyResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/scenes');
  await page.getByRole('button',{name:'Save a copy',exact:true}).click();
  const copyResult=await copyResponse;
  expect(copyResult.status()).toBe(201);
  const copy=await copyResult.json() as Scene;
  expect(copy.id).not.toBe(scene.id);
  expect(copy.layers[0]?.movement).toEqual(saved.layers[0]?.movement);
  expect(copy.layers[0]?.pan).toBe(.2);
  await expect(page.getByText('Saved revision 1',{exact:true})).toBeVisible();
  await page.reload();
  await expect(details.locator('summary')).toContainText('Off');
  await details.locator('summary').click();
  await expect(mode).toHaveValue('off');await expect(width).toBeDisabled();
  await expect(width).toHaveValue('45');await expect(cycle).toHaveValue('8.5');
  expect(await cycle.evaluate(input=>(input as HTMLInputElement).validity.valid)).toBe(true);
  await expect(center).toHaveValue('20');
  await mode.selectOption('sway');
  await page.getByRole('button',{name:'Start listening',exact:true}).click();
  await expect.poll(async()=>(await audioSnapshot(page)).peak).toBeGreaterThan(.0001);
  const reducedBefore=await audioSnapshot(page);

  // A rotating chevron reaches beyond its final 18px box. Check the normal-motion
  // transition in the desktop side panel as well as the settled mobile layout.
  await page.emulateMedia({reducedMotion:'no-preference'});
  for(const viewportWidth of [1280,1024]){
    await page.setViewportSize({width:viewportWidth,height:1000});
    await details.scrollIntoViewIfNeeded();
    const transitionGeometry=await details.evaluate(element=>{
      const details=element as HTMLDetailsElement;
      const summary=details.querySelector('summary')!;
      const chevron=summary.querySelector<SVGElement>('.summary-chevron')!;
      details.open=false;
      getComputedStyle(chevron).transform; // Flush the closing transition before settling it.
      for(const animation of chevron.getAnimations())animation.finish();
      summary.click();
      getComputedStyle(chevron).transform; // Create the opening CSS transition.
      const transition=chevron.getAnimations().find(animation=>animation instanceof CSSTransition&&animation.transitionProperty==='transform');
      if(!transition)throw new Error('Movement chevron should animate with normal motion');
      transition.pause();
      const duration=Number(transition.effect!.getTiming().duration);
      const samples=[0,.25,.5,.75,1].map(progress=>{
        transition.currentTime=duration*progress;
        const panel=details.getBoundingClientRect(),icon=chevron.getBoundingClientRect();
        return {progress,viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,
          panel:{x:panel.x,right:panel.right,width:panel.width,scrollWidth:details.scrollWidth,clientWidth:details.clientWidth},
          icon:{x:icon.x,right:icon.right,width:icon.width},
          controls:[...details.querySelectorAll('select,input')].map(control=>{
            const box=control.getBoundingClientRect();
            return {name:control.getAttribute('aria-label'),x:box.x,right:box.right,width:box.width,height:box.height};
          })};
      });
      transition.finish();
      return samples;
    });
    await testInfo.attach('movement-transition-geometry-'+viewportWidth,{body:Buffer.from(JSON.stringify(transitionGeometry,null,2)),contentType:'application/json'});
    expect(transitionGeometry.some(sample=>sample.icon.width>18.5)).toBe(true);
    for(const sample of transitionGeometry){
      expect(sample.documentWidth).toBeLessThanOrEqual(sample.viewport);
      expect(sample.panel.scrollWidth).toBeLessThanOrEqual(sample.panel.clientWidth+1);
      expect(sample.icon.x).toBeGreaterThanOrEqual(sample.panel.x);
      expect(sample.icon.right).toBeLessThanOrEqual(sample.panel.right);
      for(const control of sample.controls){
        expect(control.width).toBeGreaterThanOrEqual(40);
        expect(control.x).toBeGreaterThanOrEqual(sample.panel.x);
        expect(control.right).toBeLessThanOrEqual(sample.panel.right);
      }
      const modeHeight=sample.controls.find(control=>control.name==='Movement mode')!.height;
      const cycleHeight=sample.controls.find(control=>control.name==='Cycle time')!.height;
      expect(modeHeight).toBeGreaterThanOrEqual(40);
      expect(Math.abs(modeHeight-cycleHeight)).toBeLessThanOrEqual(1);
    }
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  for(const viewportWidth of [390,320]){
    await page.setViewportSize({width:viewportWidth,height:844});
    await details.scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const box=await details.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(viewportWidth);
    expect(await details.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    for(const control of [mode,width,cycle]){
      await expect(control).toBeVisible();
      const bounds=await control.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(40);expect(bounds!.height).toBeGreaterThanOrEqual(40);
    }
    const modeBounds=await mode.boundingBox(),cycleBounds=await cycle.boundingBox();
    expect(modeBounds!.height).toBeGreaterThanOrEqual(42);
    expect(cycleBounds!.height).toBeGreaterThanOrEqual(42);
    expect(Math.abs(modeBounds!.height-cycleBounds!.height)).toBeLessThanOrEqual(1);
    expect(await details.evaluate(element=>element.getAnimations({subtree:true}).length)).toBe(0);
    await testInfo.attach('movement-controls-'+viewportWidth,{body:await details.screenshot(),contentType:'image/png'});
  }
  await expect.poll(async()=>(await audioSnapshot(page)).time).toBeGreaterThan(reducedBefore.time+.2);
  const reducedAfter=await audioSnapshot(page);
  expect(reducedAfter).toMatchObject({created:reducedBefore.created,starts:reducedBefore.starts,stops:reducedBefore.stops,loopIds:reducedBefore.loopIds,state:'running'});
  expect(reducedAfter.peak).toBeGreaterThan(.0001);
  await page.getByRole('button',{name:'Stop',exact:true}).click();
});
