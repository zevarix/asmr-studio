import {expect,test} from '@playwright/test';

test.beforeEach(async({page})=>{await page.goto('/tests/harness/audio.html');});

for(const rate of [44100,48000]){
  test(`raw join audition matches the native repeated period at ${rate} Hz`,async({page})=>{
    const results=await page.evaluate(async rate=>{
      const modulePath='/packages/audio-engine/src/loops.ts';
      const {prepareLoop,createLoopJoinPreview,getLoopFrames}=await import(modulePath);
      const results=[];
      for(const {channels,start,length,fade} of [
        {channels:2,start:rate/4,length:rate/4,fade:0},
        {channels:1,start:9,length:32,fade:16},
        {channels:2,start:17.25,length:rate+33.2,fade:71.4},
      ]){
        const actualContext=new OfflineAudioContext(channels,rate*2,rate);
        const referenceContext=new OfflineAudioContext(channels,rate*2,rate);
        const input=actualContext.createBuffer(channels,Math.ceil(start+length)+100,rate);
        for(let c=0;c<channels;c++){
          const data=input.getChannelData(c);
          for(let i=0;i<data.length;i++) data[i]=.2*Math.sin(i*.017+c)+.1*Math.cos(i*.041-c);
        }
        const startSeconds=start/rate,endSeconds=(start+length)/rate;
        const crossfadeSeconds=fade===length/2?(endSeconds-startSeconds)/2:fade/rate;
        const loop={startSeconds,endSeconds,crossfadeSeconds};
        const crossfadeFrames=getLoopFrames(input,loop).crossfade;
        const preview=createLoopJoinPreview(input,loop,actualContext.createBuffer.bind(actualContext));
        const actual=actualContext.createBufferSource();
        actual.buffer=preview;
        actual.connect(actualContext.destination);
        actual.start();

        const prepared=prepareLoop(input,loop,referenceContext.createBuffer.bind(referenceContext));
        const period=Math.round(prepared.periodSeconds*rate);
        const phase=(period-rate%period)%period;
        const reference=referenceContext.createBufferSource();
        reference.buffer=prepared.buffer;
        reference.loop=true;
        reference.loopStart=prepared.offsetBaseSeconds;
        reference.loopEnd=prepared.offsetBaseSeconds+prepared.periodSeconds;
        reference.connect(referenceContext.destination);
        reference.start(0,prepared.offsetBaseSeconds+phase/rate);
        const [heard,wanted]=await Promise.all([actualContext.startRendering(),referenceContext.startRendering()]);
        let maxError=0,peak=0;
        for(let c=0;c<channels;c++) {
          const a=heard.getChannelData(c),b=wanted.getChannelData(c);
          for(let i=0;i<a.length;i++){
            maxError=Math.max(maxError,Math.abs(a[i]!-b[i]!));
            peak=Math.max(peak,Math.abs(b[i]!));
          }
        }
        const roundedInvalid={startSeconds:.6/rate,endSeconds:2.4/rate,crossfadeSeconds:.8/rate};
        let rejected=false;
        try{createLoopJoinPreview(input,roundedInvalid,actualContext.createBuffer.bind(actualContext));}
        catch{rejected=true;}
        results.push({crossfadeFrames,maxError,peak,frames:preview.length,channels:preview.numberOfChannels,rejected});
      }
      return results;
    },rate);
    expect(results.map(row=>row.crossfadeFrames)).toEqual([0,16,71]);
    expect(results.map(row=>row.channels)).toEqual([2,1,2]);
    for(const result of results){
      expect(result.frames).toBe(2*rate);
      expect(result.peak).toBeGreaterThan(.05);
      expect(result.maxError).toBeLessThanOrEqual(2e-6);
      expect(result.rejected).toBe(true);
    }
  });
}

test('repeated live loop edits preserve the adjacent source, clock and signal',async({page})=>{
  const result=await page.evaluate(async()=>{
    const modulePath='/packages/audio-engine/src/engine.ts';
    const {createMixer}=await import(modulePath);
    const rate=48000,context=new OfflineAudioContext(2,rate/4,rate);
    const selected=context.createBuffer(2,rate,rate),neighbor=context.createBuffer(2,rate,rate);
    selected.getChannelData(0).fill(.25);
    const ramp=neighbor.getChannelData(1);
    for(let i=0;i<ramp.length;i++) ramp[i]=-.1-i/rate;
    const sources:AudioBufferSourceNode[]=[];
    const create=context.createBufferSource.bind(context);
    context.createBufferSource=()=>{
      const source=create();sources.push(source);return source;
    };
    const mixer=createMixer({context,loadAsset:async(id:string)=>id==='selected'?selected:neighbor,decodedBudgetBytes:4*1024*1024});
    const layers=['selected','neighbor'].map(id=>({id,assetId:id,role:'texture',gain:1,pan:0,muted:false,solo:false,startSeconds:0,loop:null}));
    await mixer.setScene({schemaVersion:1,id:'live-loop',title:'Live loop edits',revision:0,masterGain:1,durationSeconds:1,layers});
    await mixer.play();
    const original=sources.find(source=>source.buffer===neighbor);
    const edits=[
      {at:.08,loop:{startSeconds:.02,endSeconds:.16,crossfadeSeconds:.03}},
      {at:.088,loop:{startSeconds:.15,endSeconds:.25,crossfadeSeconds:0}},
      {at:.125,loop:null},
    ].map(edit=>({...edit,paused:context.suspend(edit.at)}));
    const rendering=context.startRendering();
    const states:string[]=[],positionErrors:number[]=[],sameSource:boolean[]=[],replacements:number[]=[];
    for(const {loop,paused} of edits){
      await paused;
      const previousCount=sources.length;
      mixer.apply({type:'setLayerLoop',layerId:'selected',loop});
      replacements.push(sources.length-previousCount);
      const unsubscribe=mixer.subscribe((snapshot:{state:string;positionSeconds:number})=>{
        states.push(snapshot.state);positionErrors.push(Math.abs(snapshot.positionSeconds-context.currentTime));
      });
      unsubscribe();
      const neighbors=sources.filter(source=>source.buffer===neighbor);
      sameSource.push(!!original&&neighbors.length===1&&neighbors[0]===original);
      await context.resume();
    }
    const rendered=await rendering;
    const left=rendered.getChannelData(0),right=rendered.getChannelData(1);
    let maxError=0;
    for(let i=0;i<rendered.length;i++){
      const attack=Math.min(1,i/(.02*rate));
      maxError=Math.max(maxError,Math.abs(left[i]!-.25*attack),Math.abs(right[i]!-ramp[i]!*attack));
    }
    mixer.dispose();
    return {states,positionErrors,sameSource,replacements,maxError};
  });
  expect(result.states).toEqual(['playing','playing','playing']);
  expect(Math.max(...result.positionErrors)).toBeLessThan(1/48000);
  expect(result.sameSource).toEqual([true,true,true]);
  expect(result.replacements).toEqual([1,1,1]);
  expect(result.maxError).toBeLessThanOrEqual(2e-6);
});
