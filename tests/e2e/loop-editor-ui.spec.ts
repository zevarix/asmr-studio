import {randomUUID} from 'node:crypto';
import {expect,test,type Page} from '@playwright/test';
import type {AssetRecord,Layer,Scene} from '@asmr-studio/contracts';
import {wavFixture} from '../fixtures/audio.js';

const duration = 4;
const sampleRate = 48_000;
const originalLoop = {startSeconds:.25,endSeconds:3.5,crossfadeSeconds:.125};
const neighborLoop = {startSeconds:.5,endSeconds:3,crossfadeSeconds:0};

async function seedScene(page:Page,baseURL:string|undefined) {
  if (!baseURL) throw new Error('Loop editor browser tests require a configured baseURL');
  const origin = new URL(baseURL).origin;
  const title = 'Loop editor fixture ' + randomUUID().slice(0,8);
  const assets:AssetRecord[] = [];
  for (const [index,name] of ['selected','neighbor'].entries()) {
    const frames = duration * sampleRate;
    const audio = wavFixture({frames,sampleRate});
    const pcm = new DataView(audio.buffer,audio.byteOffset,audio.byteLength);
    for (let frame = 0; frame < frames; frame++) {
      const envelope = .55 + .35 * Math.sin(frame / frames * 2 * Math.PI * (index + 1));
      const sample = Math.round(18_000 * envelope * Math.sin(frame / sampleRate * 2 * Math.PI * (220 + 100 * index)));
      pcm.setInt16(44 + frame * 4,sample,true);
      pcm.setInt16(46 + frame * 4,-sample / 2,true);
    }
    for (const [frame,character] of [...randomUUID()].entries()) pcm.setInt16(44 + frame * 4,character.charCodeAt(0),true);
    const imported = await page.request.post('/api/assets',{
      headers:{origin,'content-type':'audio/wav','x-asmr-metadata':JSON.stringify({
        displayName:`${title} ${name}`,roles:['texture'],provenance:{kind:'original',source:'Generated PCM fixture'},
        rights:{privateUse:'permitted',redistribution:'permitted'},
      })},
      data:Buffer.from(audio),
    });
    expect(imported.status(),await imported.text()).toBe(201);
    assets.push(await imported.json() as AssetRecord);
  }
  const layers:Layer[] = assets.map((asset,index)=>({
    id:index === 0 ? 'selected-loop' : 'neighbor-loop',assetId:asset.id,role:'texture',gain:.3,pan:0,
    muted:false,solo:false,startSeconds:0,loop:index === 0 ? originalLoop : neighborLoop,
  }));
  const recipe:Scene = {schemaVersion:1,id:randomUUID(),title,revision:0,masterGain:.4,durationSeconds:null,layers};
  const response = await page.request.post('/api/scenes',{headers:{origin},data:recipe});
  expect(response.status(),await response.text()).toBe(201);
  return {scene:await response.json() as Scene,asset:assets[0]!};
}

async function openScene(page:Page,scene:Scene) {
  await page.goto('/?scene='+scene.id);
  await expect(page.getByRole('textbox',{name:'Session name'})).toHaveValue(scene.title);
}

function loopPanel(page:Page,layerId:string) {
  const details = page.getByRole('group',{name:`Texture: ${layerId}`,exact:true}).locator('.loop-details');
  return {
    details,
    summary:details.locator('summary'),
    waveform:details.getByRole('group',{name:'Loop waveform'}),
    start:details.getByRole('spinbutton',{name:'Loop start'}),
    end:details.getByRole('spinbutton',{name:'Loop end'}),
    fade:details.getByRole('spinbutton',{name:'Loop crossfade'}),
    apply:details.getByRole('button',{name:'Apply loop'}),
    preview:details.getByRole('button',{name:'Preview join'}),
  };
}

async function storedScene(page:Page,sceneId:string):Promise<Scene> {
  const response = await page.request.get('/api/scenes/'+sceneId);
  expect(response.ok(),await response.text()).toBe(true);
  return await response.json() as Scene;
}

test('waveform handles synchronize exact draft values and only the applied layer is saved',async({page,baseURL},testInfo)=>{
  test.setTimeout(35_000);
  await page.setViewportSize({width:1280,height:950});
  const {scene} = await seedScene(page,baseURL);
  await openScene(page,scene);
  const selected = loopPanel(page,'selected-loop');
  const neighbor = loopPanel(page,'neighbor-loop');
  const unsaved = page.getByText('Unsaved changes',{exact:true});
  await selected.summary.click();
  await expect(selected.waveform).toBeVisible();
  await expect(selected.waveform.locator('svg .loop-waveform-peaks')).toHaveAttribute('d',/^M\d/);
  const overlaps = await selected.waveform.locator('svg .loop-waveform-overlap').evaluateAll(edges=>
    edges.map(edge=>({x:Number(edge.getAttribute('x')),width:Number(edge.getAttribute('width'))})));
  expect(overlaps).toHaveLength(2);
  expect(overlaps[0]!.width).toBeGreaterThan(0);
  expect(overlaps[1]!.width).toBe(overlaps[0]!.width);
  expect(overlaps[1]!.x).toBeGreaterThan(overlaps[0]!.x);

  const startHandle = selected.waveform.getByRole('slider',{name:'Waveform start'});
  await startHandle.scrollIntoViewIfNeeded();
  const track = await startHandle.boundingBox();
  const grip = await selected.waveform.getByText('Start',{exact:true}).boundingBox();
  if (!track || !grip) throw new Error('The waveform start handle did not render');
  const targetX = track.x + track.width * .32;
  await page.mouse.move(grip.x + grip.width / 2,grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetX,grip.y + grip.height / 2,{steps:5});
  await page.mouse.up();
  const frame = Number(await startHandle.inputValue());
  const decodedRate = Number(await startHandle.getAttribute('max')) / duration;
  expect(frame / decodedRate).toBeGreaterThan(.8);
  expect(frame / decodedRate).toBeLessThan(1.5);
  expect(Number(await selected.start.inputValue()) * decodedRate).toBeCloseTo(frame,6);
  await startHandle.press('ArrowRight');
  await expect(startHandle).toHaveValue(String(frame + 1));
  expect(Number(await selected.start.inputValue()) * decodedRate).toBeCloseTo(frame + 1,6);

  const revised = {startSeconds:.421875,endSeconds:2.8125,crossfadeSeconds:.06253125};
  await selected.start.fill(String(revised.startSeconds));
  await expect(startHandle).toHaveValue(String(Math.round(revised.startSeconds * decodedRate)));
  await selected.end.fill('4.125');
  await selected.apply.click();
  await expect(selected.details.getByRole('alert')).toContainText('within the recording');
  await expect(unsaved).not.toBeVisible();
  expect((await storedScene(page,scene.id)).layers[0]?.loop).toEqual(originalLoop);

  await selected.end.fill(String(revised.endSeconds));
  await selected.fade.fill(String(revised.crossfadeSeconds));
  await neighbor.summary.click();
  await expect(neighbor.waveform).toBeVisible();
  await expect(selected.waveform).not.toBeVisible();
  await selected.summary.click();
  await expect(neighbor.waveform).not.toBeVisible();
  await expect(selected.waveform).toBeVisible();
  await expect(selected.fade).toHaveValue(String(revised.crossfadeSeconds));
  await expect(unsaved).not.toBeVisible();

  await selected.apply.click();
  await expect(unsaved).toBeVisible();
  await page.getByRole('button',{name:'Save session',exact:true}).click();
  await expect(page.getByText(`Saved revision ${scene.revision + 1}`,{exact:true})).toBeVisible();
  expect((await storedScene(page,scene.id)).layers.map(layer=>layer.loop)).toEqual([revised,neighborLoop]);
  const copyRequested = page.waitForResponse(response=>response.request().method()==='POST' && new URL(response.url()).pathname==='/api/scenes');
  await page.getByRole('button',{name:'Save a copy',exact:true}).click();
  const copied = await copyRequested;
  expect(copied.status()).toBe(201);
  const copy = await copied.json() as Scene;
  expect(copy.id).not.toBe(scene.id);
  expect(copy.layers.map(layer=>layer.loop)).toEqual([revised,neighborLoop]);
  await openScene(page,copy);
  await selected.summary.click();
  await expect(selected.waveform).toBeVisible();
  await expect(selected.start).toHaveValue(String(revised.startSeconds));
  await expect(selected.end).toHaveValue(String(revised.endSeconds));
  await expect(selected.fade).toHaveValue(String(revised.crossfadeSeconds));

  for (const width of [1280,390,320]) {
    await page.setViewportSize({width,height:900});
    await selected.details.scrollIntoViewIfNeeded();
    const geometry = await selected.details.evaluate(details=>{
      const bounds = details.getBoundingClientRect();
      return {x:bounds.left,right:bounds.right,viewport:innerWidth,docWidth:document.documentElement.scrollWidth,
        width:details.clientWidth,scrollWidth:details.scrollWidth,
        controls:[...details.querySelectorAll('input,button')].map(control=>{
          const box = control.getBoundingClientRect();
          return {x:box.left,right:box.right,height:box.height};
        })};
    });
    expect(geometry.x).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.docWidth).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
    for (const control of geometry.controls) {
      expect(control.x).toBeGreaterThanOrEqual(geometry.x);
      expect(control.right).toBeLessThanOrEqual(geometry.right + 1);
      expect(control.height).toBeGreaterThanOrEqual(42);
    }
    await testInfo.attach('loop-editor-'+width,{body:await selected.details.screenshot(),contentType:'image/png'});
  }
});

interface SourceRecord {
  duration:number;
  loop:boolean;
  peak:number;
  startedAt:number;
  endedAt:number|null;
  stopCalls:number;
}

async function observeSourcePlayback(page:Page) {
  await page.addInitScript(()=>{
    const records:SourceRecord[] = [];
    Object.assign(window,{asmrLoopEditorSources:records});
    const create = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function() {
      const source = create.call(this);
      const start = source.start.bind(source);
      const stop = source.stop.bind(source);
      let record:SourceRecord|undefined;
      source.start = (...args:Parameters<AudioBufferSourceNode['start']>)=>{
        const data = source.buffer?.getChannelData(0);
        let peak = 0;
        if (data) for (let i = 0; i < data.length; i += 97) peak = Math.max(peak,Math.abs(data[i]!));
        record = {duration:source.buffer?.duration ?? 0,loop:source.loop,peak,
          startedAt:args[0] ?? source.context.currentTime,endedAt:null,stopCalls:0};
        records.push(record);
        start(...args);
      };
      source.stop = (...args:Parameters<AudioBufferSourceNode['stop']>)=>{
        if (record) record.stopCalls++;
        stop(...args);
      };
      source.addEventListener('ended',()=>{if (record) record.endedAt = source.context.currentTime;});
      return source;
    };
  });
}

async function joinSources(page:Page) {
  return page.evaluate(()=>(window as unknown as {asmrLoopEditorSources:SourceRecord[]}).asmrLoopEditorSources
    .filter(source=>!source.loop && source.duration === 2));
}

test('paused join audition is finite, exclusive with library preview and canceled by closing or starting the mix',async({page,baseURL},testInfo)=>{
  test.setTimeout(35_000);
  await observeSourcePlayback(page);
  const {scene,asset} = await seedScene(page,baseURL);
  await openScene(page,scene);
  const panel = loopPanel(page,'selected-loop');
  const transport = page.getByRole('region',{name:'Playback controls'});
  const start = transport.getByRole('button',{name:'Start listening'});
  const status = transport.getByRole('status');
  const library = page.getByRole('region',{name:'Sound library'});
  const libraryPreview = library.getByRole('button',{name:`Preview ${asset.displayName}`,exact:true});
  const previewElement = library.locator('audio');
  const waitForJoin = async(count:number)=>{
    await expect.poll(()=>joinSources(page)).toHaveLength(count);
    await expect(panel.details.getByRole('button',{name:'Stop preview',exact:true})).toBeVisible();
  };

  await panel.summary.click();
  await expect(panel.waveform).toBeVisible();
  await start.click();
  await expect(status).toHaveText('Playing');
  await expect(panel.preview).toBeDisabled();
  await expect(panel.details.getByText('Pause the mix to preview the join.')).toBeVisible();
  await transport.getByRole('button',{name:'Pause',exact:true}).click();
  await expect(status).toHaveText('Paused');
  const pausedAt = await transport.getByLabel('Elapsed time').innerText();
  await panel.start.fill('.5');
  await panel.end.fill('1.75');
  await panel.preview.click();
  await waitForJoin(1);
  await expect(panel.preview).toBeEnabled({timeout:5000});
  await expect.poll(async()=>(await joinSources(page))[0]?.endedAt).not.toBeNull();
  const natural = (await joinSources(page))[0]!;
  expect(natural.peak).toBeGreaterThan(.05);
  expect(natural.endedAt! - natural.startedAt).toBeGreaterThanOrEqual(1.98);
  expect(natural.endedAt! - natural.startedAt).toBeLessThan(2.25);
  await expect(transport.getByLabel('Elapsed time')).toHaveText(pausedAt);
  await expect(status).toHaveText('Paused');
  await expect(page.getByText('Unsaved changes',{exact:true})).not.toBeVisible();
  expect((await storedScene(page,scene.id)).layers[0]?.loop).toEqual(originalLoop);

  await libraryPreview.click();
  await expect.poll(()=>previewElement.evaluate((audio:HTMLAudioElement)=>audio.paused)).toBe(false);
  await panel.preview.click();
  await waitForJoin(2);
  await expect(libraryPreview).toBeEnabled();
  await expect.poll(()=>previewElement.evaluate((audio:HTMLAudioElement)=>[audio.paused,audio.getAttribute('src')])).toEqual([true,null]);
  await libraryPreview.click();
  await expect.poll(async()=>(await joinSources(page))[1]?.stopCalls).toBe(1);
  await expect(panel.preview).toBeEnabled();

  await panel.preview.click();
  await waitForJoin(3);
  await panel.summary.click();
  await expect(panel.waveform).not.toBeVisible();
  await expect.poll(async()=>(await joinSources(page))[2]?.stopCalls).toBe(1);
  await panel.summary.click();
  await expect(panel.waveform).toBeVisible();
  await panel.preview.click();
  await waitForJoin(4);
  await start.click();
  await expect(status).toHaveText('Playing');
  await expect.poll(async()=>(await joinSources(page))[3]?.stopCalls).toBe(1);
  await expect(panel.preview).toBeDisabled();
  const auditionEvidence = await joinSources(page);
  expect(auditionEvidence).toHaveLength(4);
  await testInfo.attach('join-preview-sources',{body:JSON.stringify(auditionEvidence,null,2),contentType:'application/json'});
});

test('an unavailable recording leaves exact numeric loop editing usable',async({page,baseURL})=>{
  const {scene,asset} = await seedScene(page,baseURL);
  await page.route(`**/api/assets/${encodeURIComponent(asset.id)}/content`,route=>route.fulfill({status:410,body:'Unavailable'}));
  await openScene(page,scene);
  const panel = loopPanel(page,'selected-loop');
  await panel.summary.click();
  await expect(panel.details.getByRole('status')).toContainText('Waveform unavailable');
  await expect(panel.waveform).not.toBeVisible();
  await expect(panel.preview).toBeDisabled();
  await expect(panel.start).toBeEditable();
  await expect(panel.end).toBeEditable();
  await expect(panel.fade).toBeEditable();
  await panel.start.fill('.31253125');
  await panel.apply.click();
  await expect(page.getByText('Unsaved changes',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Save session',exact:true}).click();
  await expect(page.getByText(`Saved revision ${scene.revision + 1}`,{exact:true})).toBeVisible();
  expect((await storedScene(page,scene.id)).layers[0]?.loop).toEqual({...originalLoop,startSeconds:.31253125});
});
