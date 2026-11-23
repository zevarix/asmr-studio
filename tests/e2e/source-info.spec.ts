import {randomUUID} from 'node:crypto';
import {test,expect,type Locator,type Page} from '@playwright/test';
import type {AssetRecord,Scene} from '@asmr-studio/contracts';
import {wavFixture} from '../fixtures/audio.js';
import {defaultLoop} from '../../apps/web/src/features/mixer/sound-utils.js';

interface NativeSource {
  id:number;
  source:AudioBufferSourceNode;
  starts:number;
  stops:number;
}
interface NativeAudioEvidence {meter:AnalyserNode|null;sources:NativeSource[]}
interface Bounds {x:number;y:number;width:number;height:number}
interface GridGeometry {grid:Bounds;tiles:Array<Bounds & {name:string}>}

async function observeNativeAudio(page:Page):Promise<void> {
  await page.addInitScript(() => {
    const evidence:NativeAudioEvidence = {meter:null,sources:[]};
    Object.assign(window,{asmrSourceDialogAudio:evidence});
    const createAnalyser = AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser = function() {
      const meter = createAnalyser.call(this); evidence.meter = meter; return meter;
    };
    const createSource = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function() {
      const source = createSource.call(this);
      const record:NativeSource = {id:evidence.sources.length,source,starts:0,stops:0};
      evidence.sources.push(record);
      const start = source.start.bind(source);
      const stop = source.stop.bind(source);
      source.start = (...args:Parameters<AudioBufferSourceNode['start']>) => {record.starts++; start(...args);};
      source.stop = (...args:Parameters<AudioBufferSourceNode['stop']>) => {record.stops++; stop(...args);};
      return source;
    };
  });
}

async function audioSnapshot(page:Page) {
  return page.evaluate(() => {
    const evidence = (window as unknown as {asmrSourceDialogAudio:NativeAudioEvidence}).asmrSourceDialogAudio;
    const samples = new Float32Array(evidence.meter?.fftSize ?? 0);
    evidence.meter?.getFloatTimeDomainData(samples);
    return {
      created:evidence.sources.length,
      starts:evidence.sources.reduce((sum,source) => sum + source.starts,0),
      stops:evidence.sources.reduce((sum,source) => sum + source.stops,0),
      liveLoopIds:evidence.sources.filter(record => record.starts > 0 && record.stops === 0
        && record.source.loop && record.source.buffer !== null).map(record => record.id),
      state:evidence.meter?.context.state ?? null,
      currentTime:evidence.meter?.context.currentTime ?? 0,
      peak:Math.max(0,...Array.from(samples,value => Math.abs(value))),
    };
  });
}

async function fixtureScene(page:Page,baseURL:string|undefined,options:{source:string;redistribution:'forbidden'|'unknown';playing:boolean}) {
  if (!baseURL) throw new Error('Source dialog tests require the configured Playwright baseURL');
  const origin = new URL(baseURL).origin;
  const prefix = 'Source fixture ' + randomUUID().slice(0,8);
  const assets:AssetRecord[] = [];
  for (const suffix of ['recording','companion one','companion two']) {
    const bytes = wavFixture({frames:48_000,channels:2});
    const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    // Keep each import distinct even when another test has used the same PCM fixture.
    for (const [index,character] of [...randomUUID()].entries()) view.setInt16(44 + index * 2,1000 + character.charCodeAt(0),true);
    const response = await page.request.post('/api/assets',{
      headers:{origin,'content-type':'audio/wav','x-asmr-metadata':JSON.stringify({
        displayName:`${prefix} ${suffix}`,roles:['texture'],provenance:{kind:'licensed',source:options.source},
        rights:{privateUse:'permitted',redistribution:options.redistribution},
      })},data:Buffer.from(bytes),
    });
    expect(response.status(),await response.text()).toBe(201);
    assets.push(await response.json() as AssetRecord);
  }
  const asset = assets[0]!;
  const scene:Scene = {schemaVersion:1,id:randomUUID(),title:prefix,revision:0,masterGain:0.4,durationSeconds:null,
    layers:options.playing ? [{id:'source-info-loop',assetId:asset.id,role:'texture',gain:0.5,pan:0,muted:false,solo:false,
      // Use the library's decoder-tail margin: 48 kHz PCM can decode one sample short at 44.1 kHz.
      startSeconds:0,loop:{...defaultLoop(asset.durationSeconds),crossfadeSeconds:0}}] : []};
  const response = await page.request.post('/api/scenes',{headers:{origin},data:scene});
  expect(response.status(),await response.text()).toBe(201);
  await page.goto('/?scene=' + scene.id);
  await expect(page.getByRole('textbox',{name:'Session name'})).toHaveValue(prefix);
  await page.getByRole('searchbox',{name:'Search sounds'}).fill(prefix);
  await expect(page.getByRole('region',{name:'Sound library'}).getByRole('listitem')).toHaveCount(3);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return {asset,scene};
}

async function gridGeometry(page:Page):Promise<GridGeometry> {
  // DOM geometry remains measurable while the modal makes the background inert.
  return page.locator('.library .sound-grid').evaluate(grid => {
    const bounds = (element:Element) => {
      const box = element.getBoundingClientRect();
      return {x:box.x + window.scrollX,y:box.y + window.scrollY,width:box.width,height:box.height};
    };
    return {grid:bounds(grid),tiles:Array.from(grid.children,element => ({...bounds(element),
      name:element.querySelector('.sound-title strong')?.textContent ?? ''}))};
  });
}

async function expectStableGrid(page:Page,before:GridGeometry,action:string):Promise<void> {
  const after = await gridGeometry(page);
  expect(after.tiles.map(tile => tile.name),action).toEqual(before.tiles.map(tile => tile.name));
  const oldBoxes = [before.grid,...before.tiles];
  const newBoxes = [after.grid,...after.tiles];
  for (let index = 0; index < oldBoxes.length; index++) for (const dimension of ['x','y','width','height'] as const) {
    expect(Math.abs(newBoxes[index]![dimension] - oldBoxes[index]![dimension]),
      `${action}: ${index === 0 ? 'grid' : 'tile ' + index} ${dimension} changed`).toBeLessThanOrEqual(0.5);
  }
}

async function expectFocusInside(dialog:Locator):Promise<void> {
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement)),
    {message:'Keyboard focus stays in the modal'}).toBe(true);
}

async function clickBackdrop(page:Page,dialog:Locator):Promise<void> {
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error('Visible dialog and configured viewport are required');
  const point = [{x:2,y:2},{x:viewport.width - 2,y:2},{x:2,y:viewport.height - 2}].find(candidate =>
    candidate.x < box.x || candidate.x > box.x + box.width || candidate.y < box.y || candidate.y > box.y + box.height);
  if (!point) throw new Error('The dialog leaves no visible backdrop to dismiss');
  await page.mouse.click(point.x,point.y);
}

test('source modal supports keyboard and all dismissals without moving tiles or restarting live audio',async({page,baseURL}) => {
  await page.setViewportSize({width:1280,height:900});
  await observeNativeAudio(page);
  const source = 'https://example.test/recordings/source-dialog-fixture';
  const {asset} = await fixtureScene(page,baseURL,{source,redistribution:'forbidden',playing:true});
  await page.getByRole('button',{name:'Start listening',exact:true}).click();
  await expect(page.getByRole('region',{name:'Playback controls'}).getByRole('status')).toContainText('Playing');
  await expect.poll(async() => (await audioSnapshot(page)).peak).toBeGreaterThan(0.0001);
  const trigger = page.getByRole('button',{name:'Source and permission for ' + asset.displayName,exact:true});
  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  const before = await gridGeometry(page);
  const audioBefore = await audioSnapshot(page);
  expect(audioBefore.state).toBe('running');
  expect(audioBefore.liveLoopIds).toHaveLength(1);

  await trigger.press('Enter');
  const dialog = page.getByRole('dialog',{name:'Source and permission for ' + asset.displayName,exact:true});
  const close = dialog.getByRole('button',{name:'Close source and permission',exact:true});
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();
  await expect(dialog.getByRole('heading',{name:asset.displayName,exact:true})).toBeVisible();
  await expect(dialog.getByText('Private use permitted.',{exact:true})).toBeVisible();
  await expect(dialog.getByText('Redistribution is not permitted.',{exact:true})).toBeVisible();
  const link = dialog.getByRole('link',{name:source,exact:true});
  await expect(link).toHaveAttribute('href',source);
  await expect(link).toHaveAttribute('target','_blank');
  await expect(link).toHaveAttribute('rel',/\bnoopener\b/);
  await expect(link).toHaveAttribute('rel',/\bnoreferrer\b/);
  await expectStableGrid(page,before,'keyboard open');
  const content = dialog.getByRole('region',{name:'Recording source details',exact:true});
  for (const target of [content,link,close,content]) {
    await page.keyboard.press('Tab');
    await expectFocusInside(dialog);
    await expect(target).toBeFocused();
  }
  for (const target of [close,link]) {
    await page.keyboard.press('Shift+Tab');
    await expectFocusInside(dialog);
    await expect(target).toBeFocused();
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expectStableGrid(page,before,'Escape close');

  await trigger.click();
  await expect(dialog).toBeVisible();
  await expectStableGrid(page,before,'pointer open');
  await dialog.getByRole('heading',{name:'Permission',exact:true}).click();
  await expect(dialog).toBeVisible();
  await close.click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expectStableGrid(page,before,'close button');

  await trigger.click();
  await expect(dialog).toBeVisible();
  await expectStableGrid(page,before,'backdrop open');
  await clickBackdrop(page,dialog);
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expectStableGrid(page,before,'backdrop close');
  await expect.poll(async() => (await audioSnapshot(page)).currentTime).toBeGreaterThan(audioBefore.currentTime + 0.3);
  const audioAfter = await audioSnapshot(page);
  expect(audioAfter).toMatchObject({created:audioBefore.created,starts:audioBefore.starts,stops:audioBefore.stops,
    liveLoopIds:audioBefore.liveLoopIds,state:'running'});
  expect(audioAfter.peak).toBeGreaterThan(0.0001);
  await expect(page.getByRole('region',{name:'Playback controls'}).getByRole('status')).toContainText('Playing');
});

test('phone source modal wraps long attribution, scrolls inside the dialog and keeps unsafe URLs as text',async({page,baseURL}) => {
  await page.setViewportSize({width:390,height:640});
  const source = 'javascript:fixtureOnly() ' + 'unbrokensourceidentifier'.repeat(30)
    + Array.from({length:45},(_,index) => ` Attribution ${index + 1}: generated source evidence for a private listening fixture.`).join('')
    + ' End of source attribution.';
  const {asset} = await fixtureScene(page,baseURL,{source,redistribution:'unknown',playing:false});
  const trigger = page.getByRole('button',{name:'Source and permission for ' + asset.displayName,exact:true});
  await trigger.scrollIntoViewIfNeeded();
  const before = await gridGeometry(page);
  await trigger.click();
  const dialog = page.getByRole('dialog',{name:'Source and permission for ' + asset.displayName,exact:true});
  const close = dialog.getByRole('button',{name:'Close source and permission',exact:true});
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();
  await expect(dialog.getByRole('link')).toHaveCount(0);
  await expect(dialog).toContainText('javascript:fixtureOnly()');
  await expect(dialog).toContainText('End of source attribution.');
  await expect(dialog).toContainText('Private use permitted.');
  await expect(dialog).toContainText('Redistribution permission is not recorded.');
  await expectStableGrid(page,before,'phone modal open');

  const geometry = await dialog.evaluate(element => {
    const box = element.getBoundingClientRect();
    return {left:box.left,top:box.top,right:box.right,bottom:box.bottom,width:window.innerWidth,height:window.innerHeight,
      pageWidth:document.documentElement.scrollWidth,dialogWidth:element.scrollWidth,clientWidth:element.clientWidth};
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width + 0.5);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height + 0.5);
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.width);
  expect(geometry.dialogWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  const content = dialog.locator('.source-dialog-content');
  const scroll = await content.evaluate(element => ({height:element.clientHeight,scrollHeight:element.scrollHeight,
    width:element.clientWidth,scrollWidth:element.scrollWidth}));
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.height);
  expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.width + 1);
  await content.hover();
  await page.mouse.wheel(0,10_000);
  await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(dialog.getByText('Redistribution permission is not recorded.',{exact:true})).toBeInViewport();
  await expect(close).toBeInViewport();
  await expectStableGrid(page,before,'phone modal scroll');
  await close.click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expectStableGrid(page,before,'phone modal close');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
