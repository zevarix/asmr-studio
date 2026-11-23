import {randomUUID} from 'node:crypto';
import {test,expect,type Page} from '@playwright/test';
import {wavFixture} from '../fixtures/audio.js';
import {fixtureLayer,fixtureScene} from '../fixtures/scene.js';
import {defaultLoop} from '../../apps/web/src/features/mixer/sound-utils.js';

async function savedMix(page:Page,origin:string,title:string) {
  const uploaded=await page.request.post('/api/assets',{headers:{origin,'content-type':'audio/wav',
    'x-asmr-metadata':JSON.stringify({displayName:title+' recording',roles:['ambience'],provenance:{kind:'original',source:'Generated browser test PCM'},
      rights:{privateUse:'permitted',redistribution:'permitted'}})},data:Buffer.from(wavFixture({sampleRate:48000,frames:48000,channels:2}))});
  expect(uploaded.status()).toBe(201);const asset=await uploaded.json();
  const created=await page.request.post('/api/scenes',{headers:{origin},data:{...fixtureScene(),id:'mix-'+randomUUID(),title,revision:0,masterGain:.5,
    layers:[fixtureLayer({assetId:asset.id,loop:defaultLoop(asset.durationSeconds)})]}});
  expect(created.status()).toBe(201);return {scene:await created.json(),asset};
}
const deck=(page:Page,side:'A'|'B')=>page.getByRole('region',{name:'Mix '+side,exact:true});
async function choose(page:Page,side:'A'|'B',id:string,revision:number) {
  await page.getByRole('combobox',{name:'Choose mix '+side}).selectOption(id);
  await expect(deck(page,side).getByText('Captured revision '+revision,{exact:true})).toBeVisible();
}

test('a distinct arrangement protects a dirty source, freezes captures, survives conflicts/copy, and exports at narrow width',async({page,baseURL})=>{
  test.setTimeout(60000);
  const origin=new URL(baseURL!).origin;
  const a=await savedMix(page,origin,'Morning rain');const b=await savedMix(page,origin,'Evening rain');
  await page.goto('/?scene='+a.scene.id);
  await expect(page.getByRole('slider',{name:'Master volume'})).toBeEnabled();
  await page.getByRole('slider',{name:'Master volume'}).fill('35');
  await page.getByRole('button',{name:'New transition'}).click();
  await expect(page.getByRole('group',{name:'Unsaved session changes'})).toBeVisible();
  await page.getByRole('button',{name:'Save and continue'}).click();
  await expect(page.getByRole('region',{name:'Current transition arrangement'})).toBeVisible();
  const source=await(await page.request.get('/api/scenes/'+a.scene.id)).json();
  expect(source).toMatchObject({revision:2,masterGain:.35});
  await choose(page,'A',a.scene.id,2);await choose(page,'B',b.scene.id,1);
  const fader=page.getByRole('slider',{name:'Crossfader'});
  await fader.focus();await page.keyboard.press('ArrowRight');await expect(fader).toHaveValue('1');
  await page.keyboard.press('End');await expect(fader).toHaveValue('100');
  await fader.fill('35');await expect(fader).toHaveAttribute('aria-valuetext','A 65 percent, B 35 percent');
  await page.getByRole('textbox',{name:'Session name'}).fill('Morning to evening');
  await page.getByRole('textbox',{name:'Session name'}).press('Tab');
  await page.setViewportSize({width:320,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  for(const name of ['Master volume','Output ceiling','Crossfader']){
    const bounds=await page.getByRole('slider',{name,exact:true}).boundingBox();
    expect(bounds?.height??0,name+' touch target height').toBeGreaterThanOrEqual(42);
  }
  await page.getByRole('button',{name:'Save arrangement'}).click();
  await expect(page.getByText('Saved revision 1',{exact:true})).toBeVisible();
  const arrangementId=new URL(page.url()).searchParams.get('scene')!;
  expect([a.scene.id,b.scene.id]).not.toContain(arrangementId);
  const arrangement=await(await page.request.get('/api/scenes/'+arrangementId)).json();
  expect(arrangement.transition).toMatchObject({mode:'manual',blend:.35,a:{scene:{id:a.scene.id,revision:2,masterGain:.35}},b:{scene:{id:b.scene.id,revision:1}}});
  expect((await page.request.put('/api/scenes/'+source.id,{headers:{origin},data:{scene:{...source,title:'Later source edit',masterGain:.1},expectedRevision:2}})).status()).toBe(200);
  await page.reload();
  await expect(deck(page,'A').getByRole('heading',{name:'Morning rain'})).toBeVisible();
  await expect(deck(page,'A').getByText('Captured revision 2',{exact:true})).toBeVisible();
  await expect(fader).toHaveValue('35');
  // Another editor advances the arrangement; this tab must retain its blend and captures.
  expect((await page.request.put('/api/scenes/'+arrangementId,{headers:{origin},data:{scene:{...arrangement,masterGain:.5},expectedRevision:1}})).status()).toBe(200);
  await fader.fill('70');await page.getByRole('button',{name:'Save arrangement'}).click();
  await expect(page.getByText(/Another editor saved a newer revision/)).toBeVisible();
  await expect(fader).toHaveValue('70');
  await page.getByRole('button',{name:'Save a copy'}).click();
  await expect(page.getByText('Saved revision 1',{exact:true})).toBeVisible();
  const copyId=new URL(page.url()).searchParams.get('scene')!;expect(copyId).not.toBe(arrangementId);
  const copy=await(await page.request.get('/api/scenes/'+copyId)).json();
  expect(copy.transition.a).toEqual(arrangement.transition.a);expect(copy.transition.b).toEqual(arrangement.transition.b);expect(copy.transition.blend).toBe(.7);
  expect((await(await page.request.get('/api/scenes/'+arrangementId)).json()).transition.blend).toBe(.35);
  await page.getByText('Export mix',{exact:true}).click();
  await page.getByRole('spinbutton',{name:'Duration (minutes)'}).fill('0.02');
  await page.getByRole('button',{name:'Export WAV',exact:true}).click();
  await expect(page.getByRole('link',{name:'Download WAV'})).toBeVisible({timeout:30000});
  const recipeUrl=await page.getByRole('link',{name:'Recipe & credits'}).getAttribute('href');
  const recipe=await(await page.request.get(recipeUrl!)).json();
  expect(recipe.scene.transition).toEqual(copy.transition);expect(recipe.sceneRevision??recipe.scene.revision).toBe(1);
  expect(recipe.assets.map((asset:{id:string})=>asset.id).sort()).toEqual([a.asset.id,b.asset.id].sort());
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('loading or failing B preserves A playback, then timed pause/resume and cancel hold the blend',async({page,baseURL})=>{
  test.setTimeout(40000);
  const origin=new URL(baseURL!).origin;
  const a=await savedMix(page,origin,'Steady A');const b=await savedMix(page,origin,'Delayed B');
  await page.goto('/?scene='+a.scene.id);
  await page.getByRole('button',{name:'New transition'}).click();
  await choose(page,'A',a.scene.id,1);
  await page.getByRole('button',{name:'Start listening'}).click();
  const transport=page.getByRole('region',{name:'Playback controls'});
  await expect(transport.getByRole('status')).toHaveText('Playing');
  const peak=()=>page.getByRole('meter',{name:'Left output level'}).evaluate(node=>(node as HTMLMeterElement).value);
  await expect.poll(peak).toBeGreaterThan(-60);
  let release!:()=>void;let arrive!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});const requested=new Promise<void>(resolve=>{arrive=resolve;});
  const pattern='**/api/assets/'+b.asset.id+'/content';
  await page.route(pattern,async route=>{arrive();await blocked;await route.fulfill({status:503,body:'Unavailable test audio'});});
  try{
    await page.getByRole('combobox',{name:'Choose mix B'}).selectOption(b.scene.id);await requested;
    await expect(deck(page,'B').getByRole('status')).toContainText('Loading mix B');
    await expect(transport.getByRole('status')).toHaveText('Playing');await expect.poll(peak).toBeGreaterThan(-60);
    await expect(page.getByRole('button',{name:'Pause'})).toBeEnabled();
    await expect(page.getByRole('button',{name:'Save arrangement'})).toBeDisabled();
    release();
    await expect(deck(page,'B').getByRole('alert')).toContainText('current audio are still here');
    await expect(transport.getByRole('status')).toHaveText('Playing');await expect.poll(peak).toBeGreaterThan(-60);
    await expect(page.getByRole('combobox',{name:'Choose mix B'})).toHaveValue('');
  }finally{release();await page.unroute(pattern);}
  await choose(page,'B',b.scene.id,1);
  await page.getByRole('spinbutton',{name:'Transition duration (seconds)'}).fill('2');
  await page.getByRole('button',{name:'Transition to B in 2 seconds'}).click();
  const fader=page.getByRole('slider',{name:'Crossfader'});
  await expect.poll(async()=>Number(await fader.inputValue())).toBeGreaterThan(5);
  await page.getByRole('button',{name:'Pause'}).click();
  await expect(page.getByText('Timed transition paused',{exact:true})).toBeVisible();
  const paused=await fader.inputValue();await page.waitForTimeout(180);await expect(fader).toHaveValue(paused);
  await page.getByRole('button',{name:'Start listening'}).click();await expect(transport.getByRole('status')).toHaveText('Playing');
  await page.getByRole('button',{name:'Cancel transition'}).click();await expect(page.getByText('Manual blend',{exact:true})).toBeVisible();
  const held=await fader.inputValue();await page.waitForTimeout(180);await expect(fader).toHaveValue(held);
  expect(Number(held)).toBeGreaterThan(0);expect(Number(held)).toBeLessThan(100);
  await page.getByRole('button',{name:'Pause'}).click();await expect(transport.getByRole('status')).toHaveText('Paused');
  await fader.fill('62');
  expect(await fader.inputValue()).toBe('62');
  expect(await fader.getAttribute('aria-valuetext')).toBe('A 38 percent, B 62 percent');
  await page.waitForTimeout(180);
  expect(await fader.inputValue()).toBe('62');
  expect(await fader.getAttribute('aria-valuetext')).toBe('A 38 percent, B 62 percent');
  await page.getByRole('button',{name:'Save arrangement'}).click();await expect(page.getByText('Saved revision 1',{exact:true})).toBeVisible();
  const savedId=new URL(page.url()).searchParams.get('scene')!;
  expect((await(await page.request.get('/api/scenes/'+savedId)).json()).transition).toMatchObject({mode:'manual',blend:.62});
  await page.getByRole('button',{name:'Restart arrangement'}).click();await expect(transport.getByRole('status')).toHaveText('Playing');
  await page.waitForTimeout(180);
  expect(await fader.inputValue()).toBe('62');
  expect(await fader.getAttribute('aria-valuetext')).toBe('A 38 percent, B 62 percent');
  await page.getByRole('button',{name:'Stop',exact:true}).click();
});
