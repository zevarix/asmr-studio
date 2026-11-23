import {randomUUID} from 'node:crypto';
import {test,expect,type Locator,type Page} from '@playwright/test';
import type {AssetRecord,Scene} from '@asmr-studio/contracts';
import {wavFixture} from '../fixtures/audio.js';
import {defaultLoop} from '../../apps/web/src/features/mixer/sound-utils.js';

async function createMixes(page:Page,baseURL:string|undefined) {
  if(!baseURL)throw new Error('Studio control tests require a configured baseURL');
  const origin=new URL(baseURL).origin;
  const title='Studio faders '+randomUUID().slice(0,8);
  const bytes=wavFixture({frames:48_000,channels:2});
  const pcm=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(const [index,character] of [...randomUUID()].entries())pcm.setInt16(44+index*2,1000+character.charCodeAt(0),true);
  const imported=await page.request.post('/api/assets',{headers:{origin,'content-type':'audio/wav',
    'x-asmr-metadata':JSON.stringify({displayName:title+' recording',roles:['ambience'],
      provenance:{kind:'original',source:'Generated PCM for native studio control checks'},
      rights:{privateUse:'permitted',redistribution:'permitted'}})},data:Buffer.from(bytes)});
  expect(imported.status(),await imported.text()).toBe(201);
  const asset=await imported.json() as AssetRecord;
  const scene:Scene={schemaVersion:1,id:randomUUID(),title,revision:0,masterGain:.5,durationSeconds:null,
    layers:[{id:'fader-loop',assetId:asset.id,role:'ambience',gain:.3,pan:0,muted:false,solo:false,startSeconds:0,
      loop:{...defaultLoop(asset.durationSeconds),crossfadeSeconds:0}}]};
  const second={...scene,id:randomUUID(),title:title+' second mix'};
  for(const mix of [scene,second]){
    const saved=await page.request.post('/api/scenes',{headers:{origin},data:mix});
    expect(saved.status(),await saved.text()).toBe(201);
  }
  return {scene,second};
}

async function dragFromCenter(page:Page,slider:Locator,toward:number) {
  // At 50% the native cap is centered regardless of its rendered width.
  await expect(slider).toHaveValue('50');
  await slider.scrollIntoViewIfNeeded();
  const box=await slider.boundingBox();
  if(!box)throw new Error('The fader must be visible before dragging');
  const y=box.y+box.height/2;
  await page.mouse.move(box.x+box.width/2,y);
  await page.mouse.down();
  await expect(slider).toHaveValue('50');
  await page.mouse.move(box.x+box.width*toward,y,{steps:12});
  await page.mouse.up();
  return Number(await slider.inputValue());
}

test('studio fader caps preserve native editing, accessible pan, disabled loading and saved values',async({page,baseURL})=>{
  await page.setViewportSize({width:1280,height:1000});
  const {scene,second}=await createMixes(page,baseURL);
  const master=page.getByRole('slider',{name:'Master volume',exact:true});
  const editor=page.getByRole('group',{name:'Session editor',exact:true});
  const pattern='**/api/scenes/'+scene.id;
  let release!:()=>void;let arrive!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const requested=new Promise<void>(resolve=>{arrive=resolve;});
  await page.route(pattern,async route=>{arrive();await blocked;await route.continue();});
  try{
    await page.goto('/?scene='+scene.id);
    await requested;
    await expect(editor).toHaveAttribute('disabled','');
    await expect(master).toBeDisabled();
    const loadingValue=await master.inputValue();
    await master.scrollIntoViewIfNeeded();
    const box=await master.boundingBox();
    if(!box)throw new Error('The disabled fader should remain visible');
    await page.mouse.move(box.x+box.width*.75,box.y+box.height/2);
    await page.mouse.down();
    await page.mouse.move(box.x+box.width*.1,box.y+box.height/2,{steps:8});
    await page.mouse.up();
    await expect(master).toHaveValue(loadingValue);
    release();
    await expect(page.getByRole('textbox',{name:'Session name'})).toHaveValue(scene.title);
    await expect(master).toBeEnabled();
  }finally{release();await page.unrouteAll({behavior:'wait'});}

  const volume=await dragFromCenter(page,master,.75);
  expect(volume).toBeGreaterThan(65);expect(volume).toBeLessThan(90);
  const layer=page.getByRole('group',{name:'Ambience: fader-loop',exact:true});
  const layerVolume=layer.getByRole('slider',{name:'Volume',exact:true});
  const pan=layer.getByRole('slider',{name:'Stereo position',exact:true});
  await expect(pan).toHaveValue('0');
  await expect(pan).toHaveAttribute('aria-valuetext','Center');
  await pan.focus();
  await pan.press('ArrowLeft');
  await expect(pan).toHaveValue('-1');
  await expect(pan).toHaveAttribute('aria-valuetext','Left 1 percent');
  await expect(pan).toBeFocused();
  expect(await pan.evaluate(input=>getComputedStyle(input).outlineStyle)).not.toBe('none');
  await pan.press('ArrowRight');
  await expect(pan).toHaveValue('0');
  await expect(pan).toHaveAttribute('aria-valuetext','Center');
  await pan.press('ArrowRight');
  await expect(pan).toHaveValue('1');
  await expect(pan).toHaveAttribute('aria-valuetext','Right 1 percent');

  await page.getByRole('button',{name:'Save session',exact:true}).click();
  await expect(page.getByText('Saved revision 2',{exact:true})).toBeVisible();
  const savedResponse=await page.request.get('/api/scenes/'+scene.id);
  expect(savedResponse.status()).toBe(200);
  const saved=await savedResponse.json() as Scene;
  expect(saved.masterGain).toBeCloseTo(volume/100,6);
  expect(saved.layers[0]?.pan).toBe(.01);
  await page.reload();
  await expect(master).toHaveValue(String(volume));
  await expect(pan).toHaveValue('1');
  await expect(pan).toHaveAttribute('aria-valuetext','Right 1 percent');

  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    for(const slider of [master,layerVolume,pan]){
      await slider.scrollIntoViewIfNeeded();
      await expect(slider).toBeVisible();
      const box=await slider.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x+box!.width).toBeLessThanOrEqual(width);
    }
  }

  await page.getByRole('button',{name:'New transition',exact:true}).click();
  await expect(page.getByRole('region',{name:'Current transition arrangement',exact:true})).toBeVisible();
  for(const [side,mix,revision] of [['A',scene,2],['B',second,1]] as const){
    await page.getByRole('combobox',{name:'Choose mix '+side}).selectOption(mix.id);
    await expect(page.getByRole('region',{name:'Mix '+side,exact:true}).getByText('Captured revision '+revision,{exact:true})).toBeVisible();
  }
  const crossfader=page.getByRole('slider',{name:'Crossfader',exact:true});
  await crossfader.fill('50');
  const blend=await dragFromCenter(page,crossfader,.25);
  expect(blend).toBeGreaterThan(10);expect(blend).toBeLessThan(40);
  await expect(crossfader).toHaveAttribute('aria-valuetext',`A ${100-blend} percent, B ${blend} percent`);
  const bounds=await crossfader.boundingBox();
  expect(bounds?.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Save arrangement',exact:true}).click();
  await expect(page.getByText('Saved revision 1',{exact:true})).toBeVisible();
  const arrangementId=new URL(page.url()).searchParams.get('scene')!;
  const arrangement=await(await page.request.get('/api/scenes/'+arrangementId)).json() as Scene;
  expect(arrangement.transition?.blend).toBeCloseTo(blend/100,6);
});
