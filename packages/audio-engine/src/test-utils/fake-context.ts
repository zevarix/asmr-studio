export class FakeParam {
  value:number; ramps:Array<[number,number]>=[]; holds:number[]=[];
  inputs=new Set<FakeNode>();
  constructor(private readonly initialValue=1){this.value=initialValue;}
  events:Array<{value:number;time:number;type:'set'|'ramp'}>=[];
  setValueAtTime(value:number,time:number){this.value=value;this.events.push({value,time,type:'set'});return this;}
  cancelScheduledValues(time:number){this.events=this.events.filter(event=>event.time<time);return this;}
  cancelAndHoldAtTime(time:number){
    const value=this.valueAt(time),next=[...this.events].sort((a,b)=>a.time-b.time).find(event=>event.time>=time);
    this.holds.push(time);this.cancelScheduledValues(time);
    if(next?.type==='ramp')this.events.push({value,time,type:'ramp'});
    this.setValueAtTime(value,time);return this;
  }
  linearRampToValueAtTime(value:number,time:number){this.ramps.push([value,time]);this.events.push({value,time,type:'ramp'});this.value=value;return this;}
  valueAt(time:number){
    let value=this.initialValue,previousTime=0;
    for(const event of [...this.events].sort((a,b)=>a.time-b.time)){
      if(event.time>time)return event.type==='ramp'?value+(event.value-value)*(time-previousTime)/(event.time-previousTime):value;
      value=event.value;previousTime=event.time;
    }
    return value;
  }
  integral(from:number,to:number){
    const points=[from,...this.events.map(event=>event.time).filter(time=>time>from&&time<to),to].sort((a,b)=>a-b);
    return points.slice(1).reduce((sum,end,index)=>sum+this.valueAt((points[index]!+end)/2)*(end-points[index]!),0);
  }
  computedAt(time:number){return Math.fround(this.valueAt(time)+[...this.inputs].reduce((sum,input)=>sum+input.sampleAt(time),0));}
}
export class FakeNode {
  connected=false; disconnected=false;
  inputs=new Set<FakeNode>();
  targets=new Set<unknown>();
  connect<T>(target:T):T{this.connected=true;this.disconnected=false;this.targets.add(target);if(target instanceof FakeNode||target instanceof FakeParam)target.inputs.add(this);return target;}
  disconnect(){this.connected=false;this.disconnected=true;for(const target of this.targets)if(target instanceof FakeNode||target instanceof FakeParam)target.inputs.delete(this);this.targets.clear();}
  sampleAt(_time:number):number{return 0;}
}
interface FakeWave {real:Float32Array;imag:Float32Array}
export class FakeOscillator extends FakeNode {
  frequency=new FakeParam(440);detune=new FakeParam(0);type:OscillatorType='sine';onended:(()=>void)|null=null;
  starts:number[]=[];stops:number[]=[];waves:Array<{time:number;wave:FakeWave}>=[];
  constructor(private readonly now:()=>number){super();}
  start(when=0){this.starts.push(when);}
  stop(when=0){this.stops.push(when);}
  setPeriodicWave(wave:FakeWave){this.waves.push({time:this.now(),wave});this.type='custom';}
  override sampleAt(time:number){
    const start=this.starts[0];if(start===undefined||time<start||this.stops.some(stop=>time>=stop))return 0;
    const angle=2*Math.PI*this.frequency.integral(start,time);
    const wave=this.waves.filter(item=>item.time<=time).at(-1)?.wave;
    return Math.fround(wave?(wave.real[1]??0)*Math.cos(angle)+(wave.imag[1]??0)*Math.sin(angle):Math.sin(angle));
  }
}
export class FakeBiquadFilter extends FakeNode {
  type:BiquadFilterType='lowpass';
  frequency=new FakeParam(350); detune=new FakeParam(0); Q=new FakeParam(1); gain=new FakeParam(0);
}
export class FakeSource extends FakeNode {
  buffer:AudioBuffer|null=null; loop=false;loopStart=0;loopEnd=0;onended:(()=>void)|null=null;
  starts:Array<[number,number,number|undefined]>=[];stops:number[]=[];
  start(when=0,offset=0,duration?:number){this.starts.push([when,offset,duration]);}
  stop(when=0){this.stops.push(when);}
}
export class FakeContext extends EventTarget {
  state:AudioContextState='running'; currentTime=0; sampleRate=48000;
  destination=new FakeNode();sources:FakeSource[]=[];nodes:FakeNode[]=[];gains:Array<FakeNode & {gain:FakeParam}>=[];
  oscillators:FakeOscillator[]=[];panners:Array<FakeNode & {pan:FakeParam}>=[];
  filters:FakeBiquadFilter[]=[];
  createdBuffers:AudioBuffer[]=[];
  createGain(){const node=Object.assign(new FakeNode(),{gain:new FakeParam()});node.sampleAt=(time:number)=>Math.fround([...node.inputs].reduce((sum,input)=>sum+input.sampleAt(time),0)*node.gain.computedAt(time));this.nodes.push(node);this.gains.push(node);return node;}
  createStereoPanner(){const node=Object.assign(new FakeNode(),{pan:new FakeParam(0)});this.nodes.push(node);this.panners.push(node);return node;}
  createOscillator(){const node=new FakeOscillator(()=>this.currentTime);this.nodes.push(node);this.oscillators.push(node);return node;}
  createPeriodicWave(real:Float32Array,imag:Float32Array,_options?:PeriodicWaveConstraints){return {real:new Float32Array(real),imag:new Float32Array(imag)};}
  createBiquadFilter(){const node=new FakeBiquadFilter();this.nodes.push(node);this.filters.push(node);return node;}
  createAnalyser(){const node=Object.assign(new FakeNode(),{fftSize:256,frequencyBinCount:128,getFloatTimeDomainData:(data:Float32Array)=>data.fill(0)});this.nodes.push(node);return node;}
  createBufferSource(){const source=new FakeSource();this.sources.push(source);this.nodes.push(source);return source;}
  createBuffer(channels:number,length:number,sampleRate:number){const buffer=fakeBuffer(channels,length,sampleRate);this.createdBuffers.push(buffer);return buffer;}
  async resume(){this.state='running';this.dispatchEvent(new Event('statechange'));}
  interrupt(){this.state='suspended';this.dispatchEvent(new Event('statechange'));}
}
export function fakeBuffer(channels=2,length=48000,sampleRate=48000):AudioBuffer {
  const data=Array.from({length:channels},()=>new Float32Array(length).fill(0.25));
  return {numberOfChannels:channels,length,sampleRate,duration:length/sampleRate,getChannelData:(channel:number)=>data[channel]!,copyToChannel:(input:Float32Array,channel:number)=>data[channel]!.set(input)} as AudioBuffer;
}
