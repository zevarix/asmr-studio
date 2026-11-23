import {randomUUID} from 'node:crypto';
import {test,expect,type Page} from '@playwright/test';
import type {AssetRecord,ListeningTimerSettings,Scene} from '@asmr-studio/contracts';
import {wavFixture} from '../fixtures/audio.js';
import {defaultLoop} from '../../apps/web/src/features/mixer/sound-utils.js';

interface SourceEvidence {id:number;source:AudioBufferSourceNode;starts:number;stops:number;end:number}
interface TimerAudioEvidence {meter:AnalyserNode|null;sources:SourceEvidence[]}
async function observeAudio(page:Page){
  await page.addInitScript(()=>{
    const evidence:TimerAudioEvidence={meter:null,sources:[]};Object.assign(window,{asmrTimerAudio:evidence});
    const createAnalyser=AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser=function(){const node=createAnalyser.call(this);evidence.meter=node;return node;};
    const createSource=AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource=function(){
      const source=createSource.call(this),record:SourceEvidence={id:evidence.sources.length,source,starts:0,stops:0,end:Infinity};
      evidence.sources.push(record);const start=source.start.bind(source),stop=source.stop.bind(source);
      source.start=(...args:Parameters<AudioBufferSourceNode['start']>)=>{record.starts++;start(...args);};
      source.stop=(...args:Parameters<AudioBufferSourceNode['stop']>)=>{record.stops++;record.end=args[0]??source.context.currentTime;stop(...args);};
      return source;
    };
  });
}
async function audioSnapshot(page:Page){
  return page.evaluate(()=>{
    const evidence=(window as unknown as {asmrTimerAudio:TimerAudioEvidence}).asmrTimerAudio;
    const time=evidence.meter?.context.currentTime??0,samples=new Float32Array(evidence.meter?.fftSize??0);
    evidence.meter?.getFloatTimeDomainData(samples);
    return {time,peak:Math.max(0,...Array.from(samples,value=>Math.abs(value))),
      created:evidence.sources.length,starts:evidence.sources.reduce((n,source)=>n+source.starts,0),stops:evidence.sources.reduce((n,source)=>n+source.stops,0),
      loopIds:evidence.sources.filter(source=>source.starts>0&&source.end>time&&source.source.loop&&source.source.buffer!==null).map(source=>source.id)};
  });
}
async function fixture(page:Page,baseURL:string|undefined,timer?:ListeningTimerSettings){
  if(!baseURL)throw new Error('Timer UI checks require a configured baseURL');
  const origin=new URL(baseURL).origin,title='Timer fixture '+randomUUID().slice(0,8),bytes=wavFixture({frames:48_000,channels:2});
  const pcm=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(const [index,character] of [...randomUUID()].entries())pcm.setInt16(44+index*2,1000+character.charCodeAt(0),true);
  const imported=await page.request.post('/api/assets',{headers:{origin,'content-type':'audio/wav','x-asmr-metadata':JSON.stringify({
    displayName:title,roles:['texture'],provenance:{kind:'original',source:'Generated PCM for timer interaction checks'},
    rights:{privateUse:'permitted',redistribution:'permitted'}})},data:Buffer.from(bytes)});
  expect(imported.status(),await imported.text()).toBe(201);const asset=await imported.json() as AssetRecord;
  const scene:Scene={schemaVersion:1,id:randomUUID(),title,revision:0,masterGain:.4,durationSeconds:null,
    ...(timer?{listeningTimer:timer}:{}),layers:[{id:'timer-loop',assetId:asset.id,role:'texture',gain:.3,pan:0,muted:false,solo:false,startSeconds:0,
      loop:{...defaultLoop(asset.durationSeconds),crossfadeSeconds:0}}]};
  const saved=await page.request.post('/api/scenes',{headers:{origin},data:scene});expect(saved.status(),await saved.text()).toBe(201);
  await page.goto('/?scene='+scene.id);await expect(page.getByRole('textbox',{name:'Session name'})).toHaveValue(title);
  return {scene,asset};
}
async function clock(page:Page,name:'Time remaining'|'Elapsed time'){
  const text=await page.getByLabel(name,{exact:true}).textContent(),match=/(\d+):(\d{2})/.exec(text??'');
  if(!match)throw new Error(name+' is not rendered');return Number(match[1])*60+Number(match[2]);
}

test('timer controls preserve fade-only playback, pause the countdown, and retain saved settings on narrow layouts',async({page,baseURL},testInfo)=>{
  test.setTimeout(40_000);
  await page.setViewportSize({width:1280,height:1000});await observeAudio(page);const {scene}=await fixture(page,baseURL);
  const details=page.locator('.listening-timer'),panel=page.getByRole('group',{name:'Listening timer settings'});
  const mode=panel.getByRole('combobox',{name:'Listening timer mode'}),duration=panel.getByRole('spinbutton',{name:'Stop after (minutes)'});
  const fadeIn=panel.getByRole('spinbutton',{name:'Fade in (minutes)'}),fadeOut=panel.getByRole('spinbutton',{name:'Fade out (minutes)'});
  const apply=panel.getByRole('button',{name:'Apply timer'}),status=page.getByRole('region',{name:'Playback controls'}).getByRole('status');
  await details.locator('summary').click();await expect(mode).toHaveValue('off');await expect(duration).toBeDisabled();await expect(duration).toHaveValue('45');
  await expect(page.getByText('Unsaved changes',{exact:true})).not.toBeVisible();
  await page.getByRole('button',{name:'Start listening',exact:true}).click();await expect.poll(async()=>(await audioSnapshot(page)).peak).toBeGreaterThan(.001);
  await mode.selectOption('on');await duration.fill('1');await apply.click();
  await expect(panel.getByRole('alert')).toContainText('fit');expect(await clock(page,'Time remaining')).toBeGreaterThan(60);
  await fadeOut.fill('.1');await fadeIn.fill('0');await fadeIn.press('Enter');await expect(apply).toBeDisabled();
  await expect.poll(()=>clock(page,'Time remaining')).toBeLessThan(60);
  const before=await audioSnapshot(page);expect(before.loopIds).toHaveLength(1);
  await fadeOut.fill('.2');await fadeOut.press('Enter');await expect(apply).toBeDisabled();
  await expect.poll(async()=>(await audioSnapshot(page)).time).toBeGreaterThan(before.time+.1);
  const after=await audioSnapshot(page);
  expect(after).toMatchObject({created:before.created,starts:before.starts,stops:before.stops,loopIds:before.loopIds});
  expect(after.peak).toBeGreaterThan(.001);
  await testInfo.attach('fade-edit-source-continuity',{body:Buffer.from(JSON.stringify({before,after},null,2)),contentType:'application/json'});
  await page.getByRole('button',{name:'Pause',exact:true}).click();await expect(status).toContainText('Paused');
  const paused=await clock(page,'Time remaining');await page.waitForTimeout(1100);expect(await clock(page,'Time remaining')).toBe(paused);
  await page.getByRole('button',{name:'Start listening',exact:true}).click();await expect.poll(()=>clock(page,'Time remaining')).toBeLessThan(paused);
  await page.getByRole('button',{name:'Stop',exact:true}).click();await expect(page.getByLabel('Elapsed time',{exact:true})).toHaveText('0:00');
  await expect(page.getByRole('timer',{name:'Time remaining'})).toHaveText('1:00');
  expect(await status.textContent()).not.toMatch(/\d+:\d+/);
  expect(await page.getByRole('timer',{name:'Time remaining'}).evaluate(element=>element.closest('[aria-live="polite"]')===null)).toBe(true);
  await page.getByRole('button',{name:'Save session',exact:true}).click();await expect(page.getByText('Saved revision 2',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Start listening',exact:true}).click();await expect.poll(()=>clock(page,'Time remaining')).toBeLessThan(60);
  await expect(page.getByText('Unsaved changes',{exact:true})).not.toBeVisible();
  await mode.selectOption('off');await expect(fadeOut).toHaveValue('0.2');await expect(fadeOut).toBeDisabled();
  await page.getByRole('button',{name:'Save session',exact:true}).click();await expect(page.getByText('Saved revision 3',{exact:true})).toBeVisible();
  const saved=await(await page.request.get('/api/scenes/'+scene.id)).json() as Scene;
  expect(saved.listeningTimer).toEqual({enabled:false,durationSeconds:60,fadeInSeconds:0,fadeOutSeconds:12});expect(saved.durationSeconds).toBeNull();
  const copyResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/scenes');
  await page.getByRole('button',{name:'Save a copy',exact:true}).click();const copyResult=await copyResponse;expect(copyResult.status()).toBe(201);
  const copy=await copyResult.json() as Scene;expect(copy.id).not.toBe(scene.id);expect(copy.listeningTimer).toEqual(saved.listeningTimer);
  await expect(page.getByText('Saved revision 1',{exact:true})).toBeVisible();
  await page.reload();await expect(details.locator('summary')).toContainText('Off');await details.locator('summary').click();
  await expect(duration).toHaveValue('1');await expect(fadeOut).toHaveValue('0.2');await expect(fadeOut).toBeDisabled();
  await mode.selectOption('on');await fadeIn.press('Tab');await expect(fadeOut).toBeFocused();
  for(const viewport of [1280,390,320]){
    await page.setViewportSize({width:viewport,height:844});await details.scrollIntoViewIfNeeded();
    const geometry=await details.evaluate(element=>{
      const panel=element.getBoundingClientRect();return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,
        x:panel.x,right:panel.right,scrollWidth:element.scrollWidth,clientWidth:element.clientWidth,
        controls:[...element.querySelectorAll('select,input')].map(control=>{const box=control.getBoundingClientRect();return {x:box.x,right:box.right,width:box.width,height:box.height};})};
    });
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport);expect(geometry.x).toBeGreaterThanOrEqual(0);expect(geometry.right).toBeLessThanOrEqual(viewport);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth+1);
    for(const control of geometry.controls){expect(control.x).toBeGreaterThanOrEqual(geometry.x);expect(control.right).toBeLessThanOrEqual(geometry.right);expect(control.height).toBeGreaterThanOrEqual(42);expect(control.width).toBeGreaterThanOrEqual(80);}
    expect(Math.max(...geometry.controls.map(control=>control.height))-Math.min(...geometry.controls.map(control=>control.height))).toBeLessThanOrEqual(1);
    await testInfo.attach('timer-controls-'+viewport,{body:await details.screenshot(),contentType:'image/png'});
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  expect(await details.evaluate(element=>element.getAnimations({subtree:true}).length)).toBe(0);
});

test('a short timer finishes in silence and a longer WAV keeps its independently chosen endpoint',async({page,baseURL},testInfo)=>{
  test.setTimeout(40_000);
  await observeAudio(page);const timer={enabled:true,durationSeconds:1.2,fadeInSeconds:.2,fadeOutSeconds:1};
  const {scene}=await fixture(page,baseURL,timer);const status=page.getByRole('region',{name:'Playback controls'}).getByRole('status');
  const output=page.getByRole('group',{name:'Output levels',exact:true}),held=output.getByLabel('Left held peak',{exact:true});
  const heldAmplitude=async()=>{
    const text=(await held.innerText()).replace('−','-');
    if(text==='-∞ dBFS')return 0;
    const db=parseFloat(text);if(!Number.isFinite(db))throw new Error('Left held peak is not rendered: '+text);
    return 10**(db/20);
  };
  const plays=[];
  // A short faded signal can fall between transient analyser polls. The held
  // stereo peak proves this playback was audible even after the timer ends.
  for(const play of [1,2]){
    if(play>1)await output.getByRole('button',{name:'Reset peaks',exact:true}).click();
    await expect(held).toHaveText('−∞ dBFS');const baseline=await held.innerText();
    await page.getByRole('button',{name:'Start listening',exact:true}).click();await expect.poll(heldAmplitude).toBeGreaterThan(.001);
    await expect(status).toContainText('Timer finished',{timeout:7000});await expect(page.getByRole('timer',{name:'Time remaining'})).toHaveText('0:00');
    await expect.poll(async()=>(await audioSnapshot(page)).peak).toBeLessThan(.000001);
    plays.push({play,baseline,heldPeak:await held.innerText(),linearPeak:await heldAmplitude(),finalAnalyserPeak:(await audioSnapshot(page)).peak});
  }
  await testInfo.attach('fresh-held-peak-per-timer-playback',{body:Buffer.from(JSON.stringify(plays,null,2)),contentType:'application/json'});
  await expect(page.getByText('Unsaved changes',{exact:true})).not.toBeVisible();
  await page.getByRole('button',{name:'Stop',exact:true}).click();await expect(page.getByLabel('Elapsed time',{exact:true})).toHaveText('0:00');
  await page.getByText('Export mix',{exact:true}).click();const exports=page.locator('.export-panel');
  await expect(exports.getByText(/export duration sets the file.s ending/i)).toBeVisible();
  await exports.getByRole('spinbutton',{name:'Duration (minutes)'}).fill(String(1/60));await exports.getByRole('button',{name:'Export WAV',exact:true}).click();
  await expect(exports.getByRole('alert')).toContainText('fit');
  const jobs=await(await page.request.get('/api/exports')).json() as Array<{sceneId:string}>;expect(jobs.filter(job=>job.sceneId===scene.id)).toHaveLength(0);
  await exports.getByRole('spinbutton',{name:'Duration (minutes)'}).fill('.04');await exports.getByRole('button',{name:'Export WAV',exact:true}).click();
  const download=exports.getByRole('link',{name:'Download WAV'});await expect(download).toBeVisible({timeout:30000});
  const recipeUrl=await exports.getByRole('link',{name:'Recipe & credits'}).getAttribute('href');
  const recipe=await(await page.request.get(recipeUrl!)).json();expect(recipe.durationSeconds).toBe(2.4);expect(recipe.scene.listeningTimer).toEqual(timer);
  const contentUrl=await download.getAttribute('href'),response=await page.request.get(contentUrl!);expect(response.status()).toBe(200);expect((await response.body()).subarray(0,4).toString()).toBe('RIFF');
  const job=await(await page.request.get(contentUrl!.replace(/\/content$/,''))).json();expect(job.result.durationSeconds).toBe(2.4);
});
