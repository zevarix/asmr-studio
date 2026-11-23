import {randomUUID} from 'node:crypto';
import {expect,test,type Page} from '@playwright/test';
import {createEmptyTransition,parseCapturedMix,parseScene,type MixTransition,type Scene} from '@asmr-studio/contracts';
import {samplePeak} from '../fixtures/export.js';
import {compareExport,importSignal,layer,saveScene} from '../fixtures/finished-export.js';

type Action={at:number;kind:'pause'|'play'|'stop-play'|'cancel'|'manual'|'failed-b'|'over-budget-b';blend?:number};
type RenderSettings={common?:boolean;onlyA?:boolean;mode?:'manual'|'timed';blend?:number;start?:number;duration?:number;length?:number;actions?:Action[]};

async function render(page:Page,settings:RenderSettings){
  return page.evaluate(async settings=>{
    const modulePath='/packages/audio-engine/src/engine.ts';const {createMixer}=await import(modulePath);
    const contractPath='/packages/contracts/src/index.ts';const {transitionBlendAt}=await import(contractPath);
    const rate=48000,context=new OfflineAudioContext(2,Math.round((settings.length??1.5)*rate),rate);
    const bufferA=context.createBuffer(2,rate*3,rate);bufferA.getChannelData(0).fill(.4);bufferA.getChannelData(1).fill(.1);
    const bufferB=context.createBuffer(2,rate*3,rate);bufferB.getChannelData(0).fill(-.2);bufferB.getChannelData(1).fill(.3);
    let sourceCount=0;const createSource=context.createBufferSource.bind(context);
    context.createBufferSource=()=>{sourceCount++;return createSource();};
    const asset=(id:string)=>({id,sha256:(id==='a'?'a':'b').repeat(64),displayName:id,roles:['texture'],durationSeconds:3,
      sampleRate:rate,channels:2,format:'wav',provenance:{kind:'original',source:null},rights:{privateUse:'permitted',redistribution:'permitted'}});
    const capture=(side:string,id:string)=>({id:'capture-'+side,scene:{schemaVersion:1,id:'mix-'+side,title:'Mix '+side,revision:1,
      masterGain:1,durationSeconds:null,layers:[{id:'same-layer-id',assetId:id,role:'texture',gain:1,pan:0,muted:false,solo:side==='a',startSeconds:0,loop:null}]},assets:[asset(id)]});
    const a=capture('a','a'),b=capture('b',settings.common?'a':'b');
    let scene={schemaVersion:1,id:'arrangement',title:'Native crossfader',revision:0,masterGain:1,durationSeconds:null,layers:[],
      transition:{a,b:settings.onlyA?null:b,curve:'linear',mode:settings.mode??'timed',blend:settings.blend??0,
        startSeconds:settings.start??.2,durationSeconds:settings.duration??.8,startPositions:{a:0,b:0}}};
    const failures:string[]=[],states:Array<{at:number;state:string;position:number;blend:number|undefined}>=[];
    let rejectB:((error:Error)=>void)|null=null,failB=false,overBudget=false;
    const mixer=createMixer({context,decodedBudgetBytes:3_000_000,loadAsset:async(id:string)=>{
      if(id==='broken')return new Promise<AudioBuffer>((_resolve,reject)=>{rejectB=reject;});
      if(id==='large')return context.createBuffer(2,rate*8,rate);
      return id==='a'?bufferA:bufferB;
    }});
    let snapshot:any;
    mixer.subscribe((value:any)=>{snapshot=value;});
    await mixer.setScene(scene);await mixer.play();
    const points=(settings.actions??[]).map(action=>({action,promise:context.suspend(action.at)}));
    const times:number[]=[];const rendering=context.startRendering();
    for(const {action,promise} of points){
      await promise;times.push(context.currentTime);
      if(action.kind==='pause')mixer.pause();
      if(action.kind==='play')await mixer.play();
      if(action.kind==='stop-play'){mixer.stop();await mixer.play();}
      if(action.kind==='manual'||action.kind==='cancel'){
        // A subscription reads the current audio-clock position, not a stale UI tick.
        const unsubscribe=mixer.subscribe((value:any)=>{snapshot=value;});unsubscribe();
        const blend=action.kind==='cancel'?transitionBlendAt(scene.transition,snapshot.positionSeconds):action.blend!;
        scene={...scene,transition:{...scene.transition,mode:'manual',blend}};
        mixer.apply({type:'setTransition',transition:scene.transition});
      }
      if(action.kind==='failed-b'){
        const candidate=capture('candidate','broken');candidate.assets[0]!.sha256='c'.repeat(64);
        const pending=mixer.updateScene({...scene,transition:{...scene.transition,b:candidate}});
        for(let i=0;i<20&&!rejectB;i++)await Promise.resolve();
        if(!rejectB)throw new Error('B load did not enter its deferred decoder');
        (rejectB as (error:Error)=>void)(new Error('Fixture decode failure'));
        await pending.catch((error:Error)=>failures.push(error.message));failB=true;
      }
      if(action.kind==='over-budget-b'){
        const candidate=capture('large','large');candidate.assets[0]!.durationSeconds=8;
        await mixer.updateScene({...scene,transition:{...scene.transition,b:candidate}}).catch((error:Error)=>failures.push(error.message));overBudget=true;
      }
      const unsubscribe=mixer.subscribe((value:any)=>{snapshot=value;});unsubscribe();
      states.push({at:context.currentTime,state:snapshot.state,position:snapshot.positionSeconds,blend:snapshot.transition?.blend});
      await context.resume();
    }
    const output=await rendering;const samples:Array<{time:number;left:number;right:number}>=[];
    for(let frame=0;frame<output.length;frame+=120)samples.push({time:frame/rate,left:output.getChannelData(0)[frame]!,right:output.getChannelData(1)[frame]!});
    const unsubscribe=mixer.subscribe((value:any)=>{snapshot=value;});unsubscribe();
    const final=snapshot;mixer.dispose();return {samples,times,states,sourceCount,failures,failB,overBudget,final};
  },settings);
}

function assertBlend(output:Awaited<ReturnType<typeof render>>,expected:(time:number)=>number,include:(time:number)=>boolean=()=>true){
  let error=0,count=0;
  for(const sample of output.samples)if(sample.time>.025&&include(sample.time)){
    const blend=expected(sample.time);error=Math.max(error,Math.abs(sample.left-(.4-.6*blend)),Math.abs(sample.right-(.1+.2*blend)));count++;
  }
  expect(count).toBeGreaterThan(30);expect(error).toBeLessThan(2e-6);
}

async function saveArrangement(page:Page,a:Scene,b:Scene,settings:Partial<MixTransition>={},limiter={enabled:false,ceilingDb:-1}){
  const origin=new URL(page.url()).origin;
  const captures=[];
  for(const source of [a,b]){
    const response=await page.request.post('/api/scenes/'+source.id+'/capture',{headers:{origin},data:{expectedRevision:source.revision}});
    expect(response.status(),await response.text()).toBe(201);captures.push(parseCapturedMix(await response.json()));
  }
  const empty=createEmptyTransition(randomUUID(),'Native saved transition');
  const scene=parseScene({...empty,outputLimiter:limiter,transition:{...empty.transition,a:captures[0],b:captures[1],mode:'timed',startSeconds:.125,durationSeconds:.75,...settings}});
  const response=await page.request.post('/api/scenes',{headers:{origin},data:scene});
  expect(response.status(),await response.text()).toBe(201);return parseScene(await response.json());
}

test.beforeEach(async({page})=>{await page.goto('/tests/harness/audio.html');});

test('native A/B gains follow audio time and complete with no display ticks',async({page})=>{
  const output=await render(page,{});
  assertBlend(output,time=>Math.max(0,Math.min(1,(time-.2)/.8)));
  expect(output.sourceCount).toBe(2);expect(output.final.transition.phase).toBe('complete');
});

test('identical shared recordings keep unity at the midpoint and retain two audible branches',async({page})=>{
  const output=await render(page,{common:true,mode:'manual',blend:.5});
  expect(output.sourceCount).toBe(2);
  for(const sample of output.samples)if(sample.time>.025){expect(sample.left).toBeCloseTo(.4,6);expect(sample.right).toBeCloseTo(.1,6);}
});

test('pause and resume preserve the timed blend while restart replays its saved wait',async({page})=>{
  const output=await render(page,{length:2.2,actions:[{at:.4,kind:'pause'},{at:.8,kind:'play'},{at:1.4,kind:'stop-play'}]});
  const [paused,resumed,restarted]=output.times as [number,number,number];
  assertBlend(output,time=>{
    const position=time<paused?time:time<restarted?time-(resumed-paused):time-restarted;
    return Math.max(0,Math.min(1,(position-.2)/.8));
  },time=>time<paused||(time>resumed+.025&&time<restarted)||(time>restarted+.025));
  expect(output.samples.filter(sample=>sample.time>paused+.025&&sample.time<resumed).every(sample=>sample.left===0&&sample.right===0)).toBe(true);
  expect(output.states.map(state=>state.state)).toEqual(['paused','playing','playing']);
});

test('cancel holds the real ramp position and manual control smoothly takes over',async({page})=>{
  const output=await render(page,{actions:[{at:.5,kind:'cancel'},{at:.9,kind:'manual',blend:.8}]});
  const [cancel,manual]=output.times as [number,number],held=(cancel-.2)/.8;
  assertBlend(output,time=>time<cancel?(time-.2)/.8<0?0:(time-.2)/.8:time<manual?held:.8,
    time=>time<cancel||time>cancel+.025&&time<manual||time>manual+.025);
  expect(output.final.transition.phase).toBe('manual');
});

test('failed and over-budget B preparation leave A playing with unchanged samples',async({page})=>{
  const output=await render(page,{onlyA:true,mode:'manual',actions:[{at:.3,kind:'failed-b'},{at:.7,kind:'over-budget-b'}]});
  assertBlend(output,()=>0);expect(output.failures).toHaveLength(2);
  expect(output.states.map(state=>state.state)).toEqual(['playing','playing']);expect(output.sourceCount).toBe(1);
});

test('saved native export matches captured loops, common assets and side-local solo',async({page},testInfo)=>{
  const asset=await importSignal(page,'Shared transition recording',{channels:2,frames:36000,seed:19});
  const a=await saveScene(page,'Captured A',[layer(asset.id,{id:'same',gain:.7,solo:true,loop:{startSeconds:.125,endSeconds:.625,crossfadeSeconds:.04}})],{masterGain:.8,durationSeconds:null});
  const b=await saveScene(page,'Captured B',[layer(asset.id,{id:'same',gain:.4,pan:.4,loop:{startSeconds:.125,endSeconds:.625,crossfadeSeconds:.04}})],{masterGain:.7,durationSeconds:null});
  const arrangement=await saveArrangement(page,a,b);
  await compareExport(page,testInfo,arrangement,1.4,{assets:[asset]});
});

test('export preserves captured EQ, movement, occasional seed and unequal timer endpoints',async({page},testInfo)=>{
  const mono=await importSignal(page,'Transition gesture',{channels:1,frames:12000,seed:20});
  const stereo=await importSignal(page,'Transition alternate',{channels:2,frames:18000,seed:21});
  const a=await saveScene(page,'Short captured timer',[layer(mono.id,{gain:.6,pan:-.1,
    loop:{startSeconds:0,endSeconds:.25,crossfadeSeconds:.025},equalizer:{bypassed:false,bassDb:2,midDb:-1,trebleDb:1}})],
    {masterGain:.7,durationSeconds:null,masterEqualizer:{bypassed:false,bassDb:-2,midDb:1,trebleDb:1},
      listeningTimer:{enabled:true,durationSeconds:.9,fadeInSeconds:.1,fadeOutSeconds:.15}});
  const b=await saveScene(page,'Occasional captured timer',[layer(mono.id,{gain:.6,pan:.1,startSeconds:.0625,
    occasional:{enabled:true,minPauseSeconds:.25,maxPauseSeconds:.5,seed:123,alternateAssetIds:[stereo.id],levelVariation:.1,panVariation:.1},
    movement:{enabled:true,width:.3,cycleSeconds:2},equalizer:{bypassed:false,bassDb:1,midDb:-2,trebleDb:.5}})],
    {masterGain:.7,durationSeconds:null,masterEqualizer:{bypassed:false,bassDb:2,midDb:-1,trebleDb:0},
      listeningTimer:{enabled:true,durationSeconds:1.7,fadeInSeconds:.1,fadeOutSeconds:.2}});
  const arrangement=await saveArrangement(page,a,b,{durationSeconds:1});
  const {actual}=await compareExport(page,testInfo,arrangement,2,{assets:[mono,stereo]});
  for(const channel of actual.channelData)expect(samplePeak(channel,Math.round(1.71*48000))).toBeLessThan(1/32768);
});

test('combined peak limiting and captured side limiters match native export without intermediate clipping',async({page},testInfo)=>{
  const asset=await importSignal(page,'Correlated transition peaks',{channels:2,frames:48000,seed:24});
  const a=await saveScene(page,'Hot captured A',Array.from({length:6},()=>layer(asset.id,{gain:1})),
    {masterGain:1,durationSeconds:null,outputLimiter:{enabled:true,ceilingDb:-3}});
  const b=await saveScene(page,'Hot captured B',Array.from({length:7},()=>layer(asset.id,{gain:1,pan:.1})),
    {masterGain:1,durationSeconds:null,outputLimiter:{enabled:true,ceilingDb:-4}});
  const arrangement=await saveArrangement(page,a,b,{durationSeconds:.5},{enabled:true,ceilingDb:-9});
  const {actual}=await compareExport(page,testInfo,arrangement,.95,{assets:[asset]});
  for(const channel of actual.channelData)expect(samplePeak(channel)).toBeLessThanOrEqual(10**(-9/20)+1/32768);
});

test('a silent captured side is valid and a later source edit cannot alter its frozen export',async({page},testInfo)=>{
  const asset=await importSignal(page,'Captured finite transition',{channels:1,frames:36000,seed:17});
  const a=await saveScene(page,'Finite A',[layer(asset.id,{gain:.65})],{masterGain:.8,durationSeconds:null});
  const b=await saveScene(page,'Silent B',[],{masterGain:.8,durationSeconds:null});
  const arrangement=await saveArrangement(page,a,b,{startSeconds:0,durationSeconds:.5});
  const edited=await page.request.put('/api/scenes/'+a.id,{headers:{origin:new URL(page.url()).origin},data:{scene:{...a,title:'Later source edit',layers:[]},expectedRevision:a.revision}});
  expect(edited.status(),await edited.text()).toBe(200);
  const {actual}=await compareExport(page,testInfo,arrangement,1.2,{assets:[asset]});
  for(const channel of actual.channelData)expect(samplePeak(channel,Math.round(.51*48000))).toBe(0);
});
