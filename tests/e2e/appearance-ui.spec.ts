import {randomUUID} from 'node:crypto';
import {test,expect,type Page} from '@playwright/test';
import type {AssetRecord,Scene} from '@asmr-studio/contracts';
import {wavFixture} from '../fixtures/audio.js';
import {defaultLoop} from '../../apps/web/src/features/mixer/sound-utils.js';

const themes=['Sage','Ocean','Amethyst','Ember','Rose','Graphite'] as const;
interface AudioEvidence {contexts:AudioContext[];sources:{node:AudioBufferSourceNode;starts:number;stops:number}[]}

async function observeAudio(page:Page) {
  await page.addInitScript(()=>{
    const evidence:AudioEvidence={contexts:[],sources:[]};
    Object.assign(window,{appearanceAudio:evidence});
    const createSource=AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource=function(){
      if(!evidence.contexts.includes(this))evidence.contexts.push(this);
      const node=createSource.call(this),record={node,starts:0,stops:0};
      evidence.sources.push(record);
      const start=node.start.bind(node),stop=node.stop.bind(node);
      node.start=(...args:Parameters<AudioBufferSourceNode['start']>)=>{record.starts++;start(...args);};
      node.stop=(...args:Parameters<AudioBufferSourceNode['stop']>)=>{record.stops++;stop(...args);};
      return node;
    };
  });
}

async function audioSnapshot(page:Page) {
  return page.evaluate(()=>{
    const evidence=(window as unknown as {appearanceAudio:AudioEvidence}).appearanceAudio;
    return {contexts:evidence.contexts.length,created:evidence.sources.length,
      starts:evidence.sources.reduce((sum,item)=>sum+item.starts,0),
      stops:evidence.sources.reduce((sum,item)=>sum+item.stops,0),
      loops:evidence.sources.filter(item=>item.starts>0&&item.stops===0&&item.node.loop).length,
      time:evidence.contexts[0]?.currentTime??0,state:evidence.contexts[0]?.state??null};
  });
}

async function createMix(page:Page,baseURL:string|undefined) {
  if(!baseURL)throw new Error('Appearance checks require a configured baseURL');
  const origin=new URL(baseURL).origin,title='Appearance mix '+randomUUID().slice(0,8);
  const bytes=wavFixture({frames:48_000,channels:2});
  const pcm=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let frame=0;frame<48_000;frame++){
    const sample=Math.round(4000*Math.sin(frame*.03));
    pcm.setInt16(44+frame*4,sample,true);pcm.setInt16(46+frame*4,sample,true);
  }
  const imported=await page.request.post('/api/assets',{headers:{origin,'content-type':'audio/wav',
    'x-asmr-metadata':JSON.stringify({displayName:title+' recording',roles:['ambience'],
      provenance:{kind:'original',source:'Generated PCM for appearance and playback checks'},
      rights:{privateUse:'permitted',redistribution:'permitted'}})},data:Buffer.from(bytes)});
  expect(imported.status(),await imported.text()).toBe(201);
  const asset=await imported.json() as AssetRecord;
  const scene:Scene={schemaVersion:1,id:randomUUID(),title,revision:0,masterGain:.5,durationSeconds:null,
    layers:[{id:'appearance-loop',assetId:asset.id,role:'ambience',gain:.3,pan:0,muted:false,solo:false,startSeconds:0,
      loop:{...defaultLoop(asset.durationSeconds),crossfadeSeconds:0}}]};
  const saved=await page.request.post('/api/scenes',{headers:{origin},data:scene});
  expect(saved.status(),await saved.text()).toBe(201);
  await page.goto('/?scene='+scene.id);
  await expect(page.getByRole('textbox',{name:'Session name'})).toHaveValue(title);
  return (await(await page.request.get('/api/scenes/'+scene.id)).json()) as Scene;
}

test('theme changes preserve a playing mix and persist through reloads and transition views',async({page,baseURL},testInfo)=>{
  await page.setViewportSize({width:1280,height:1000});
  await observeAudio(page);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const saved=await createMix(page,baseURL);
  const writes:string[]=[];
  page.on('request',request=>{
    if(new URL(request.url()).pathname.startsWith('/api/scenes')&&request.method()!=='GET')writes.push(request.method());
  });
  const trigger=page.getByRole('button',{name:/^Appearance/});
  await expect(page.locator('html')).toHaveAttribute('data-theme','sage');
  await page.getByRole('button',{name:'Start listening',exact:true}).click();
  await expect(page.getByRole('region',{name:'Playback controls'}).getByRole('status')).toHaveText('Playing');
  await expect.poll(()=>page.getByRole('meter',{name:'Left output level'}).evaluate(node=>(node as HTMLMeterElement).value)).toBeGreaterThan(-60);
  const before=await audioSnapshot(page);
  expect(before.loops).toBe(1);
  await trigger.click();
  const palettes=[];
  for(const name of themes){
    await page.getByRole('radio',{name,exact:true}).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme',name.toLowerCase());
    await expect(page.getByRole('slider',{name:'Master volume',exact:true})).toHaveValue('50');
    await expect(page.getByText('Unsaved changes',{exact:true})).not.toBeVisible();
    palettes.push(await page.evaluate(()=>({
      canvas:getComputedStyle(document.documentElement).backgroundColor,
      panel:getComputedStyle(document.querySelector('.session')!).backgroundImage,
      dial:getComputedStyle(document.querySelector('.eq-knob-face-light')!).stopColor,
      meter:getComputedStyle(document.querySelector('.output-meter-lights')!,'::before').backgroundImage,
    })));
  }
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded','false');
  for(const material of ['canvas','panel','dial'] as const)expect(new Set(palettes.map(palette=>palette[material])).size).toBe(6);
  expect(new Set(palettes.map(palette=>palette.meter)).size).toBe(1);
  await expect.poll(async()=>(await audioSnapshot(page)).time).toBeGreaterThan(before.time+.3);
  const after=await audioSnapshot(page);
  expect(after).toMatchObject({contexts:before.contexts,created:before.created,starts:before.starts,stops:before.stops,loops:1,state:'running'});
  expect(writes).toEqual([]);
  expect(await(await page.request.get('/api/scenes/'+saved.id)).json()).toEqual(saved);
  await testInfo.attach('appearance-preserves-playback',{body:Buffer.from(JSON.stringify({before,after,palettes},null,2)),contentType:'application/json'});

  await page.reload();
  await expect(page.getByRole('textbox',{name:'Session name'})).toHaveValue(saved.title);
  await expect(page.locator('html')).toHaveAttribute('data-theme','graphite');
  await expect(trigger).toHaveAccessibleName('Appearance Graphite');
  await page.getByRole('button',{name:'New transition',exact:true}).click();
  await expect(page.getByRole('region',{name:'Current transition arrangement',exact:true})).toBeVisible();
  await trigger.click();
  await expect(page.getByRole('radio',{name:'Graphite',exact:true})).toBeChecked();
  await page.getByRole('radio',{name:'Ember',exact:true}).check();
  await page.getByRole('heading',{name:'ASMR Studio',exact:true}).click();
  await expect(trigger).toHaveAttribute('aria-expanded','false');
  await page.goto('/?scene='+saved.id);
  await expect(page.getByRole('textbox',{name:'Session name'})).toHaveValue(saved.title);
  await expect(page.locator('html')).toHaveAttribute('data-theme','ember');
  expect(errors).toEqual([]);
});

test('appearance choices support keyboard navigation, narrow screens and forced colors',async({page,baseURL},testInfo)=>{
  await createMix(page,baseURL);
  const trigger=page.getByRole('button',{name:/^Appearance/});
  await trigger.focus();await trigger.press('Enter');
  const sage=page.getByRole('radio',{name:'Sage',exact:true});
  await expect(sage).toBeFocused();
  await sage.press('ArrowRight');
  const ocean=page.getByRole('radio',{name:'Ocean',exact:true});
  await expect(ocean).toBeFocused();await expect(ocean).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme','ocean');
  await ocean.press('Escape');await expect(trigger).toBeFocused();

  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});await trigger.click();
    await expect(ocean).toBeChecked();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    for(const name of themes){
      const radio=page.getByRole('radio',{name,exact:true});
      await expect(radio).toBeVisible();
      const bounds=await radio.locator('..').boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.press('Escape');
  }
  if(testInfo.project.name==='chromium'){
    await page.emulateMedia({forcedColors:'active'});await trigger.click();
    await expect(ocean).toBeChecked();await expect(ocean).toBeFocused();
    expect(await ocean.evaluate(input=>getComputedStyle(input).appearance)).not.toBe('none');
    await ocean.press('ArrowRight');
    await expect(page.getByRole('radio',{name:'Amethyst',exact:true})).toBeChecked();
  }
});

test('themes remain usable when browser storage is unavailable',async({page,baseURL})=>{
  await page.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Storage unavailable','SecurityError');}}));
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await createMix(page,baseURL);
  await expect(page.locator('html')).toHaveAttribute('data-theme','sage');
  await page.getByRole('button',{name:/^Appearance/}).click();
  await page.getByRole('radio',{name:'Rose',exact:true}).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme','rose');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'New transition',exact:true}).click();
  await expect(page.getByRole('button',{name:'Appearance Rose',exact:true})).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme','sage');
  expect(errors).toEqual([]);
});
