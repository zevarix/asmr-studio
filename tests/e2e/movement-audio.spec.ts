import {test,expect,type Page} from '@playwright/test';

type Movement={enabled:boolean;width:number;cycleSeconds:number};
type Operation={at:number;action:'pause'|'play'|'stop-play'|'movement'|'pan';movement?:Movement;pan?:number};
type Settings={movement?:Movement;pan?:number;start?:number;duration?:number;operations?:Operation[];collectPcm?:boolean;withoutHold?:boolean};
const sway:Movement={enabled:true,width:.4,cycleSeconds:2};
const rate=48000;

/** Recover actual native panner positions from a constant mono signal, independent of controller internals. */
async function render(page:Page,settings:Settings){
  return page.evaluate(async settings=>{
    const modulePath='/packages/audio-engine/src/engine.ts';const {createMixer}=await import(modulePath);
    const rate=48000,length=Math.round((settings.duration??2.2)*rate);
    const context=new OfflineAudioContext(2,length,rate);
    const buffer=context.createBuffer(1,length+rate,rate);buffer.getChannelData(0).fill(.2);
    let sourceCount=0,oscillatorCount=0;
    const createSource=context.createBufferSource.bind(context),createOscillator=context.createOscillator.bind(context);
    const removeHold=(param:AudioParam)=>{if(settings.withoutHold)Object.defineProperty(param,'cancelAndHoldAtTime',{value:undefined});};
    const createGain=context.createGain.bind(context),createPanner=context.createStereoPanner.bind(context);
    context.createGain=()=>{const node=createGain();removeHold(node.gain);return node;};
    context.createStereoPanner=()=>{const node=createPanner();removeHold(node.pan);return node;};
    context.createBufferSource=()=>{sourceCount++;return createSource();};
    context.createOscillator=()=>{oscillatorCount++;const node=createOscillator();removeHold(node.frequency);return node;};
    const scene={schemaVersion:1,id:'movement',title:'Movement fixture',revision:0,masterGain:1,durationSeconds:null,
      layers:[{id:'one',assetId:'fixture',role:'texture',gain:1,pan:settings.pan??0,muted:false,solo:false,
        startSeconds:settings.start??0,loop:null,...(settings.movement?{movement:settings.movement}:{})}]};
    const mixer=createMixer({context,loadAsset:async()=>buffer,decodedBudgetBytes:4*1024*1024});
    await mixer.setScene(scene);await mixer.play();
    const suspensions=(settings.operations??[]).map(operation=>({operation,paused:context.suspend(operation.at)}));
    const times:number[]=[];const rendering=context.startRendering();
    for(const {operation,paused} of suspensions){
      await paused;times.push(context.currentTime);
      switch(operation.action){
        case 'pause':mixer.pause();break;
        case 'play':await mixer.play();break;
        case 'stop-play':mixer.stop();await mixer.play();break;
        case 'movement':mixer.apply({type:'setLayerMovement',layerId:'one',movement:operation.movement!});break;
        case 'pan':mixer.apply({type:'setLayerPan',layerId:'one',pan:operation.pan!});break;
      }
      await context.resume();
    }
    const output=await rendering;const left=output.getChannelData(0),right=output.getChannelData(1);
    const samples:Array<{time:number;pan:number;level:number}>=[];
    let minimumPan=Infinity,maximumPan=-Infinity,maximumPanStep=0,previousPan:number|null=null,maximumLevelError=0;
    let firstNonzeroSeconds:number|null=null;
    for(let i=0;i<length;i++){
      const level=Math.hypot(left[i]!,right[i]!);
      if(i/rate>.03)maximumLevelError=Math.max(maximumLevelError,Math.abs(level-.2));
      const pan=level>1e-6?4/Math.PI*Math.atan2(right[i]!,left[i]!)-1:0;
      if(level>1e-6){
        firstNonzeroSeconds??=i/rate;minimumPan=Math.min(minimumPan,pan);maximumPan=Math.max(maximumPan,pan);
        if(previousPan!==null)maximumPanStep=Math.max(maximumPanStep,Math.abs(pan-previousPan));previousPan=pan;
      }else previousPan=null;
      if(i%32===0)samples.push({time:i/rate,pan,level});
    }
    mixer.dispose();
    return {samples,times,sourceCount,oscillatorCount,minimumPan,maximumPan,maximumPanStep,maximumLevelError,firstNonzeroSeconds,
      pcm:settings.collectPcm?[Array.from(left),Array.from(right)]:null};
  },settings);
}

function assertTrajectory(output:Awaited<ReturnType<typeof render>>,expected:(time:number)=>number){
  let error=0,count=0;
  for(const sample of output.samples)if(sample.level>1e-5){error=Math.max(error,Math.abs(sample.pan-expected(sample.time)));count++;}
  expect(count).toBeGreaterThan(30);expect(error).toBeLessThan(2e-5);
}
const f=Math.fround;
test.beforeEach(async({page})=>{await page.goto('/tests/harness/audio.html');});

test('native movement follows the layer audio clock, including delayed starts and a fractional cycle',async({page})=>{
  const settings={enabled:true,width:.7,cycleSeconds:2.25};
  const output=await render(page,{movement:settings,pan:.6,start:.125,duration:2.5});
  const center=f(.6),radius=f(1-Math.abs(center)),frequency=f(1/2.25);
  assertTrajectory(output,time=>center+radius*Math.sin(2*Math.PI*frequency*(time-.125)));
  expect(output.firstNonzeroSeconds).toBeGreaterThanOrEqual(.125);expect(output.firstNonzeroSeconds).toBeLessThan(.125+2/rate);
  expect(output.minimumPan).toBeGreaterThanOrEqual(center-radius-2e-5);expect(output.maximumPan).toBeLessThanOrEqual(1);
  expect(output.sourceCount).toBe(1);expect(output.oscillatorCount).toBe(2);
});

test('absent, disabled, and zero-width movement retain exactly the same static audio',async({page})=>{
  const baseline=await render(page,{pan:-.25,duration:.1,collectPcm:true});
  for(const movement of [{...sway,enabled:false},{...sway,width:0}]){
    const output=await render(page,{movement,pan:-.25,duration:.1,collectPcm:true});
    expect(output.pcm).toEqual(baseline.pcm);expect(output.oscillatorCount).toBe(0);
  }
  expect(baseline.oscillatorCount).toBe(0);
  const edge=await render(page,{movement:sway,pan:-1,duration:.1,collectPcm:true});
  expect(edge.oscillatorCount).toBe(0);expect(edge.pcm![1]!.every(value=>value===0)).toBe(true);
});

test('pause holds native movement through its release and resume continues the saved phase',async({page})=>{
  const output=await render(page,{movement:sway,operations:[{at:.4,action:'pause'},{at:1.4,action:'play'}]});
  const [paused,resumed]=output.times as [number,number];
  assertTrajectory(output,time=>f(.4)*Math.sin(Math.PI*(time<paused?time:time<resumed?paused:paused+time-resumed)));
  expect(output.samples.filter(sample=>sample.time>paused+.021&&sample.time<resumed).every(sample=>sample.level===0)).toBe(true);
  expect(output.sourceCount).toBe(2);expect(output.oscillatorCount).toBe(2);
});

test('pause before a delayed layer starts retains its remaining delay on resume',async({page})=>{
  const output=await render(page,{movement:sway,start:.5,operations:[{at:.2,action:'pause'},{at:.7,action:'play'}]});
  const [paused,resumed]=output.times as [number,number];const start=resumed+.5-paused;
  expect(output.firstNonzeroSeconds).toBeGreaterThanOrEqual(start-1/rate);expect(output.firstNonzeroSeconds).toBeLessThan(start+2/rate);
  assertTrajectory(output,time=>f(.4)*Math.sin(Math.PI*(time-start)));
  expect(output.oscillatorCount).toBe(2);
});

for(const withoutHold of [false,true])test(`rapid Stop/Play blends old/new trajectories without pan or level steps (native hold: ${!withoutHold})`,async({page})=>{
  const output=await render(page,{movement:sway,duration:1.2,withoutHold,
    operations:[{at:.5,action:'stop-play'},{at:.505,action:'stop-play'},{at:.51,action:'stop-play'}]});
  const last=output.times.at(-1)!;
  expect(output.minimumPan).toBeGreaterThanOrEqual(-f(.4)-2e-5);expect(output.maximumPan).toBeLessThanOrEqual(f(.4)+2e-5);
  expect(output.maximumPanStep).toBeLessThan(.001);
  expect(output.maximumLevelError).toBeLessThan(2e-6);
  assertTrajectory({...output,samples:output.samples.filter(sample=>sample.time>last+.021)},time=>f(.4)*Math.sin(Math.PI*(time-last)));
  expect(output.sourceCount).toBe(4);expect(output.oscillatorCount).toBe(2);
});

test('native cycle, bypass, center, and width edits preserve the source and continuous bounded movement',async({page})=>{
  const output=await render(page,{movement:{...sway,cycleSeconds:4},duration:1.8,operations:[
    {at:.5,action:'movement',movement:sway},{at:.8,action:'movement',movement:{...sway,enabled:false}},
    {at:1,action:'movement',movement:sway},{at:1.2,action:'pan',pan:.9},
    {at:1.205,action:'movement',movement:{...sway,width:1}},
  ]});
  const [speed,off,on,pan]=output.times as [number,number,number,number,number];
  const ramp=(time:number,at:number,from:number,to:number)=>from+(to-from)*Math.max(0,Math.min(1,(time-at)/.02));
  assertTrajectory(output,time=>{
    const elapsed=Math.max(0,time-speed),ramped=Math.min(.02,elapsed);
    const phase=time<speed?time/4:speed/4+ramped/4+.25*ramped*ramped/.04+Math.max(0,elapsed-.02)/2;
    const center=time<pan?0:ramp(time,pan,0,f(.9));
    const radius=time<off?f(.4):time<on?ramp(time,off,f(.4),0):time<pan?ramp(time,on,0,f(.4)):ramp(time,pan,f(.4),f(1-f(.9)));
    return center+radius*Math.sin(2*Math.PI*phase);
  });
  expect(output.minimumPan).toBeGreaterThanOrEqual(-1);expect(output.maximumPan).toBeLessThanOrEqual(1);
  expect(output.maximumPanStep).toBeLessThan(.002);expect(output.sourceCount).toBe(1);expect(output.oscillatorCount).toBe(2);
});
