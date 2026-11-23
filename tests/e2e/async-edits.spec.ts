import { test, expect, type Page } from '@playwright/test';
import { wavFixture } from '../fixtures/audio.js';
import { openAudioImport } from './import-controls.js';

async function importAndAdd(page: Page, name: string) {
  await openAudioImport(page);
  await page.getByLabel('Audio file').setInputFiles([{
    name: name + '.wav', mimeType: 'audio/wav',
    buffer: Buffer.from(wavFixture({frames: 48000, channels: 2})),
  }]);
  await page.getByRole('checkbox', {name: /permission to listen privately/i}).check();
  await page.getByRole('button', {name: 'Import audio'}).click();
  await page.getByRole('button', {name: 'Add ' + name + '.wav as ambience'}).click();
}

async function observeRealAudio(page: Page) {
  // Instrument the actual native analyser; do not replace the engine or its signal.
  await page.addInitScript(() => {
    const decoding={completed:0};Object.assign(window,{asmrTestDecoding:decoding});
    const decode=AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData=function(audioData,successCallback,errorCallback){
      const result=decode.call(this,audioData,successCallback,errorCallback);
      void result.then(()=>{decoding.completed++;},()=>{});
      return result;
    };
    const original = AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser = function () {
      const meter = original.call(this);
      Object.assign(window, {asmrTestMeter: meter});
      return meter;
    };
  });
}
async function decodedCount(page:Page):Promise<number>{
  return page.evaluate(()=>(window as unknown as {asmrTestDecoding:{completed:number}}).asmrTestDecoding.completed);
}
function delayedDownload(){
  let release!:()=>void;let arrive!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const requested=new Promise<void>(resolve=>{arrive=resolve;});
  return {blocked,requested,release,arrive};
}
async function emptyStoppedPlayer(page:Page,id:string){
  await observeRealAudio(page);
  await page.goto('/?scene='+id);
  await importAndAdd(page,'Original-'+id);
  await page.getByRole('button',{name:'Start listening',exact:true}).click();
  await expect(page.getByRole('status').first()).toContainText('Playing');
  await expect.poll(()=>outputPeak(page)).toBeGreaterThan(0.0001);
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await page.getByRole('button',{name:'Remove Original-'+id+'.wav from mix',exact:true}).click();
  await expect(page.getByRole('button',{name:'Start listening',exact:true})).toBeDisabled();
  await expect.poll(()=>outputPeak(page)).toBeLessThan(0.000001);
}
async function outputPeak(page: Page) {
  return page.evaluate(() => {
    const meter = (window as unknown as {asmrTestMeter: AnalyserNode}).asmrTestMeter;
    const samples = new Float32Array(meter.fftSize);
    meter.getFloatTimeDomainData(samples);
    return Math.max(...Array.from(samples, sample => Math.abs(sample)));
  });
}

for (const phase of ['initial start', 'adding a layer'] as const) {
  test('master change during ' + phase + ' reaches the real audio graph', async ({page}) => {
    await observeRealAudio(page);
    await page.goto('/?scene=async-' + phase.replaceAll(' ', '-'));
    await importAndAdd(page, 'First-' + phase);
    if (phase === 'adding a layer') {
      await page.getByRole('button', {name: 'Start listening'}).click();
      await expect(page.getByRole('status').first()).toContainText('Playing');
      await expect.poll(() => outputPeak(page)).toBeGreaterThan(0.0001);
    }
    let release!: () => void;
    let arrived!: () => void;
    const blocked = new Promise<void>(resolve => {release = resolve;});
    const requested = new Promise<void>(resolve => {arrived = resolve;});
    await page.route('**/api/assets/*/content', async route => {
      arrived(); await blocked; await route.continue();
    });
    try {
      if (phase === 'initial start') await page.getByRole('button', {name: 'Start listening'}).click();
      else await importAndAdd(page, 'Second');
      await requested;
      await page.getByRole('slider', {name: 'Master volume'}).fill('0');
      release();
      await expect(page.getByRole('status').first()).toContainText('Playing');
      // A zero slider with a nonzero native output is the regression.
      await expect.poll(() => outputPeak(page)).toBeLessThan(0.000001);
      await page.getByRole('slider', {name: 'Master volume'}).fill('50');
      await expect.poll(() => outputPeak(page)).toBeGreaterThan(0.0001);
    } finally {release();}
  });
}

test('Save a copy preserves edits made while the server creates the copy', async ({page,baseURL}) => {
  const id = 'copy-concurrent-edits';
  await page.goto('/?scene=' + id);
  await page.getByRole('button', {name: 'Save session'}).click();
  await expect(page.getByText('Saved revision 1')).toBeVisible();
  const current = await (await page.request.get('/api/scenes/' + id)).json();
  const other = await page.request.put('/api/scenes/' + id, {
    headers: {origin: new URL(baseURL!).origin},
    data: {scene: {...current, masterGain: 0.35}, expectedRevision: 1},
  });
  expect(other.ok()).toBeTruthy();
  await page.getByRole('slider', {name: 'Master volume'}).fill('70');
  await page.getByRole('button', {name: 'Save session'}).click();
  await expect(page.getByText(/Another editor saved a newer revision/)).toBeVisible();
  let release!: () => void;
  let arrived!: () => void;
  const blocked = new Promise<void>(resolve => {release = resolve;});
  const requested = new Promise<void>(resolve => {arrived = resolve;});
  let creates = 0;
  await page.route('**/api/scenes', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    creates++; arrived(); await blocked; await route.continue();
  });
  try {
    await page.getByRole('button', {name: 'Save a copy'}).click();
    await requested;
    await page.getByRole('slider', {name: 'Master volume'}).fill('20');
    release();
    await expect(page).not.toHaveURL(new RegExp('scene=' + id + '$'));
    await expect(page.getByRole('slider', {name: 'Master volume'})).toHaveValue('20');
    await expect(page.getByText('Unsaved changes', {exact: true})).toBeVisible();
    await page.getByRole('button', {name: 'Save session'}).click();
    await expect(page.getByText('Saved revision 2')).toBeVisible();
    expect(creates).toBe(1);
    const copyId = new URL(page.url()).searchParams.get('scene');
    expect((await (await page.request.get('/api/scenes/' + copyId)).json()).masterGain).toBe(0.2);
    expect((await (await page.request.get('/api/scenes/' + id)).json()).masterGain).toBe(0.35);
  } finally {release();}
});


test('Stop cancels pending decoding without a late automatic restart', async ({page}) => {
  await observeRealAudio(page);
  await page.goto('/?scene=stop-pending-decode');
  await importAndAdd(page, 'Pending-stop');
  let release!: () => void;
  let arrived!: () => void;
  const blocked = new Promise<void>(resolve => {release = resolve;});
  const requested = new Promise<void>(resolve => {arrived = resolve;});
  await page.route('**/api/assets/*/content', async route => {
    arrived(); await blocked; await route.continue();
  });
  try {
    await page.getByRole('button', {name: 'Start listening'}).click();
    await requested;
    await expect(page.getByRole('button', {name: 'Stop', exact: true})).toBeEnabled();
    await page.getByRole('button', {name: 'Stop', exact: true}).click();
    const completed = page.waitForResponse('**/api/assets/*/content');
    release(); await (await completed).finished();
    await expect(page.getByRole('status').first()).not.toContainText('Playing');
    await expect.poll(() => outputPeak(page)).toBeLessThan(0.000001);
    await page.getByRole('button', {name: 'Start listening'}).click();
    await expect(page.getByRole('status').first()).toContainText('Playing');
    await expect.poll(() => outputPeak(page)).toBeGreaterThan(0.0001);
  } finally {release();}
});

test('Start waits for the latest replacement layers in an existing stopped player',async({page})=>{
  await emptyStoppedPlayer(page,'start-replacement');
  const gates=[delayedDownload(),delayedDownload()];let downloads=0;
  await page.route('**/api/assets/*/content',async route=>{
    const gate=gates[downloads++];
    if(gate){gate.arrive();await gate.blocked;}
    await route.continue();
  });
  try{
    await importAndAdd(page,'First replacement');await gates[0]!.requested;
    await page.getByRole('button',{name:'Start listening',exact:true}).click();
    await expect(page.getByRole('status').first()).toContainText('Loading audio');
    // A ready-state control notification must not discard the requested start.
    await page.getByRole('slider',{name:'Master volume',exact:true}).fill('40');
    await importAndAdd(page,'Latest replacement');
    gates[0]!.release();await gates[1]!.requested;
    await expect(page.getByRole('status').first()).toContainText('Loading audio');
    await expect.poll(()=>outputPeak(page)).toBeLessThan(0.000001);
    gates[1]!.release();
    await expect(page.getByRole('status').first()).toContainText('Playing');
    await expect.poll(()=>outputPeak(page)).toBeGreaterThan(0.0001);
    expect(downloads).toBe(2);
    await expect(page.getByRole('alert')).toHaveCount(0);
  }finally{gates.forEach(gate=>gate.release());}
});

test('removing a slow pending layer releases Start to play its ready replacement',async({page})=>{
  await emptyStoppedPlayer(page,'remove-slow-replacement');
  const gate=delayedDownload();let slowUrl:string|null=null;
  await page.route('**/api/assets/*/content',async route=>{
    slowUrl??=route.request().url();
    if(route.request().url()===slowUrl){gate.arrive();await gate.blocked;}
    await route.continue();
  });
  try{
    await importAndAdd(page,'Slow removed replacement');await gate.requested;
    await page.getByRole('button',{name:'Start listening',exact:true}).click();
    await expect(page.getByRole('status').first()).toContainText('Loading audio');
    await importAndAdd(page,'Ready replacement');
    await page.getByRole('button',{name:'Remove Slow removed replacement.wav from mix',exact:true}).click();
    // The first response is still blocked: only the current replacement may hold up Start.
    await expect(page.getByRole('status').first()).toContainText('Playing');
    await expect.poll(()=>outputPeak(page)).toBeGreaterThan(0.0001);
    expect(await decodedCount(page)).toBe(2);
    gate.release();await expect.poll(()=>decodedCount(page)).toBe(3);
    await expect(page.getByRole('status').first()).toContainText('Playing');
    await expect(page.getByRole('button',{name:'Add Slow removed replacement.wav as ambience',exact:true})).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  }finally{gate.release();}
});

for(const restart of [false,true]){
  test(restart?'a new Start after Stop supersedes the old request while a replacement decodes':'Stop cancels a requested start while a replacement decodes',async({page})=>{
    const id=restart?'restart-pending-replacement':'cancel-pending-replacement';
    await emptyStoppedPlayer(page,id);
    const gate=delayedDownload();
    await page.route('**/api/assets/*/content',async route=>{gate.arrive();await gate.blocked;await route.continue();});
    try{
      await importAndAdd(page,'Replacement-'+id);await gate.requested;
      await page.getByRole('button',{name:'Start listening',exact:true}).click();
      await expect(page.getByRole('status').first()).toContainText('Loading audio');
      await page.getByRole('button',{name:'Stop',exact:true}).click();
      await expect(page.getByRole('status').first()).toContainText('Ready');
      if(restart){
        await page.getByRole('button',{name:'Start listening',exact:true}).click();
        await expect(page.getByRole('status').first()).toContainText('Loading audio');
      }
      gate.release();
      // Wait for native decoding, not just the HTTP response, before checking for a late restart.
      await expect.poll(()=>decodedCount(page)).toBe(2);
      if(!restart){
        await expect(page.getByRole('status').first()).toContainText('Ready');
        await expect.poll(()=>outputPeak(page)).toBeLessThan(0.000001);
        await page.getByRole('button',{name:'Start listening',exact:true}).click();
      }
      await expect(page.getByRole('status').first()).toContainText('Playing');
      await expect.poll(()=>outputPeak(page)).toBeGreaterThan(0.0001);
      await expect(page.getByRole('alert')).toHaveCount(0);
    }finally{gate.release();}
  });
}

test('editing during a pending save cannot start another create request', async ({page}) => {
  await page.goto('/?scene=save-pending-edit');
  await expect(page.getByRole('button', {name: 'Save session'})).toBeEnabled();
  let release!: () => void;
  let arrived!: () => void;
  const blocked = new Promise<void>(resolve => {release = resolve;});
  const requested = new Promise<void>(resolve => {arrived = resolve;});
  let creates = 0;
  await page.route('**/api/scenes', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    creates++; arrived(); await blocked; await route.continue();
  });
  try {
    await page.getByRole('button', {name: 'Save session'}).click();
    await requested;
    await page.getByRole('slider', {name: 'Master volume'}).fill('20');
    await expect(page.getByRole('button', {name: 'Save session'})).toBeDisabled();
    release();
    await expect(page.getByText('Unsaved changes', {exact: true})).toBeVisible();
    await expect(page.getByRole('slider', {name: 'Master volume'})).toHaveValue('20');
    await page.getByRole('button', {name: 'Save session'}).click();
    await expect(page.getByText('Saved revision 2')).toBeVisible();
    expect(creates).toBe(1);
  } finally {release();}
});


test('editing waits until the selected saved scene finishes opening', async ({page,baseURL}) => {
  const id = 'slow-scene-open';
  const response = await page.request.post('/api/scenes', {
    headers: {origin: new URL(baseURL!).origin},
    data: {schemaVersion: 1, id, title: 'Existing scene', revision: 0,
      masterGain: 0.6, durationSeconds: null, layers: []},
  });
  expect(response.ok()).toBeTruthy();
  let release!: () => void;
  let arrived!: () => void;
  const blocked = new Promise<void>(resolve => {release = resolve;});
  const requested = new Promise<void>(resolve => {arrived = resolve;});
  await page.route('**/api/scenes/' + id, async route => {
    arrived(); await blocked; await route.continue();
  });
  try {
    await page.goto('/?scene=' + id);
    await requested;
    await expect(page.getByRole('slider', {name: 'Master volume'})).toBeDisabled();
    release();
    await expect(page.getByRole('slider', {name: 'Master volume'})).toHaveValue('60');
    await expect(page.getByRole('slider', {name: 'Master volume'})).toBeEnabled();
    await page.getByRole('slider', {name: 'Master volume'}).fill('20');
    await expect(page.getByText('Unsaved changes', {exact: true})).toBeVisible();
  } finally {release();}
});

test('non-ASCII recording names survive import and saved-library reload', async ({page}) => {
  await page.goto('/?scene=unicode-import');
  await importAndAdd(page, 'Fluffy ☁️');
  await expect(page.getByRole('region', {name: 'Active mix'})).toContainText('Fluffy ☁️.wav');
  await page.getByRole('button', {name: 'Save session'}).click();
  await expect(page.getByText('Saved revision 1')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', {name: 'Active mix'})).toContainText('Fluffy ☁️.wav');
});
