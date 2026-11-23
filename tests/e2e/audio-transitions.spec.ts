import {test,expect,type Page} from '@playwright/test';

type Operation={at:number;action:'pause'|'stop'|'pause-play'|'stop-play'|'remove'|'edit'|'dispose'|'replace'};
type Settings={start?:number;duration?:number;assetDuration?:number;loop?:boolean;risingSignal?:boolean;operations?:Operation[]};
const rate=48000;

async function render(page:Page,settings:Settings={}){
  return page.evaluate(async settings=>{
    const modulePath='/packages/audio-engine/src/engine.ts';const {createMixer}=await import(modulePath);
    const context=new OfflineAudioContext(2,14400,48000);
    const buffer=context.createBuffer(2,Math.round((settings.assetDuration??0.4)*48000),48000);
    for(let i=0;i<buffer.length;i++){
      const value=settings.risingSignal?0.1+i/48000:0.25;
      buffer.getChannelData(0)[i]=value;buffer.getChannelData(1)[i]=-value/2;
    }
    const scene={schemaVersion:1,id:'transitions',title:'Transition fixture',revision:0,masterGain:1,durationSeconds:settings.duration??null,
      layers:[{id:'one',assetId:'fixture',role:'texture',gain:1,pan:0,muted:false,solo:false,startSeconds:settings.start??0,
        loop:settings.loop?{startSeconds:0,endSeconds:0.016,crossfadeSeconds:0.008}:null}]};
    const mixer=createMixer({context,loadAsset:async()=>buffer,decodedBudgetBytes:1024*1024});
    await mixer.setScene(scene);await mixer.play();
    const suspensions=(settings.operations??[]).map(operation=>({operation,paused:context.suspend(operation.at)}));
    const times:number[]=[];const rendering=context.startRendering();
    for(const {operation,paused} of suspensions){
      await paused;times.push(context.currentTime);
      switch(operation.action){
        case 'pause':mixer.pause();break;
        case 'stop':mixer.stop();break;
        case 'pause-play':mixer.pause();await mixer.play();break;
        case 'stop-play':mixer.stop();await mixer.play();break;
        case 'remove':mixer.apply({type:'removeLayer',layerId:'one'});break;
        case 'edit':mixer.apply({type:'setLayerGain',layerId:'one',gain:0.5});break;
        case 'dispose':mixer.dispose();break;
        case 'replace':await mixer.setScene({...scene,id:'replacement'});break;
      }
      await context.resume();
    }
    const output=await rendering;const left=Array.from(output.getChannelData(0));const right=Array.from(output.getChannelData(1));
    mixer.dispose();return{left,right,times};
  },settings);
}

function envelope(time:number,start:number,end=Infinity){
  const fade=Math.min(0.02,(end-start)/2);
  return Math.max(0,Math.min(1,(time-start)/fade,(end-time)/fade));
}
function expectSignal(output:{left:number[];right:number[]},expected:(time:number)=>number){
  expect(Math.max(...output.left.map((sample,i)=>Math.abs(sample-expected(i/rate))))).toBeLessThan(2e-6);
  expect(Math.max(...output.right.map((sample,i)=>Math.abs(sample+expected(i/rate)/2)))).toBeLessThan(2e-6);
}
test.beforeEach(async({page})=>{await page.goto('/tests/harness/audio.html');});

test('starts each layer with a short fade, including delayed starts and loop intro handoffs',async({page})=>{
  for(const settings of [{},{start:0.04},{loop:true}]){
    const output=await render(page,settings);expectSignal(output,time=>0.25*envelope(time,settings.start??0));
  }
});

for(const action of ['pause','stop','remove'] as const){
  test(`${action} releases the signal over 20 ms and then stays silent`,async({page})=>{
    const output=await render(page,{operations:[{at:0.08,action}]});const at=output.times[0]!;
    expectSignal(output,time=>0.25*envelope(time,0)*Math.max(0,Math.min(1,1-(time-at)/0.02)));
  });
}

test('a pause during the attack releases from the current level without a step',async({page})=>{
  const output=await render(page,{loop:true,operations:[{at:0.005,action:'pause'}]});const at=output.times[0]!;
  expectSignal(output,time=>0.25*(time<at?envelope(time,0):envelope(at,0)*Math.max(0,1-(time-at)/0.02)));
});

test('immediate pause/resume does not boost or cut a steady signal',async({page})=>{
  const output=await render(page,{operations:[{at:0.08,action:'pause-play'},{at:0.088,action:'pause-play'}]});
  expectSignal(output,time=>0.25*envelope(time,0));
});

test('rapid restarts preserve both stereo channels at fractional sample boundaries',async({page})=>{
  const output=await render(page,{operations:[
    {at:0.03,action:'stop-play'},
    {at:0.035,action:'stop-play'},
    {at:0.04,action:'stop-play'},
  ]});
  expectSignal(output,time=>0.25*envelope(time,0));
});

test('stop/play crossfades the outgoing position into a rewound source',async({page})=>{
  const output=await render(page,{risingSignal:true,operations:[{at:0.08,action:'stop-play'}]});const at=output.times[0]!;
  expectSignal(output,time=>time<at?(0.1+time)*envelope(time,0):
    (0.1+time)*Math.max(0,1-(time-at)/0.02)+(0.1+time-at)*envelope(time,at));
});

test('finite scenes and very short clips fade out without extending their ending',async({page})=>{
  for(const settings of [{duration:0.12,loop:true},{assetDuration:0.01},{start:0.04,duration:0.05}]){
    const end=settings.duration??settings.assetDuration!;const output=await render(page,settings);
    expectSignal(output,time=>0.25*envelope(time,settings.start??0,end));
    expect(output.left.slice(Math.round(end*rate)).every(sample=>sample===0)).toBe(true);
  }
});

test('stopping before a delayed layer starts cancels its future audio',async({page})=>{
  const output=await render(page,{start:0.15,operations:[{at:0.08,action:'stop'}]});expectSignal(output,()=>0);
});

test('editing the gain after a stopped tail has finished cannot revive audio',async({page})=>{
  const output=await render(page,{operations:[{at:0.08,action:'stop'},{at:0.12,action:'edit'}]});const at=output.times[0]!;
  expectSignal(output,time=>0.25*envelope(time,0)*Math.max(0,Math.min(1,1-(time-at)/0.02)));
});

for(const action of ['dispose','replace'] as const){
  test(`${action} immediately clears an outstanding release tail`,async({page})=>{
    const output=await render(page,{operations:[{at:0.08,action:'pause'},{at:0.088,action}]});const [at,cleared]=output.times as [number,number];
    expectSignal(output,time=>time>=cleared?0:0.25*envelope(time,0)*Math.max(0,Math.min(1,1-(time-at)/0.02)));
  });
}
