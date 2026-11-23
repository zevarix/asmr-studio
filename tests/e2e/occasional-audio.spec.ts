import {createHash} from 'node:crypto';
import {expect,test,type Page} from '@playwright/test';
import type {OccasionalSettings} from '@asmr-studio/contracts';
import {decodePcm16Wav,EXPORT_FIXTURE_RATE as rate,samplePeak} from '../fixtures/export.js';
import {browserReference,compareExport,importSignal,layer,nativeExport,saveScene} from '../fixtures/finished-export.js';

const endpoint=2.36;
const spans=[[6000,24000],[39678,51678],[70926,88926],[109248,121248]] as const;

async function sources(page:Page){
  const mono=await importSignal(page,'Occasional mono',{channels:1,frames:12000,seed:38});
  const stereo=await importSignal(page,'Occasional stereo',{channels:2,frames:18000,seed:42});
  const occasional:OccasionalSettings={enabled:true,minPauseSeconds:.25,maxPauseSeconds:.5,seed:123,
    alternateAssetIds:[stereo.id],levelVariation:.18,panVariation:.2};
  return {assets:[mono,stereo],voice:layer(mono.id,{startSeconds:.125,gain:.72,pan:.21,occasional})};
}

function fingerprint(channels:readonly (readonly number[]|Float32Array)[]){
  const hash=createHash('sha256');
  for(const channel of channels)hash.update(Buffer.from(Float32Array.from(channel).buffer));
  return hash.digest('hex');
}

test.beforeEach(async({page})=>{await page.goto('/tests/harness/audio.html');});

test('saved seed reproduces native occasional clips, pauses and a truncated ending',async({page},testInfo)=>{
  const {assets,voice}=await sources(page);
  const scene=await saveScene(page,'Seeded occasional clips',[voice],{masterGain:.8,durationSeconds:null});
  const {actual,reference}=await compareExport(page,testInfo,scene,endpoint,{assets});
  // Seed 123 plays stereo, mono, stereo, mono. Check both sides of each gap
  // independently of the scheduler and leave the final mono clip cut mid-event.
  for(const channels of [reference.channelData,actual.channelData]){
    for(const channel of channels){
      let previousEnd=0;
      for(const [start,end] of spans){
        expect(samplePeak(channel,previousEnd,start)).toBe(0);
        expect(samplePeak(channel,start+rate*.02,Math.min(start+rate*.05,end))).toBeGreaterThan(.01);
        previousEnd=end;
      }
      expect(Math.abs(channel.at(-1)!)).toBeLessThan(.0003);
    }
  }
  const repeated=await browserReference(page,scene,endpoint,{assets});
  expect(fingerprint(repeated.channelData)).toBe(fingerprint(reference.channelData));
  const exportAgain=await nativeExport(page,scene,endpoint);
  expect(fingerprint(decodePcm16Wav(exportAgain.bytes).channelData)).toBe(fingerprint(actual.channelData));
  const changed=await saveScene(page,'Different saved seed',[{...voice,occasional:{...voice.occasional!,seed:124}}],
    {masterGain:.8,durationSeconds:null});
  const next=await browserReference(page,changed,endpoint,{assets});
  expect(fingerprint(next.channelData)).not.toBe(fingerprint(reference.channelData));
});

test('native occasional clips retain the same timeline at 44.1 kHz',async({page})=>{
  const {assets,voice}=await sources(page);
  const scene=await saveScene(page,'Device-rate occasional timing',[voice],{masterGain:.8,durationSeconds:null});
  const output=await browserReference(page,scene,endpoint,{assets,sampleRate:44100});
  const signal=output.channelData[0]!;
  let previousEnd=0;
  for(const [start,end] of spans){
    const first=Math.round(start/rate*output.sampleRate);
    expect(samplePeak(signal,previousEnd,first-2)).toBe(0);
    expect(samplePeak(signal,first+2,first+48)).toBeGreaterThan(.00001);
    previousEnd=Math.ceil(end/rate*output.sampleRate)+2;
  }
});

test('WAV and native occasional clips agree through layer EQ, movement and listening fades',async({page},testInfo)=>{
  const {assets,voice}=await sources(page);
  const scene=await saveScene(page,'Occasional movement EQ and listening timer',[
    {...voice,movement:{enabled:true,width:.38,cycleSeconds:2.25},equalizer:{bypassed:false,bassDb:3,midDb:-2,trebleDb:1.5}},
  ],{masterGain:.65,durationSeconds:null,listeningTimer:{enabled:true,durationSeconds:5,fadeInSeconds:.25,fadeOutSeconds:.16}});
  const {actual}=await compareExport(page,testInfo,scene,endpoint,{assets});
  for(const channel of actual.channelData){
    expect(samplePeak(channel,rate*.6,rate*.75)).toBe(0);
    const plateau=samplePeak(channel,Math.round(rate*2.30),Math.round(rate*2.32));
    expect(plateau).toBeGreaterThan(.002);
    expect(samplePeak(channel,channel.length-48)).toBeLessThan(plateau*.05);
  }
});

test('disabling occasional sounds restores the original play-once or loop output exactly',async({page})=>{
  const {assets,voice}=await sources(page);
  const {occasional,...plain}=voice;
  for(const loop of [null,{startSeconds:.05,endSeconds:.2,crossfadeSeconds:.02}]){
    const baseline=await saveScene(page,'Original playback',[{...plain,loop}],{masterGain:.8,durationSeconds:null});
    const disabled={...baseline,layers:[{...plain,loop,occasional:{...occasional!,enabled:false}}]};
    const expected=await browserReference(page,baseline,.9,{assets});
    const restored=await browserReference(page,disabled,.9,{assets});
    expect(fingerprint(restored.channelData)).toBe(fingerprint(expected.channelData));
    const tail=samplePeak(restored.channelData[0]!,Math.round(.6*rate));
    if(loop)expect(tail).toBeGreaterThan(.01);else expect(tail).toBe(0);
  }
});
