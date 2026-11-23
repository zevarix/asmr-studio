import {test,expect} from '@playwright/test';
import type {EqualizerSettings} from '@asmr-studio/contracts';
import {wavFixture} from '../fixtures/audio.js';
import {EXPORT_FIXTURE_RATE,exportToneFixture,samplePeak} from '../fixtures/export.js';
import {browserReference,compareExport,importAudio,importSignal,layer,saveScene} from '../fixtures/finished-export.js';

test.beforeEach(async({page}) => { await page.goto('/tests/harness/audio.html'); });

test('finished WAV matches mono equal-power and stereo pan matrices, gain, master, mute and solo',async({page},testInfo) => {
  const mono = await importSignal(page,'Export mono pan fixture',{frames:3840,channels:1,seed:1});
  const stereo = await importSignal(page,'Export stereo pan fixture',{frames:3840,channels:2,seed:2});
  const pans = [-1,-0.5,0,0.5,1];
  const layers = [mono,stereo].flatMap((asset,assetIndex) => pans.map((pan,index) => layer(asset.id,{
    id:`${assetIndex === 0 ? 'mono' : 'stereo'}-pan-${pan}`,pan,solo:true,gain:0.25 + index * 0.12,
    startSeconds:(assetIndex * pans.length + index) / 10,
  })));
  layers.push(
    layer(stereo.id,{id:'overlapping-layer',solo:true,gain:0.23,pan:-0.3,startSeconds:0.2}),
    layer(mono.id,{id:'muted-solo',solo:true,muted:true,gain:1,startSeconds:0.4}),
    layer(stereo.id,{id:'excluded-by-solo',solo:false,gain:1,startSeconds:0.4}),
    layer(stereo.id,{id:'zero-gain',solo:true,gain:0,startSeconds:0.4}),
  );
  const scene = await saveScene(page,'Pan and mix parity',layers,{masterGain:0.61,durationSeconds:null});
  const {actual} = await compareExport(page,testInfo,scene,1.04);
  // These isolated hard-pan windows must not leak into the opposite channel.
  for (const start of [0,0.5]) expect(samplePeak(actual.channelData[1]!,Math.round(start * EXPORT_FIXTURE_RATE),Math.round((start + 0.08) * EXPORT_FIXTURE_RATE))).toBe(0);
  for (const start of [0.4,0.9]) expect(samplePeak(actual.channelData[0]!,Math.round(start * EXPORT_FIXTURE_RATE),Math.round((start + 0.08) * EXPORT_FIXTURE_RATE))).toBe(0);
});

test('finished WAV matches loop intro, crossfade repeats, delayed start and final 20 ms fade',async({page},testInfo) => {
  const stereo = await importSignal(page,'Export crossfade loop fixture',{frames:8640,channels:2,seed:3});
  const mono = await importSignal(page,'Export direct loop fixture',{frames:4800,channels:1,seed:4});
  const scene = await saveScene(page,'Loop and fade parity',[
    layer(stereo.id,{id:'crossfaded',gain:0.6,pan:0.35,startSeconds:0.04,
      loop:{startSeconds:0.025,endSeconds:0.15,crossfadeSeconds:0.025}}),
    layer(mono.id,{id:'direct-loop',gain:0.22,pan:-0.4,
      loop:{startSeconds:0.0125,endSeconds:0.0625,crossfadeSeconds:0}}),
  ],{masterGain:0.7,durationSeconds:0.1});
  const {actual,reference} = await compareExport(page,testInfo,scene,0.64);
  // The requested length overrides the old saved horizon; it cannot cut at 0.1 s.
  for (const channels of [actual.channelData,reference.channelData]) {
    expect(samplePeak(channels[0]!,Math.round(0.2 * EXPORT_FIXTURE_RATE),Math.round(0.6 * EXPORT_FIXTURE_RATE))).toBeGreaterThan(0.01);
  }
});

test('finished WAV matches finite play-once endings, very short fades and exact silence padding',async({page},testInfo) => {
  const mono = await importSignal(page,'Export finite clip fixture',{frames:8640,channels:1,seed:5});
  const short = await importSignal(page,'Export ten millisecond fixture',{frames:480,channels:2,seed:6});
  const scene = await saveScene(page,'Finite clip and padding parity',[
    layer(mono.id,{id:'finite',gain:0.71,pan:-0.25,startSeconds:0.04}),
    layer(short.id,{id:'short-triangle',gain:0.49,pan:0.6,startSeconds:0.265}),
    layer(mono.id,{id:'starts-after-export',gain:1,startSeconds:0.45}),
  ],{masterGain:0.83,durationSeconds:0.08});
  const {actual,reference} = await compareExport(page,testInfo,scene,0.4);
  for (const channels of [actual.channelData,reference.channelData]) for (const samples of channels) {
    expect(samplePeak(samples,0,Math.round(0.04 * EXPORT_FIXTURE_RATE))).toBe(0);
    expect(samplePeak(samples,Math.round(0.28 * EXPORT_FIXTURE_RATE))).toBe(0);
  }
  expect(samplePeak(actual.channelData[0]!,Math.round(0.265 * EXPORT_FIXTURE_RATE),Math.round(0.275 * EXPORT_FIXTURE_RATE))).toBeGreaterThan(0.001);
});

test('finished WAV matches multiband layer and master EQ on delayed mono and looping stereo tones',async({page},testInfo) => {
  const frequencies=[80,1000,8000];
  const mono=await importAudio(page,'EQ mono tones',exportToneFixture({frames:48000,channels:1,frequencies}),1);
  const stereo=await importAudio(page,'EQ stereo tones',exportToneFixture({frames:28800,channels:2,frequencies,amplitude:0.02}),2);
  const scene=await saveScene(page,'Layer and master EQ parity',[
    layer(mono.id,{id:'equalized-finite-mono',gain:0.6,pan:-0.35,startSeconds:0.04,
      equalizer:{bassDb:6.25,midDb:-4.5,trebleDb:3.75,bypassed:false}}),
    layer(stereo.id,{id:'equalized-looping-stereo',gain:0.35,pan:0.55,startSeconds:0.2,
      loop:{startSeconds:0.025,endSeconds:0.25,crossfadeSeconds:0.025},
      equalizer:{bassDb:-4,midDb:7,trebleDb:-5,bypassed:false}}),
  ],{masterGain:0.7,durationSeconds:0.1,masterEqualizer:{bassDb:2,midDb:-3,trebleDb:4,bypassed:false}});
  const {actual,reference}=await compareExport(page,testInfo,scene,1.35);
  for(const channels of [actual.channelData,reference.channelData])for(const samples of channels){
    expect(samplePeak(samples,0,1920)).toBe(0);
    expect(samplePeak(samples,54000,60000),'Loop remains audible after the finite layer ends').toBeGreaterThan(0.001);
  }
});

test('finished WAV preserves flat and bypassed layer and master equalizers',async({page},testInfo) => {
  const mono=await importSignal(page,'Flat EQ mono fixture',{frames:8640,channels:1,seed:7});
  const stereo=await importSignal(page,'Bypassed EQ stereo fixture',{frames:4800,channels:2,seed:8});
  const flat:EqualizerSettings={bassDb:0,midDb:0,trebleDb:0,bypassed:false};
  const bypassed:EqualizerSettings={bassDb:12,midDb:-9,trebleDb:7,bypassed:true};
  for(const [name,masterEqualizer] of [['flat',flat],['bypassed',bypassed]] as const){
    const scene=await saveScene(page,`${name} EQ parity`,[
      layer(mono.id,{id:'flat-layer',gain:0.7,pan:-0.4,startSeconds:0.025,equalizer:flat}),
      layer(stereo.id,{id:'bypassed-layer',gain:0.4,pan:0.6,startSeconds:0.15,equalizer:bypassed}),
    ],{masterGain:0.6,durationSeconds:null,masterEqualizer});
    await compareExport(page,testInfo,scene,0.3);
  }
});

test('finished WAV preserves delayed finite layer and master EQ tails after the source envelope ends',async({page},testInfo) => {
  const asset=await importAudio(page,'Finite EQ tail fixture',wavFixture({frames:2400,channels:1,sampleRate:EXPORT_FIXTURE_RATE}),1);
  const settings:EqualizerSettings={bassDb:12,midDb:0,trebleDb:0,bypassed:false};
  for(const stage of ['layer','master'] as const){
    const scene=await saveScene(page,`${stage} finite EQ tail parity`,[
      layer(asset.id,{id:'finite-tail',gain:0.8,pan:0.2,startSeconds:0.025,...(stage==='layer'?{equalizer:settings}:{})}),
    ],{masterGain:0.7,durationSeconds:null,...(stage==='master'?{masterEqualizer:settings}:{})});
    const {actual,reference}=await compareExport(page,testInfo,scene,0.15);
    for(const channels of [actual.channelData,reference.channelData])for(const samples of channels){
      expect(samplePeak(samples,0,1200)).toBe(0);
      expect(samplePeak(samples,3600,3840),'Filter decay must survive the source ending at 75 ms').toBeGreaterThan(2/32768);
      expect(samplePeak(samples,5760),'Tail decays to PCM16 silence by 120 ms').toBeLessThanOrEqual(1/32768);
    }
  }
});

test('finished WAV matches stereo-linked limiting above full scale without delaying the finite ending',async({page},testInfo) => {
  const asset=await importAudio(page,'Stereo limiter ratio fixture',wavFixture({frames:4800,channels:2,sampleRate:EXPORT_FIXTURE_RATE}),2);
  const scene=await saveScene(page,'Stereo peak limiter parity',
    Array.from({length:32},(_,index)=>layer(asset.id,{id:`hot-layer-${index}`,gain:1})),
    {masterGain:1,durationSeconds:null,outputLimiter:{enabled:true,ceilingDb:-6}});
  const unlimited=await browserReference(page,{...scene,outputLimiter:{enabled:false,ceilingDb:-6}},.16);
  expect(samplePeak(unlimited.channelData[0]!)).toBeGreaterThan(1);
  const {actual,reference}=await compareExport(page,testInfo,scene,.16);
  for(const channels of [actual.channelData,reference.channelData]){
    expect(samplePeak(channels[0]!)).toBeCloseTo(.5011872336,4);
    expect(samplePeak(channels[1]!)).toBeCloseTo(.2505936168,4);
    for(const samples of channels)expect(samplePeak(samples,4800)).toBe(0);
    for(let frame=1200;frame<3500;frame+=73)expect(Math.abs(channels[0]![frame]!+2*channels[1]![frame]!)).toBeLessThanOrEqual(2/32768);
  }
});

test('finished WAV matches limiter attack and release after looping stereo layers and master EQ',async({page},testInfo) => {
  const asset=await importSignal(page,'Varying limiter fixture',{frames:14400,channels:2,seed:9});
  const scene=await saveScene(page,'Loop EQ and limiter parity',
    Array.from({length:6},(_,index)=>layer(asset.id,{id:`varying-layer-${index}`,gain:.8,pan:.2,
      startSeconds:index<3?0:.08,loop:{startSeconds:.025,endSeconds:.2,crossfadeSeconds:.025},
      equalizer:{bassDb:3,midDb:-2,trebleDb:4,bypassed:false}})),
    {masterGain:.9,durationSeconds:.1,masterEqualizer:{bassDb:2,midDb:3,trebleDb:-2,bypassed:false},outputLimiter:{enabled:true,ceilingDb:-3}});
  const {actual,reference}=await compareExport(page,testInfo,scene,.64);
  for(const channels of [actual.channelData,reference.channelData]){
    const peak=Math.max(...channels.map(samples=>samplePeak(samples)));
    expect(peak).toBeCloseTo(.7079457844,4);
    expect(peak).toBeLessThan(.708);
    expect(samplePeak(channels[0]!,24000,28000)).toBeGreaterThan(.05);
  }
});

test('finished WAV matches mono and stereo sway across delayed loop repetitions',async({page},testInfo) => {
  for(const channels of [1,2] as const){
    const asset=await importSignal(page,`${channels}-channel movement fixture`,{frames:12000,channels,seed:10+channels});
    const scene=await saveScene(page,`${channels}-channel delayed sway parity`,[
      layer(asset.id,{id:'moving-loop',gain:.6,pan:.2,startSeconds:.125,
        loop:{startSeconds:.025,endSeconds:.225,crossfadeSeconds:.025},
        movement:{enabled:true,width:.8,cycleSeconds:2}}),
    ],{masterGain:.8,durationSeconds:.5});
    const {actual,reference}=await compareExport(page,testInfo,scene,2.5);
    for(const channelData of [actual.channelData,reference.channelData]){
      for(const samples of channelData)expect(samplePeak(samples,0,6000)).toBe(0);
      expect(samplePeak(channelData[0]!,72000,96000),'The loop remains audible during the leftward part of the sway').toBeGreaterThan(.01);
    }
  }
});

test('finished WAV keeps finite EQ tails moving after a delayed source ends',async({page},testInfo) => {
  const asset=await importAudio(page,'Moving finite EQ tail fixture',wavFixture({frames:48000,channels:1,sampleRate:EXPORT_FIXTURE_RATE}),1);
  const scene=await saveScene(page,'Moving finite EQ tail parity',[
    layer(asset.id,{id:'moving-finite-tail',gain:.8,pan:-.1,startSeconds:.125,
      movement:{enabled:true,width:.8,cycleSeconds:2},
      equalizer:{bassDb:12,midDb:0,trebleDb:0,bypassed:false}}),
  ],{masterGain:.7,durationSeconds:null,masterEqualizer:{bassDb:0,midDb:3,trebleDb:0,bypassed:false}});
  const {actual,reference}=await compareExport(page,testInfo,scene,1.5);
  for(const channelData of [actual.channelData,reference.channelData])for(const samples of channelData){
    expect(samplePeak(samples,0,6000)).toBe(0);
    expect(samplePeak(samples,54000,54240),'The moving layer retains its EQ decay after 1.125 seconds').toBeGreaterThan(2/32768);
    expect(samplePeak(samples,62400),'The finite tail decays to PCM16 silence').toBeLessThanOrEqual(1/32768);
  }
});

test('finished WAV matches moving stereo layers through master EQ and limiting',async({page},testInfo) => {
  const asset=await importSignal(page,'Moving stereo limiter fixture',{frames:14400,channels:2,seed:13});
  const scene=await saveScene(page,'Sway EQ and limiter parity',
    Array.from({length:6},(_,index)=>layer(asset.id,{id:`moving-hot-layer-${index}`,gain:.8,pan:index%2===0?.2:-.2,
      startSeconds:index<3?.125:.375,loop:{startSeconds:.025,endSeconds:.2,crossfadeSeconds:.025},
      movement:{enabled:true,width:.7,cycleSeconds:index%2===0?2:2.75},
      equalizer:{bassDb:3,midDb:-2,trebleDb:4,bypassed:false}})),
    {masterGain:.9,durationSeconds:.5,masterEqualizer:{bassDb:2,midDb:3,trebleDb:-2,bypassed:false},outputLimiter:{enabled:true,ceilingDb:-3}});
  const unlimited=await browserReference(page,{...scene,outputLimiter:{enabled:false,ceilingDb:-3}},2.5);
  expect(Math.max(...unlimited.channelData.map(samples=>samplePeak(samples)))).toBeGreaterThan(.8);
  const {actual,reference}=await compareExport(page,testInfo,scene,2.5);
  for(const channelData of [actual.channelData,reference.channelData]){
    const peak=Math.max(...channelData.map(samples=>samplePeak(samples)));
    expect(peak).toBeCloseTo(.7079457844,4);expect(peak).toBeLessThan(.708);
    for(const samples of channelData)expect(samplePeak(samples,0,6000)).toBe(0);
    expect(samplePeak(channelData[0]!,108000,115200)).toBeGreaterThan(.01);
  }
});

test('finished WAV places listening fades on the export clock across delayed mono and stereo loop repetitions',async({page},testInfo)=>{
  const mono=await importSignal(page,'Listening mono loop fixture',{frames:4800,channels:1,seed:14});
  const stereo=await importSignal(page,'Listening stereo loop fixture',{frames:8640,channels:2,seed:15});
  const scene=await saveScene(page,'Listening loop fade parity',[
    layer(mono.id,{gain:.7,pan:-.35,loop:{startSeconds:.0125,endSeconds:.0875,crossfadeSeconds:0}}),
    layer(stereo.id,{gain:.6,pan:.4,startSeconds:.125,loop:{startSeconds:.025,endSeconds:.15,crossfadeSeconds:.025}}),
  ],{masterGain:.8,durationSeconds:.1,listeningTimer:{enabled:true,durationSeconds:.5,fadeInSeconds:.15,fadeOutSeconds:.25}});
  const {actual,reference}=await compareExport(page,testInfo,scene,1.25);
  for(const channels of [actual.channelData,reference.channelData]){
    expect(samplePeak(channels[0]!,28800,48000),'Export continues beyond the saved half-second timer').toBeGreaterThan(.01);
    expect(channels.map(samples=>samples[0])).toEqual([0,0]);
  }
});

test('finished WAV matches a three-frame triangular listening fade and its independent click-prevention envelope',async({page},testInfo)=>{
  const asset=await importAudio(page,'Short listening fade fixture',wavFixture({frames:4800,channels:2,sampleRate:EXPORT_FIXTURE_RATE}),2);
  const seconds=3/EXPORT_FIXTURE_RATE,fade=seconds/2;
  const scene=await saveScene(page,'Three-frame listening parity',[layer(asset.id,{gain:1})],
    {masterGain:1,durationSeconds:null,listeningTimer:{enabled:true,durationSeconds:1,fadeInSeconds:fade,fadeOutSeconds:fade}});
  const {actual}=await compareExport(page,testInfo,scene,seconds);
  expect(actual.frames).toBe(3);expect(actual.channelData.map(channel=>channel[0])).toEqual([0,0]);
});

test('finished WAV applies listening fades to finite moving EQ tails without prolonging the recording',async({page},testInfo)=>{
  const asset=await importAudio(page,'Listening finite tail fixture',wavFixture({frames:48000,channels:1,sampleRate:EXPORT_FIXTURE_RATE}),1);
  const scene=await saveScene(page,'Listening finite EQ tail parity',[
    layer(asset.id,{gain:.8,pan:-.1,startSeconds:.125,movement:{enabled:true,width:.8,cycleSeconds:2},
      equalizer:{bassDb:12,midDb:0,trebleDb:0,bypassed:false}}),
  ],{masterGain:.7,durationSeconds:null,masterEqualizer:{bassDb:0,midDb:3,trebleDb:0,bypassed:false},
    listeningTimer:{enabled:true,durationSeconds:5,fadeInSeconds:.1,fadeOutSeconds:.4}});
  const {actual,reference}=await compareExport(page,testInfo,scene,1.5);
  for(const channels of [actual.channelData,reference.channelData])for(const samples of channels){
    expect(samplePeak(samples,0,6000)).toBe(0);
    expect(samplePeak(samples,54000,54240),'The EQ decay survives the source ending during the master fade').toBeGreaterThan(2/32768);
    expect(samplePeak(samples,62400)).toBeLessThanOrEqual(1/32768);
  }
});

test('finished WAV matches post-limiter listening fades with moving stereo layers and master EQ',async({page},testInfo)=>{
  const asset=await importSignal(page,'Listening hot movement fixture',{frames:14400,channels:2,seed:16});
  const scene=await saveScene(page,'Listening movement EQ limiter parity',
    Array.from({length:6},(_,index)=>layer(asset.id,{id:`listening-hot-${index}`,gain:.8,pan:index%2===0?.2:-.2,
      startSeconds:index<3?.125:.375,loop:{startSeconds:.025,endSeconds:.2,crossfadeSeconds:.025},
      movement:{enabled:true,width:.7,cycleSeconds:index%2===0?2:2.75},
      equalizer:{bassDb:3,midDb:-2,trebleDb:4,bypassed:false}})),
    {masterGain:.9,durationSeconds:null,masterEqualizer:{bassDb:2,midDb:3,trebleDb:-2,bypassed:false},
      outputLimiter:{enabled:true,ceilingDb:-3},listeningTimer:{enabled:true,durationSeconds:4,fadeInSeconds:.5,fadeOutSeconds:.75}});
  const {actual,reference}=await compareExport(page,testInfo,scene,2.5);
  for(const channels of [actual.channelData,reference.channelData]){
    expect(Math.max(...channels.map(samples=>samplePeak(samples)))).toBeCloseTo(.7079457844,4);
    for(const samples of channels){expect(samplePeak(samples,0,6000)).toBe(0);expect(samplePeak(samples,119520)).toBeLessThan(.01);}
  }
});
