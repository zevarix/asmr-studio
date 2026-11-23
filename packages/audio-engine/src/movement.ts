import type {StereoMovementSettings} from '@asmr-studio/contracts';
import {holdLinearAutomation} from './automation.js';

export interface MovementParameters {center:number;radius:number;frequency:number}
/** Match the native AudioParam boundaries before deriving a deterministic trajectory. */
export function movementParameters(pan:number,settings:StereoMovementSettings|undefined):MovementParameters {
  const center=Math.fround(pan);
  const width=Math.fround(settings?.width??.3);
  const radius=settings?.enabled?Math.fround(Math.min(width,1-Math.abs(center))):0;
  return {center,radius,frequency:Math.fround(1/(settings?.cycleSeconds??30))};
}
/** Fresh saved-recipe phase: center at the layer start, moving toward the right. */
export function movementPan(pan:number,settings:StereoMovementSettings|undefined,elapsedSeconds:number):number {
  const {center,radius,frequency}=movementParameters(pan,settings);
  const phase=(Math.max(0,elapsedSeconds)*frequency)%1;
  return Math.fround(Math.max(-1,Math.min(1,center+radius*Math.sin(2*Math.PI*phase))));
}

const transitionSeconds=.02;
interface Curve {at:number;end:number;from:number;to:number}
const constant=(value:number,at:number):Curve=>({at,end:at,from:value,to:value});
function valueAt(curve:Curve,time:number):number {
  if(time<curve.at)return curve.from;
  if(time>=curve.end)return curve.to;
  return curve.from+(curve.to-curve.from)*(time-curve.at)/(curve.end-curve.at);
}
function area(curve:Curve,from:number,to:number):number {
  if(to<=from)return 0;
  const points=[from,...[curve.at,curve.end].filter(time=>time>from&&time<to),to].sort((a,b)=>a-b);
  return points.slice(1).reduce((sum,end,index)=>sum+valueAt(curve,(points[index]!+end)/2)*(end-points[index]!),0);
}
const wrap=(cycles:number)=>((cycles%1)+1)%1;
interface OscillatorOwner {oscillator:OscillatorNode;cosine:OscillatorNode;depth:GainNode;quadratureDepth:GainNode;offset:number;unsynced:boolean}

/** A native sine/cosine pair drives the existing panner; all phase edits use audio-clock automation. */
export class LayerMovement {
  private parameters:MovementParameters;
  private center:Curve;
  private depth:Curve;
  private quadratureDepth:Curve;
  private rate:Curve;
  private phaseTime:number;
  private phaseCycles=0;
  private owner:OscillatorOwner|null=null;
  private playing=false;
  private activationTime=0;
  private restart=true;
  private played=false;
  private disposed=false;

  constructor(private readonly context:AudioContext,private readonly pan:AudioParam,initialPan:number) {
    const now=context.currentTime;
    this.parameters=movementParameters(initialPan,undefined);
    this.center=constant(this.parameters.center,now);this.depth=constant(0,now);this.quadratureDepth=constant(0,now);this.rate=constant(0,now);this.phaseTime=now;
    pan.setValueAtTime(initialPan,now);
  }
  private phaseAt(time:number):number {return wrap(this.phaseCycles+area(this.rate,this.phaseTime,time));}
  private disposeOwner(owner:OscillatorOwner):void {
    for(const oscillator of [owner.oscillator,owner.cosine]){
      try{oscillator.stop(this.context.currentTime);}catch{/* A failed allocation may not have started it. */}
      oscillator.disconnect();
    }
    owner.depth.disconnect();owner.quadratureDepth.disconnect();
  }

  /** Preflight allocation is silent and reversible; callers roll it back if another graph fails. */
  prepare(pan:number,settings:StereoMovementSettings|undefined):()=>void {
    if(this.disposed||this.owner||movementParameters(pan,settings).radius===0)return()=>{};
    const now=this.context.currentTime;const offset=this.phaseAt(now);
    let oscillator:OscillatorNode|undefined,cosine:OscillatorNode|undefined,depth:GainNode|undefined,quadratureDepth:GainNode|undefined;
    try{
      oscillator=this.context.createOscillator();cosine=this.context.createOscillator();depth=this.context.createGain();quadratureDepth=this.context.createGain();
      oscillator.type='sine';
      cosine.setPeriodicWave(this.context.createPeriodicWave(new Float32Array([0,1]),new Float32Array([0,0]),{disableNormalization:true}));
      for(const source of [oscillator,cosine]){source.frequency.setValueAtTime(0,now);source.detune.setValueAtTime(0,now);}
      depth.gain.setValueAtTime(0,now);quadratureDepth.gain.setValueAtTime(0,now);
      oscillator.connect(depth);cosine.connect(quadratureDepth);depth.connect(this.pan);quadratureDepth.connect(this.pan);
      oscillator.start(now);cosine.start(now);
      const owner:OscillatorOwner={oscillator,cosine,depth,quadratureDepth,offset,unsynced:true};this.owner=owner;
      return()=>{if(this.owner===owner){this.disposeOwner(owner);this.owner=null;}};
    }catch(error){
      for(const source of [oscillator,cosine])if(source){try{source.stop(now);}catch{}source.disconnect();}
      depth?.disconnect();quadratureDepth?.disconnect();throw error;
    }
  }
  private automate(param:AudioParam,previous:Curve,target:number,now:number,smooth:boolean):Curve {
    const initial=Math.fround(valueAt(previous,now));const end=now+(smooth?transitionSeconds:0);
    holdLinearAutomation(param,initial,now);param.setValueAtTime(smooth?initial:target,now);
    if(smooth)param.linearRampToValueAtTime(target,end);
    return {at:now,end,from:smooth?initial:Math.fround(target),to:Math.fround(target)};
  }
  private setDepth(radius:number,now:number,smooth:boolean):void {
    if(!this.owner)return;
    const angle=2*Math.PI*this.owner.offset;
    this.depth=this.automate(this.owner.depth.gain,this.depth,Math.fround(radius*Math.cos(angle)),now,smooth);
    this.quadratureDepth=this.automate(this.owner.quadratureDepth.gain,this.quadratureDepth,Math.fround(radius*Math.sin(angle)),now,smooth);
  }
  private setRate(target:number,now:number,when=now,smooth=false):void {
    const phase=this.phaseAt(now),from=valueAt(this.rate,now);
    this.phaseCycles=phase;this.phaseTime=now;
    this.rate={at:when,end:when+(smooth?transitionSeconds:0),from:when>now?0:from,to:target};
    for(const source of this.owner?[this.owner.oscillator,this.owner.cosine]:[]){
      const frequency=source.frequency;
      holdLinearAutomation(frequency,from,now);frequency.setValueAtTime(this.rate.from,now);
      if(smooth)frequency.linearRampToValueAtTime(target,this.rate.end);else frequency.setValueAtTime(target,when);
    }
  }
  update(pan:number,settings:StereoMovementSettings|undefined,smooth:boolean):void {
    if(this.disposed)return;
    const now=this.context.currentTime,next=movementParameters(pan,settings),previous=this.parameters;
    if(next.radius>0&&!this.owner)throw new Error('Prepare movement before enabling it');
    const unsynced=this.owner?.unsynced??false;
    if(!smooth||next.center!==previous.center)this.center=this.automate(this.pan,this.center,this.owner?next.center:pan,now,smooth);
    if(this.owner&&(!smooth||unsynced||next.radius!==previous.radius))this.setDepth(next.radius,now,smooth);
    if(unsynced||next.frequency!==previous.frequency){
      const when=this.playing?Math.max(now,this.activationTime):now;
      this.setRate(this.playing?next.frequency:0,now,when,smooth&&this.playing&&when===now);
    }
    this.parameters=next;if(this.owner)this.owner.unsynced=false;
  }
  /** Prepare phase state without changing accepted playback or allocating during replay. */
  prepareStart(elapsed:number,delay:number,forceRestart=false,parameters=this.parameters):()=>void {
    if(this.disposed)return()=>{};
    const now=this.context.currentTime,fresh=this.restart||forceRestart;
    const phase=fresh?wrap(Math.max(0,elapsed)*parameters.frequency):this.phaseAt(now);
    const offset=this.owner?wrap(this.owner.offset+phase-this.phaseAt(now)):0;
    const blend=fresh&&this.played;
    return()=>{
      if(this.disposed)return;
      this.parameters=parameters;
      this.playing=true;this.activationTime=now+Math.max(0,delay);this.restart=false;
      if(fresh){
        if(this.owner)this.owner.offset=offset;
        this.phaseCycles=phase;this.phaseTime=now;
        // Blend the old/new sine/cosine coefficient vectors on the same audio
        // clock. Their convex combination stays within the permitted radius,
        // including repeated restarts, without an unscheduled waveform switch.
        this.center=this.automate(this.pan,this.center,this.parameters.center,now,blend);
        this.setDepth(this.parameters.radius,now,blend);
      }
      this.setRate(this.parameters.frequency,now,this.activationTime);
      this.played=true;
    };
  }
  pause(reset=false):void {
    if(this.disposed)return;
    const now=this.context.currentTime;this.setRate(0,now);this.playing=false;this.restart||=reset;
  }
  dispose():void {
    if(this.disposed)return;this.disposed=true;
    if(this.owner)this.disposeOwner(this.owner);this.owner=null;
  }
}
