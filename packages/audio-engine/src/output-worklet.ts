import {OUTPUT_LIMITER_MIN_DB,OUTPUT_LIMITER_MAX_DB} from '@asmr-studio/contracts';
import {OUTPUT_WORKLET_NAME,StereoOutputProcessor,type OutputWorkletControl} from './output-processor.js';

// These globals exist inside the AudioWorklet scope; DOM typings describe only
// its main-thread AudioWorkletNode counterpart.
declare const sampleRate:number;
declare abstract class AudioWorkletProcessor {readonly port:MessagePort;}
declare function registerProcessor(name:string,processor:typeof StudioOutputProcessor):void;

class StudioOutputProcessor extends AudioWorkletProcessor {
  private readonly output=new StereoOutputProcessor(sampleRate);
  private framesSinceReport=0;
  private resetEpoch=0;
  private reportPending=false;
  private active=true;
  static get parameterDescriptors(){
    return [
      {name:'enabled',defaultValue:0,minValue:0,maxValue:1,automationRate:'k-rate'},
      {name:'ceilingDb',defaultValue:-1,minValue:OUTPUT_LIMITER_MIN_DB,maxValue:OUTPUT_LIMITER_MAX_DB,automationRate:'k-rate'},
      {name:'smooth',defaultValue:0,minValue:0,maxValue:1,automationRate:'k-rate'},
      {name:'resetEpoch',defaultValue:0,minValue:0,maxValue:16_777_215,automationRate:'k-rate'},
      {name:'listeningGain',defaultValue:1,minValue:0,maxValue:1,automationRate:'a-rate'},
    ];
  }
  constructor(){
    super();
    this.port.onmessage=(event:MessageEvent<OutputWorkletControl>)=>{
      const message=event.data;
      if(message.type==='dispose'){this.active=false;return;}
      if(!this.active)return;
      if(message.type==='meter-ack')this.reportPending=false;
      else if(message.type==='reset-peaks'){this.output.resetPeaks();this.report();}
    };
  }
  private report():void {
    // A background or blocked UI cannot accumulate an unbounded MessagePort queue.
    // Samples still contribute to the next window and holds while it catches up.
    if(this.reportPending)return;
    this.reportPending=true;this.port.postMessage({type:'meter',epoch:this.resetEpoch,snapshot:this.output.takeMeterSnapshot()});
  }
  process(inputs:Float32Array[][],outputs:Float32Array[][],parameters:Record<string,Float32Array>):boolean {
    const [left,right]=outputs[0]??[];
    if(!left||!right)return this.active;
    if(!this.active){left.fill(0);right.fill(0);return false;}
    const epoch=parameters.resetEpoch?.[0]??0;
    if(epoch!==this.resetEpoch){this.output.reset();this.framesSinceReport=0;this.resetEpoch=epoch;}
    this.output.setLimiter({enabled:(parameters.enabled?.[0]??0)>=.5,ceilingDb:parameters.ceilingDb?.[0]??-1},(parameters.smooth?.[0]??0)>=.5);
    const input=inputs[0];
    if(!input?.length){left.fill(0);right.fill(0);this.output.process(left,right,left,right,parameters.listeningGain);}
    else this.output.process(input[0]!,input[1]??input[0]!,left,right,parameters.listeningGain);
    this.framesSinceReport+=left.length;
    if(this.framesSinceReport>=sampleRate/20){this.framesSinceReport%=sampleRate/20;this.report();}
    return true;
  }
}
registerProcessor(OUTPUT_WORKLET_NAME,StudioOutputProcessor);
