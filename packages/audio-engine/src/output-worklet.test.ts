import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import type {OutputMeterSnapshot} from './output-processor.js';

class Port {
  messages:Array<{type:string;snapshot:OutputMeterSnapshot}>=[];
  onmessage:((event:{data:unknown})=>void)|null=null;
  postMessage(data:{type:string;snapshot:OutputMeterSnapshot}){this.messages.push(structuredClone(data));}
}
interface Processor {port:Port;process(inputs:Float32Array[][],outputs:Float32Array[][],parameters?:Record<string,Float32Array>):boolean}
let Processor:new()=>Processor;
beforeAll(async()=>{
  vi.stubGlobal('sampleRate',1000);
  vi.stubGlobal('AudioWorkletProcessor',class{port=new Port();});
  vi.stubGlobal('registerProcessor',(_name:string,constructor:new()=>Processor)=>{Processor=constructor;});
  await import('./output-worklet.js');
});
afterAll(()=>vi.unstubAllGlobals());
function block(processor:Processor,frames:number,left=0,right=0,input=true,controls:Record<string,number>={}){
  const outputs=[[new Float32Array(frames),new Float32Array(frames)]];
  const parameters=Object.fromEntries(Object.entries({enabled:0,ceilingDb:-1,smooth:0,resetEpoch:0,...controls}).map(([key,value])=>[key,Float32Array.of(value)]));
  const active=processor.process(input?[[new Float32Array(frames).fill(left),new Float32Array(frames).fill(right)]]:[],outputs,parameters);
  return {left:outputs[0]![0]!,right:outputs[0]![1]!,active};
}
function send(processor:Processor,data:unknown){processor.port.onmessage?.({data});}

describe('audio-thread output adapter',()=>{
  it('measures every input sample across variable block lengths and sends only bounded-rate windows',()=>{
    const processor=new Processor();block(processor,17,.25,-.5);
    block(processor,1,1.25,-1.5);block(processor,32);
    expect(processor.port.messages).toHaveLength(1);
    expect(processor.port.messages[0]!.snapshot).toMatchObject({peak:[1.25,1.5],heldPeak:[1.25,1.5],clipped:[true,true]});
    send(processor,{type:'meter-ack'});
    block(processor,50);expect(processor.port.messages).toHaveLength(2);
    expect(processor.port.messages[1]!.snapshot).toMatchObject({peak:[0,0],rms:[0,0],heldPeak:[1.25,1.5]});
  });

  it('applies the shared limiter, then handles disconnected inputs as silence with no generated tail',()=>{
    const processor=new Processor();const controls={enabled:1,ceilingDb:-6.020599913279624};
    const out=block(processor,50,2,.5,true,controls);
    expect(out.left.every(value=>value===.5)).toBe(true);expect(out.right.every(value=>value===.125)).toBe(true);
    send(processor,{type:'meter-ack'});
    const silent=block(processor,50,0,0,false,controls);expect(silent.left.every(value=>value===0)).toBe(true);expect(silent.right.every(value=>value===0)).toBe(true);
    expect(processor.port.messages.at(-1)!.snapshot.peak).toEqual([0,0]);
  });

  it('applies a scene reset on the audio timeline before the first sample of the new scene',()=>{
    const processor=new Processor();const controls={enabled:1,ceilingDb:-6.020599913279624};
    block(processor,50,4,2,true,controls);
    expect(block(processor,1,.25,.125,true,controls).left[0]).toBeLessThan(.04);
    expect(block(processor,1,.25,.125,true,{...controls,resetEpoch:1}).left[0]).toBe(.25);
  });

  it('clears the requested holds while processing continues, and stops producing after disposal',()=>{
    const processor=new Processor();block(processor,50,1.25,-.25);
    send(processor,{type:'meter-ack'});
    send(processor,{type:'reset-peaks'});expect(processor.port.messages.at(-1)!.snapshot).toMatchObject({heldPeak:[0,0],clipped:[false,false]});
    expect(block(processor,50,.25,-.125).left[0]).toBe(.25);
    send(processor,{type:'dispose'});const disposed=block(processor,50,.25,.125);
    expect(disposed.active).toBe(false);expect(disposed.left.every(value=>value===0)).toBe(true);
  });

  it('keeps one outstanding snapshot while a suspended UI cannot acknowledge measurements',()=>{
    const processor=new Processor();block(processor,50,.1,.2);
    block(processor,50,1.25,1.5);
    for(let index=0;index<100;index++)block(processor,50);
    expect(processor.port.messages).toHaveLength(1);
    send(processor,{type:'meter-ack'});block(processor,50);
    expect(processor.port.messages).toHaveLength(2);
    expect(processor.port.messages.at(-1)!.snapshot).toMatchObject({peak:[1.25,1.5],heldPeak:[1.25,1.5],clipped:[true,true]});
  });
});
