import {transitionBlendAt,transitionGainsAt,type MixTransition} from '@asmr-studio/contracts';
import {holdLinearAutomation} from './automation.js';
import type {PlaybackSnapshot} from './types.js';

type Side='a'|'b';
interface Point {time:number;value:number;type:'set'|'ramp'}
interface Binding {param:AudioParam;points:Point[]}
const sides=['a','b'] as const;
const editSeconds=.02;

function valueAt(points:Point[],time:number):number {
  let previous=points[0]!;
  for(const point of points.slice(1)){
    if(time<point.time)return point.type==='ramp'
      ? previous.value+(point.value-previous.value)*Math.max(0,time-previous.time)/(point.time-previous.time)
      : previous.value;
    previous=point;
  }
  return previous.value;
}
function signature(settings:MixTransition):string {
  return JSON.stringify([settings.mode,settings.blend,settings.startSeconds,settings.durationSeconds,!!settings.a,!!settings.b]);
}

/** Native gain automation owns transition timing; observers never advance a fade. */
export class TransitionController {
  private bindings:Partial<Record<Side,Binding>>={};
  private settings:MixTransition|null=null;
  private key='';
  private playing=false;

  constructor(private readonly context:AudioContext){}

  private hold(binding:Binding):number {
    const now=this.context.currentTime,value=valueAt(binding.points,now);
    holdLinearAutomation(binding.param,value,now);
    binding.param.setValueAtTime(value,now);
    binding.points=[{time:now,value,type:'set'}];
    return value;
  }

  configure(settings:MixTransition,targets:Record<Side,AudioParam|null>,elapsed:number,playing:boolean,smooth:boolean,force=false):void {
    const key=signature(settings);
    const unchanged=key===this.key&&playing===this.playing&&sides.every(side=>this.bindings[side]?.param===(targets[side]??undefined));
    this.settings=settings;
    if(unchanged&&!force)return;
    const now=this.context.currentTime;
    for(const [index,side] of sides.entries()){
      const previous=this.bindings[side],param=targets[side];
      const held=previous?this.hold(previous):transitionGainsAt(settings,elapsed)[index]!;
      if(!param){delete this.bindings[side];continue;}
      // A newly prepared side has its own source attack. Start its blend at the
      // accepted value instead of multiplying two independent attack ramps.
      const blend=smooth&&previous?.param===param;
      const until=now+(blend?editSeconds:0);
      const localUntil=elapsed+(playing?until-now:0);
      const initial=blend?held:transitionGainsAt(settings,elapsed)[index]!;
      const points:Point[]=[{time:now,value:initial,type:'set'}];
      if(until>now)points.push({time:until,value:transitionGainsAt(settings,localUntil)[index]!,type:'ramp'});
      if(playing&&settings.mode==='timed'&&settings.a&&settings.b){
        const start=now+settings.startSeconds-elapsed,end=start+settings.durationSeconds;
        if(start>until)points.push({time:start,value:transitionGainsAt(settings,settings.startSeconds)[index]!,type:'set'});
        if(end>until)points.push({time:end,value:index===0?0:1,type:'ramp'});
      }
      holdLinearAutomation(param,initial,now);
      for(const point of points){
        if(point.type==='ramp')param.linearRampToValueAtTime(point.value,point.time);
        else param.setValueAtTime(point.value,point.time);
      }
      this.bindings[side]={param,points};
    }
    this.key=key;this.playing=playing;
  }

  pause():void {
    for(const side of sides){const binding=this.bindings[side];if(binding)this.hold(binding);}
    this.playing=false;
  }

  clear():void {
    this.pause();this.bindings={};this.settings=null;this.key='';
  }

  snapshot(elapsed:number):PlaybackSnapshot['transition'] {
    const settings=this.settings;if(!settings)return undefined;
    const end=settings.startSeconds+settings.durationSeconds;
    const phase=settings.mode==='manual'?'manual':elapsed<settings.startSeconds?'waiting':elapsed<end?'running':'complete';
    const binding=this.bindings.b;
    const blend=settings.a&&settings.b&&binding?valueAt(binding.points,this.context.currentTime):transitionBlendAt(settings,elapsed);
    return {blend:Math.max(0,Math.min(1,blend)),phase,remainingSeconds:phase==='manual'?0:Math.max(0,end-elapsed)};
  }
}
