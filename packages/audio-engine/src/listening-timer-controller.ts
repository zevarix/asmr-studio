import type {ListeningTimerSettings} from '@asmr-studio/contracts';
import {holdLinearAutomation} from './automation.js';
import {listeningEnvelopeGain} from './listening-timer.js';
import type {PlaybackSnapshot,PlaybackState} from './types.js';

interface Point {time:number;value:number;type:'set'|'ramp'}
const transition=.02;
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
function equal(left:ListeningTimerSettings|undefined,right:ListeningTimerSettings|undefined):boolean {
  return left===right||!!left&&!!right&&left.enabled===right.enabled&&left.durationSeconds===right.durationSeconds
    &&left.fadeInSeconds===right.fadeInSeconds&&left.fadeOutSeconds===right.fadeOutSeconds;
}

/** Gain automation owns audible timing; UI callbacks only observe and retire silent playback. */
export class ListeningTimerController {
  private settings:ListeningTimerSettings|undefined;
  private points:Point[];
  private deadline:number|null=null;
  constructor(private readonly context:AudioContext,private readonly param:AudioParam){
    this.points=[{time:context.currentTime,value:1,type:'set'}];param.setValueAtTime(1,context.currentTime);
  }
  gainAt(time=this.context.currentTime):number{return Math.fround(Math.max(0,Math.min(1,valueAt(this.points,time))));}
  get deadlineTime():number|null{return this.deadline;}
  reset(settings:ListeningTimerSettings|undefined):void {
    this.settings=settings?{...settings}:undefined;this.deadline=null;
    this.replace([{time:this.context.currentTime,value:listeningEnvelopeGain(settings,0,settings?.durationSeconds??0),type:'set'}]);
  }
  private replace(points:Point[]):void {
    const now=this.context.currentTime,held=this.gainAt(now);
    holdLinearAutomation(this.param,held,now);
    for(const point of points){
      if(point.type==='ramp')this.param.linearRampToValueAtTime(point.value,point.time);
      else this.param.setValueAtTime(point.value,point.time);
    }
    this.points=points;
  }
  private schedule(elapsed:number,smooth:boolean):void {
    const now=this.context.currentTime,settings=this.settings,held=this.gainAt(now);
    if(!settings?.enabled){
      this.deadline=null;
      this.replace(smooth?[{time:now,value:held,type:'set'},{time:now+transition,value:1,type:'ramp'}]:[{time:now,value:1,type:'set'}]);
      return;
    }
    const duration=settings.durationSeconds,remaining=duration-elapsed;
    if(remaining<=0){
      this.deadline=now+transition;
      this.replace([{time:now,value:held,type:'set'},{time:this.deadline,value:0,type:'ramp'}]);
      return;
    }
    this.deadline=now+remaining;
    const until=smooth?Math.min(now+transition,this.deadline):now;
    const points:Point[]=[{time:now,value:smooth?held:listeningEnvelopeGain(settings,elapsed,duration),type:'set'}];
    if(until>now)points.push({time:until,value:until===this.deadline?0:listeningEnvelopeGain(settings,elapsed+until-now,duration),type:'ramp'});
    const knots:Point[]=[];
    if(settings.fadeInSeconds>0)knots.push({time:now+settings.fadeInSeconds-elapsed,value:1,type:'ramp'});
    if(settings.fadeOutSeconds>0){
      knots.push({time:now+duration-settings.fadeOutSeconds-elapsed,value:1,type:'set'});
      knots.push({time:this.deadline,value:0,type:'ramp'});
    }else knots.push({time:this.deadline,value:0,type:'set'});
    points.push(...knots.filter(point=>point.time>until));
    this.replace(points);
  }
  start(elapsed:number,smooth=false):void {this.schedule(elapsed,smooth);}
  update(settings:ListeningTimerSettings|undefined,elapsed:number,playing:boolean):void {
    if(equal(this.settings,settings))return;
    this.settings=settings?{...settings}:undefined;
    if(playing)this.schedule(elapsed,true);
  }
  pause():void {
    const now=this.context.currentTime;this.replace([{time:now,value:this.gainAt(now),type:'set'}]);this.deadline=null;
  }
  finish():void {
    this.replace([{time:this.context.currentTime,value:0,type:'set'}]);this.deadline=null;
  }
  snapshot(elapsed:number,state:PlaybackState):PlaybackSnapshot['listeningTimer'] {
    const settings=this.settings;if(!settings?.enabled)return undefined;
    const remainingSeconds=Math.max(0,settings.durationSeconds-elapsed);
    const phase=remainingSeconds===0
      ? state==='playing'&&this.deadline!==null&&this.context.currentTime<this.deadline?'fading-out':'finished'
      : state==='ready'&&elapsed===0?'idle'
      : elapsed<settings.fadeInSeconds?'fading-in'
      : settings.fadeOutSeconds>0&&elapsed>=settings.durationSeconds-settings.fadeOutSeconds?'fading-out':'steady';
    return {remainingSeconds,phase,gain:this.gainAt()};
  }
}
