import {createHash,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {expect,type Page,type TestInfo} from '@playwright/test';
import {parseExportJob,parseScene,type AssetRecord,type EqualizerSettings,type ListeningTimerSettings,type OutputLimiterSettings,type Layer,type Scene} from '@asmr-studio/contracts';
import {decodePcm16Wav,exportSignalFixture,EXPORT_FIXTURE_RATE,pcm16ErrorMetrics,samplePeak} from './export.js';

// Allow PCM16 rounding plus small float-operation differences, never timing shifts.
const MAX_ERROR_PCM16 = 3;
const RMS_ERROR_PCM16 = 0.75;
// Current fixtures are at most 2.5 seconds. Cap failure PCM at 3 seconds:
// 1,152,000 browser bytes plus 576,000 native sample bytes and up to 4 KiB of RIFF headers.
const MAX_FAILURE_CAPTURE_FRAMES = 3 * EXPORT_FIXTURE_RATE;
const MAX_FAILURE_WAV_BYTES = MAX_FAILURE_CAPTURE_FRAMES * 4 + 4096;

export function layer(assetId:string,overrides:Partial<Layer>):Layer {
  return {id:randomUUID(),assetId,role:'texture',gain:0.5,pan:0,muted:false,solo:false,startSeconds:0,loop:null,...overrides};
}

export async function importAudio(page:Page,name:string,source:Uint8Array,channels:1|2):Promise<AssetRecord> {
  const bytes = Buffer.from(source);
  const response = await page.request.post('/api/assets',{
    headers:{
      origin:new URL(page.url()).origin,'content-type':'audio/wav',
      'x-asmr-metadata':JSON.stringify({displayName:name,roles:['texture'],
        provenance:{kind:'original',source:'Generated PCM16 signal for browser/export parity'},
        rights:{privateUse:'permitted',redistribution:'permitted'}}),
    },data:bytes,
  });
  expect(response.status(),await response.text()).toBe(201);
  const asset = await response.json() as AssetRecord;
  expect(asset.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(asset.sampleRate).toBe(EXPORT_FIXTURE_RATE);
  expect(asset.channels).toBe(channels);
  return asset;
}

export async function importSignal(page:Page,name:string,options:{frames:number;channels:1|2;seed:number}):Promise<AssetRecord> {
  return importAudio(page,name,exportSignalFixture(options),options.channels);
}

export async function saveScene(page:Page,title:string,layers:Layer[],options:{masterGain:number;durationSeconds:number|null;masterEqualizer?:EqualizerSettings;outputLimiter?:OutputLimiterSettings;listeningTimer?:ListeningTimerSettings}):Promise<Scene> {
  const scene:Scene = {schemaVersion:1,id:randomUUID(),title,revision:0,layers,...options};
  const response = await page.request.post('/api/scenes',{headers:{origin:new URL(page.url()).origin},data:scene});
  expect(response.status(),await response.text()).toBe(201);
  const saved = parseScene(await response.json());
  expect(saved.revision).toBe(1);
  return saved;
}

interface ReferenceOptions {
  assets:AssetRecord[];
  sampleRate?:number;
}

export async function browserReference(page:Page,scene:Scene,durationSeconds:number,options?:ReferenceOptions) {
  const reference = await page.evaluate(async({scene,durationSeconds,rate,assetDurations}) => {
    const modulePath = '/packages/audio-engine/src/engine.ts';
    const {createMixer} = await import(modulePath);
    const outputStagePath = '/packages/audio-engine/src/output-stage.ts';
    const outputWorkletPath = '/packages/audio-engine/src/output-worklet.ts?worker&url';
    const {createWorkletOutputStage} = await import(outputStagePath);
    const {default:outputModuleUrl} = await import(outputWorkletPath);
    const context = new OfflineAudioContext(2,Math.round(durationSeconds * rate),rate);
    const endpoint=context.length/context.sampleRate;
    const durations = new Map(assetDurations);
    let tick:(()=>void)|undefined;
    const mixer = createMixer({context,decodedBudgetBytes:16 * 1024 * 1024,
      ...(assetDurations ? {
        assetDurationSeconds:(id:string)=>durations.get(id),
        scheduleTick:(callback:()=>void)=>{tick=callback;return ()=>{tick=undefined;};},
      } : {}),
      createOutputStage:(owner:AudioContext)=>createWorkletOutputStage(owner,outputModuleUrl),loadAsset:async(id:string) => {
      const response = await fetch('/api/assets/' + encodeURIComponent(id) + '/content');
      if (!response.ok) throw new Error(`Reference audio fetch failed: ${response.status}`);
      return context.decodeAudioData(await response.arrayBuffer());
    }});
    try {
      // Export length is an explicit override, including a saved finite/disabled timer.
      // A disabled timer retains its saved controls, but exports use no long fades.
      const timer=scene.listeningTimer;
      await mixer.setScene(scene.transition?scene:{...scene,durationSeconds:endpoint,...(timer?{listeningTimer:{...timer,enabled:true,durationSeconds:endpoint,
        fadeInSeconds:timer.enabled?timer.fadeInSeconds:0,fadeOutSeconds:timer.enabled?timer.fadeOutSeconds:0}}:{})});
      await mixer.play();
      // Offline rendering outruns wall-clock callbacks. Advance the live scheduler
      // on the audio clock inside its one-second lookahead, including on slow CI.
      const checkpoints:Promise<void>[]=[];
      if (assetDurations) for(let at=.5;at<endpoint-128/rate;at+=.5) checkpoints.push(context.suspend(at));
      const rendering=context.startRendering();
      for(const checkpoint of checkpoints){await checkpoint;tick?.();await context.resume();}
      const output = await rendering;
      // Keep PCM binary across Playwright; expand to ordinary arrays on the host.
      return {sampleRate:output.sampleRate,frames:output.length,
        channelData:[output.getChannelData(0),output.getChannelData(1)]};
    } finally { mixer.dispose(); }
  },{scene,durationSeconds,rate:options?.sampleRate??EXPORT_FIXTURE_RATE,
    assetDurations:options?.assets.map(asset=>[asset.id,asset.durationSeconds] as const)});
  return {...reference,channelData:reference.channelData.map(channel=>Array.from(channel))};
}

export async function nativeExport(page:Page,scene:Scene,durationSeconds:number) {
  const requestId = randomUUID();
  const response = await page.request.post('/api/exports',{
    headers:{origin:new URL(page.url()).origin},
    data:{requestId,sceneId:scene.id,expectedRevision:scene.revision,durationSeconds},
  });
  expect(response.status(),await response.text()).toBe(202);
  let job = parseExportJob(await response.json());
  expect(job.id).toBe(requestId);
  await expect.poll(async() => {
    const status = await page.request.get('/api/exports/' + requestId);
    expect(status.status(),await status.text()).toBe(200);
    job = parseExportJob(await status.json());
    return job.status;
  },{timeout:15_000,intervals:[50,100,200,400],message:'Native FFmpeg export reaches a terminal state'})
    .toMatch(/^(complete|failed|cancelled|interrupted)$/);
  expect(job.status,JSON.stringify(job,null,2)).toBe('complete');
  expect(job.result).not.toBeNull();
  const download = await page.request.get('/api/exports/' + requestId + '/content');
  expect(download.status(),download.status() === 200 ? 'Completed WAV download' : await download.text()).toBe(200);
  expect(download.headers()['content-type']).toMatch(/^audio\/wav(?:;|$)/);
  const bytes = await download.body();
  expect(bytes.length).toBe(job.result!.bytes);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(job.result!.sha256);
  const canonical = await page.request.get('/api/scenes/' + scene.id);
  expect(canonical.status()).toBe(200);
  expect(parseScene(await canonical.json())).toEqual(scene);
  return {job,bytes};
}

export async function compareExport(page:Page,testInfo:TestInfo,scene:Scene,durationSeconds:number,options?:Pick<ReferenceOptions,'assets'>) {
  const reference = await browserReference(page,scene,durationSeconds,options);
  const {job,bytes} = await nativeExport(page,scene,durationSeconds);
  const actual = decodePcm16Wav(bytes);
  expect(actual.sampleRate).toBe(EXPORT_FIXTURE_RATE);
  expect(actual.channelData).toHaveLength(2);
  expect(actual.frames).toBe(Math.round(durationSeconds * EXPORT_FIXTURE_RATE));
  expect(actual.frames).toBe(reference.frames);
  expect(reference.sampleRate).toBe(EXPORT_FIXTURE_RATE);
  expect(Math.max(...reference.channelData.map(channel => samplePeak(channel))),'Reference fixture must contain audible signal').toBeGreaterThan(0.01);
  expect(Math.max(...reference.channelData.map(channel => samplePeak(channel))),'Fixtures must stay below clipping').toBeLessThan(0.9);
  const channels = actual.channelData.map((samples,index) => ({channel:index === 0 ? 'left' : 'right',
    ...pcm16ErrorMetrics(samples,reference.channelData[index]!)}));
  const failed=channels.some(channel=>channel.maxErrorPcm16>MAX_ERROR_PCM16||channel.rmsErrorPcm16>RMS_ERROR_PCM16);
  const capturePcm=failed&&reference.frames<=MAX_FAILURE_CAPTURE_FRAMES&&bytes.length<=MAX_FAILURE_WAV_BYTES;
  const report = {sceneId:scene.id,jobId:job.id,durationSeconds,frames:actual.frames,sampleRate:actual.sampleRate,
    thresholds:{maxErrorPcm16:MAX_ERROR_PCM16,rmsErrorPcm16:RMS_ERROR_PCM16},channels,
    failurePcmCapture:failed?{attached:capturePcm,maxFrames:MAX_FAILURE_CAPTURE_FRAMES,maxNativeBytes:MAX_FAILURE_WAV_BYTES}:null};
  await testInfo.attach('export-sample-parity',{body:Buffer.from(JSON.stringify(report,null,2)),contentType:'application/json'});
  if(capturePcm){
    // Preserve the actual pair before the strict assertion fails, within the explicit byte limits.
    const referencePcm=Buffer.alloc(reference.frames*2*4);
    for(let frame=0;frame<reference.frames;frame++)for(let channel=0;channel<2;channel++){
      referencePcm.writeFloatLE(reference.channelData[channel]![frame]!,(frame*2+channel)*4);
    }
    const nativePath=testInfo.outputPath(`${scene.id}-native.wav`),referencePath=testInfo.outputPath(`${scene.id}-browser.f32le`);
    await writeFile(nativePath,bytes);await writeFile(referencePath,referencePcm);
    await testInfo.attach('failed-export-native',{path:nativePath,contentType:'audio/wav'});
    await testInfo.attach('failed-export-browser',{path:referencePath,contentType:'application/octet-stream'});
    await testInfo.attach('failed-export-scene',{body:Buffer.from(JSON.stringify({scene,durationSeconds,
      reference:{sampleRate:reference.sampleRate,frames:reference.frames,channels:2,encoding:'IEEE-754 float32 little-endian',layout:'interleaved left,right',sha256:createHash('sha256').update(referencePcm).digest('hex')},
      native:{sha256:createHash('sha256').update(bytes).digest('hex')}},null,2)),contentType:'application/json'});
  }
  console.info(`${scene.title}: ${channels.map(channel => `${channel.channel} max=${channel.maxErrorPcm16.toFixed(4)} RMS=${channel.rmsErrorPcm16.toFixed(4)} PCM16 quanta`).join('; ')}`);
  for (const channel of channels) {
    const diagnostic = JSON.stringify(channel,null,2);
    expect(channel.maxErrorPcm16,diagnostic).toBeLessThanOrEqual(MAX_ERROR_PCM16);
    expect(channel.rmsErrorPcm16,diagnostic).toBeLessThanOrEqual(RMS_ERROR_PCM16);
  }
  return {actual,reference};
}
