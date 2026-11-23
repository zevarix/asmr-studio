import {test,expect,type Page} from '@playwright/test';

type Timer={enabled:boolean;durationSeconds:number;fadeInSeconds:number;fadeOutSeconds:number};
type Operation={at:number;action:'pause'|'play'|'stop-play'|'timer';timer?:Timer};
type Settings={timer?:Timer;duration?:number;start?:number;assetDuration?:number;legacyDuration?:number;operations?:Operation[];withoutHold?:boolean};
const rate=48000;
const timing:Timer={enabled:true,durationSeconds:.4,fadeInSeconds:.1,fadeOutSeconds:.1};
async function render(page:Page,settings:Settings){
  return page.evaluate(async settings=>{
    const modulePath='/packages/audio-engine/src/engine.ts';const {createMixer}=await import(modulePath);
    const rate=48000,frames=Math.round((settings.duration??.8)*rate),context=new OfflineAudioContext(2,frames,rate);
    const buffer=context.createBuffer(2,Math.round((settings.assetDuration??1)*rate),rate);buffer.getChannelData(0).fill(.25);buffer.getChannelData(1).fill(.125);
    let sourceCount=0;const createSource=context.createBufferSource.bind(context),createGain=context.createGain.bind(context);
    context.createBufferSource=()=>{sourceCount++;return createSource();};
    context.createGain=()=>{const gain=createGain();if(settings.withoutHold)Object.defineProperty(gain.gain,'cancelAndHoldAtTime',{value:undefined});return gain;};
    const scene={schemaVersion:1,id:'timer',title:'Timer fixture',revision:0,masterGain:1,durationSeconds:settings.legacyDuration??null,
      ...(settings.timer?{listeningTimer:settings.timer}:{}),layers:[{id:'one',assetId:'fixture',role:'texture',gain:1,pan:0,muted:false,solo:false,startSeconds:settings.start??0,loop:null}]};
    const mixer=createMixer({context,loadAsset:async()=>buffer,decodedBudgetBytes:2*1024*1024});
    await mixer.setScene(scene);await mixer.play();
    const suspended=(settings.operations??[]).map(operation=>({operation,ready:context.suspend(operation.at)}));
    const times:number[]=[];const rendering=context.startRendering();
    for(const {operation,ready} of suspended){
      await ready;times.push(context.currentTime);
      if(operation.action==='pause')mixer.pause();else if(operation.action==='play')await mixer.play();
      else if(operation.action==='stop-play'){mixer.stop();await mixer.play();}
      else mixer.apply({type:'setListeningTimer',timer:operation.timer!});
      await context.resume();
    }
    const output=await rendering;const left=Array.from(output.getChannelData(0)),right=Array.from(output.getChannelData(1));mixer.dispose();
    return {left,right,times,sourceCount};
  },settings);
}
function clickEnvelope(time:number,start:number,end:number){const fade=Math.min(.02,(end-start)/2);return Math.max(0,Math.min(1,(time-start)/fade,(end-time)/fade));}
function longEnvelope(time:number,timer:Timer):number {
  if(!timer.enabled)return 1;if(time>=timer.durationSeconds)return 0;
  if(timer.fadeInSeconds>0&&time<timer.fadeInSeconds)return Math.max(0,time/timer.fadeInSeconds);
  if(timer.fadeOutSeconds>0&&time>timer.durationSeconds-timer.fadeOutSeconds)return (timer.durationSeconds-time)/timer.fadeOutSeconds;
  return 1;
}
function expectSignal(output:{left:number[];right:number[]},expected:(time:number)=>number){
  expect(Math.max(...output.left.map((value,i)=>Math.abs(value-expected(i/rate))))).toBeLessThan(2e-6);
  expect(Math.max(...output.right.map((value,i)=>Math.abs(value-expected(i/rate)/2)))).toBeLessThan(2e-6);
}
test.beforeEach(async({page})=>{await page.goto('/tests/harness/audio.html');});

test('native timer fades and exact ending follow the audio clock without UI callbacks',async({page})=>{
  for(const timer of [timing,{...timing,fadeInSeconds:0,fadeOutSeconds:0},{...timing,fadeInSeconds:.2,fadeOutSeconds:.2},
    {...timing,fadeInSeconds:.4,fadeOutSeconds:0},{...timing,fadeInSeconds:0,fadeOutSeconds:.4},
    {enabled:true,durationSeconds:.01,fadeInSeconds:.004,fadeOutSeconds:.006}]){
    const output=await render(page,{timer});
    expectSignal(output,time=>.25*clickEnvelope(time,0,timer.durationSeconds)*longEnvelope(time,timer));
    expect(output.left.slice(Math.ceil(timer.durationSeconds*rate)).every(value=>value===0)).toBe(true);expect(output.sourceCount).toBe(1);
  }
});

test('absent and disabled timers retain exact static audio and disabled settings override a legacy deadline',async({page})=>{
  const absent=await render(page,{}),disabled=await render(page,{timer:{...timing,enabled:false},legacyDuration:.2});
  expect(disabled.left).toEqual(absent.left);expect(disabled.right).toEqual(absent.right);
  const legacy=await render(page,{legacyDuration:.2});expect(legacy.left.slice(.2*rate).every(value=>value===0)).toBe(true);
});

test('native pause freezes the listening fade and resume continues its remaining curve',async({page})=>{
  const output=await render(page,{timer:timing,operations:[{at:.05,action:'pause'},{at:.16,action:'play'}]});
  const [paused,resumed]=output.times as [number,number];const finish=resumed+timing.durationSeconds-paused;
  expectSignal(output,time=>{
    if(time<paused)return .25*clickEnvelope(time,0,timing.durationSeconds)*longEnvelope(time,timing);
    if(time<resumed)return .25*Math.max(0,1-(time-paused)/.02)*longEnvelope(paused,timing);
    return .25*clickEnvelope(time,resumed,finish)*longEnvelope(paused+time-resumed,timing);
  });
  expect(output.left.slice(Math.ceil(finish*rate)).every(value=>value===0)).toBe(true);expect(output.sourceCount).toBe(2);
});

for(const withoutHold of [false,true])test(`rapid fresh timer restarts remain bounded and smooth (native hold: ${!withoutHold})`,async({page})=>{
  const timer={...timing,durationSeconds:.3,fadeInSeconds:.1,fadeOutSeconds:.1};
  const output=await render(page,{timer,withoutHold,operations:[{at:.08,action:'stop-play'},{at:.085,action:'stop-play'},{at:.09,action:'stop-play'}]});
  expect(Math.max(...output.left.map(Math.abs))).toBeLessThanOrEqual(.250001);
  expect(Math.max(...output.left.slice(1).map((value,i)=>Math.abs(value-output.left[i]!)))).toBeLessThan(.001);
  const last=output.times.at(-1)!;
  const start=Math.ceil((last+.021)*rate);
  expect(Math.max(...output.left.slice(start).map((value,index)=>Math.abs(value-.25*clickEnvelope((start+index)/rate,last,last+timer.durationSeconds)*longEnvelope((start+index)/rate-last,timer))))).toBeLessThan(2e-6);
  expect(output.sourceCount).toBe(4);
});

test('native timer extension replaces the old source ending without resetting elapsed recording position',async({page})=>{
  const timer={enabled:true,durationSeconds:.2,fadeInSeconds:0,fadeOutSeconds:0};
  const output=await render(page,{timer,operations:[{at:.12,action:'timer',timer:{...timer,durationSeconds:.4}}]});
  expectSignal(output,time=>.25*clickEnvelope(time,0,.4));expect(output.sourceCount).toBe(2);
});

test('editing a timer past its elapsed time makes a short release then permanent silence',async({page})=>{
  const timer={enabled:true,durationSeconds:.4,fadeInSeconds:0,fadeOutSeconds:0};
  const output=await render(page,{timer,operations:[{at:.18,action:'timer',timer:{...timer,durationSeconds:.1}}]});const at=output.times[0]!;
  expectSignal(output,time=>time<at?.25*clickEnvelope(time,0,.4):.25*Math.max(0,1-(time-at)/.02)**2);
  expect(output.left.slice(Math.ceil((at+.02)*rate)).every(value=>value===0)).toBe(true);
});

test('finite and delayed recordings still obey their own lifetimes inside a listening timer',async({page})=>{
  const finite=await render(page,{timer:timing,assetDuration:.15,start:.05});
  expectSignal(finite,time=>.25*clickEnvelope(time,.05,.2)*longEnvelope(time,timing));
  const late=await render(page,{timer:timing,start:.5});expect(late.left.every(value=>value===0)).toBe(true);expect(late.sourceCount).toBe(0);
});
