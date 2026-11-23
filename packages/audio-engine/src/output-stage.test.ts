import {afterEach,describe,expect,it,vi} from 'vitest';
import {createWorkletOutputStage} from './output-stage.js';
import {emptyOutputMeterSnapshot,type OutputMeterSnapshot} from './output-processor.js';
import {FakeParam} from './test-utils/fake-context.js';

class Node {
  parameters=new Map(['enabled','ceilingDb','smooth','resetEpoch','listeningGain'].map(key=>[key,new FakeParam(key==='listeningGain'?1:0)]));
  port={onmessage:null as ((event:{data:unknown})=>void)|null,postMessage:(_value:unknown)=>{},close:()=>{}};
  onprocessorerror:(()=>void)|null=null;
  disconnect(){}
}
afterEach(()=>vi.unstubAllGlobals());
describe('browser output stage',()=>{
  it('exposes the native post-limiter listening gain for audio-clock scheduling',async()=>{
    vi.stubGlobal('AudioWorkletNode',Node);
    const context={state:'running',currentTime:0,audioWorklet:{addModule:async()=>{}}} as unknown as AudioContext;
    const stage=await createWorkletOutputStage(context,'/output.js');const node=stage.node as unknown as Node;
    expect(stage.listeningGain).toBe(node.parameters.get('listeningGain'));stage.dispose();
  });
  it('shares module loading per context and retries a rejected module load',async()=>{
    vi.stubGlobal('AudioWorkletNode',Node);let calls=0;
    const context={state:'running',audioWorklet:{addModule:async()=>{if(++calls===1)throw new Error('not loaded');}}} as unknown as AudioContext;
    await expect(createWorkletOutputStage(context,'/output.js')).rejects.toThrow('not loaded');
    const [one,two]=await Promise.all([createWorkletOutputStage(context,'/output.js'),createWorkletOutputStage(context,'/output.js')]);
    expect(calls).toBe(2);expect(one.node).not.toBe(two.node);one.dispose();two.dispose();
  });

  it('isolates subscribers and reports processor failures instead of claiming functioning meters',async()=>{
    vi.stubGlobal('AudioWorkletNode',Node);
    const context={state:'running',currentTime:0,audioWorklet:{addModule:async()=>{}}} as unknown as AudioContext;
    const stage=await createWorkletOutputStage(context,'/output.js');const node=stage.node as unknown as Node;
    const received:OutputMeterSnapshot[]=[];
    stage.subscribe(value=>{value.heldPeak[0]=90;});stage.subscribe(value=>received.push(value));
    node.port.onmessage?.({data:{type:'meter',epoch:0,snapshot:{...emptyOutputMeterSnapshot(),available:true,heldPeak:[.5,.25]}}});
    expect(received.at(-1)?.heldPeak).toEqual([.5,.25]);
    node.onprocessorerror?.();expect(received.at(-1)?.error).toMatch(/output processor/i);
    stage.dispose();const count=received.length;node.port.onmessage?.({data:{type:'meter',snapshot:emptyOutputMeterSnapshot()}});expect(received).toHaveLength(count);
  });

  it('ignores a stale measurement or fault from the previous scene after a timeline reset',async()=>{
    vi.stubGlobal('AudioWorkletNode',Node);
    const context={state:'running',currentTime:1,audioWorklet:{addModule:async()=>{}}} as unknown as AudioContext;
    const stage=await createWorkletOutputStage(context,'/output.js');const node=stage.node as unknown as Node;
    let current!:OutputMeterSnapshot;stage.subscribe(snapshot=>{current=snapshot;});stage.reset();
    node.port.onmessage?.({data:{type:'meter',epoch:0,snapshot:{...emptyOutputMeterSnapshot(),error:'Old scene fault'}}});
    expect(current.error).toBeNull();
    node.port.onmessage?.({data:{type:'meter',epoch:1,snapshot:{...emptyOutputMeterSnapshot(),available:true,heldPeak:[.5,.25]}}});
    expect(current.heldPeak).toEqual([.5,.25]);stage.dispose();
  });
});
