import {OUTPUT_LIMITER_MIN_DB,OUTPUT_LIMITER_MAX_DB,type OutputLimiterSettings} from '@asmr-studio/contracts';

export const OUTPUT_WORKLET_NAME='asmr-studio-output';
export type OutputWorkletControl={type:'meter-ack'|'reset-peaks'|'dispose'};

export interface OutputMeterSnapshot {
  available:boolean;
  /** Linear final-output sample peaks and RMS, including the listening envelope. */
  peak:[number,number];
  rms:[number,number];
  heldPeak:[number,number];
  clipped:[boolean,boolean];
  /** Greatest stereo-linked attenuation in the measurement window, expressed as positive dB. */
  gainReductionDb:number;
  error:string|null;
}

export function emptyOutputMeterSnapshot():OutputMeterSnapshot {
  return {available:false,peak:[0,0],rms:[0,0],heldPeak:[0,0],clipped:[false,false],gainReductionDb:0,error:null};
}

/**
 * Zero-lookahead, stereo-linked sample-peak limiting. Instant attenuation and a
 * 100 ms exponential release provide a bounded digital sample ceiling without
 * makeup gain, inserted delay, or a generated tail. This is not a true-peak meter.
 * The same scalar state machine runs in the AudioWorklet and the WAV renderer.
 */
export class StereoOutputProcessor {
  private enabled=false;
  private ceilingDb=-1;
  private ceiling=Math.fround(10**(-1/20));
  private gain=1;
  private readonly release:number;
  private readonly bypassFrames:number;
  private bypassRemaining=0;
  private bypassStep=0;
  private frames=0;
  private peak:[number,number]=[0,0];
  private squares:[number,number]=[0,0];
  private heldPeak:[number,number]=[0,0];
  private clipped:[boolean,boolean]=[false,false];
  private minimumGain=1;
  private error:string|null=null;

  constructor(sampleRate:number) {
    if(!Number.isFinite(sampleRate)||sampleRate<=0)throw new Error('A positive output sample rate is required');
    this.release=Math.exp(-1/(sampleRate*.1));
    this.bypassFrames=Math.max(1,Math.round(sampleRate*.02));
  }

  setLimiter(settings:OutputLimiterSettings|undefined,smooth=false):void {
    const enabled=settings?.enabled??false,ceilingDb=settings?.ceilingDb??-1;
    if(typeof enabled!=='boolean'||!Number.isFinite(ceilingDb)||ceilingDb<OUTPUT_LIMITER_MIN_DB||ceilingDb>OUTPUT_LIMITER_MAX_DB)throw new Error('Invalid output limiter settings');
    if(enabled===this.enabled&&ceilingDb===this.ceilingDb)return;
    this.enabled=enabled;this.ceilingDb=ceilingDb;
    // AudioParam values are Float32. Match that boundary in the native renderer.
    this.ceiling=Math.fround(10**(Math.fround(ceilingDb)/20));
    this.bypassRemaining=0;
    if(!smooth)this.gain=1;
    else if(!enabled&&this.gain<1){this.bypassRemaining=this.bypassFrames;this.bypassStep=(1-this.gain)/this.bypassFrames;}
  }

  process(left:Float32Array,right:Float32Array,outLeft:Float32Array,outRight:Float32Array,listeningGain?:Float32Array):void {
    const frames=left.length;
    if(right.length!==frames||outLeft.length!==frames||outRight.length!==frames)throw new Error('Stereo output blocks must have equal lengths');
    if(listeningGain&&listeningGain.length!==1&&listeningGain.length!==frames)throw new Error('Listening gain must be constant or match the audio block length');
    for(let frame=0;frame<frames;frame++){
      const l=left[frame]!,r=right[frame]!;
      const envelope=listeningGain?.[listeningGain.length===1?0:frame]??1;
      if(!Number.isFinite(l)||!Number.isFinite(r))this.error='Output processing stopped because the audio contained invalid samples.';
      if(!Number.isFinite(envelope)||envelope<0||envelope>1)this.error='Output processing stopped because the listening gain was invalid.';
      let valueL=0,valueR=0;
      if(this.error===null){
        if(this.enabled){
          const peak=Math.max(Math.abs(l),Math.abs(r));
          const target=peak>this.ceiling?this.ceiling/peak:1;
          this.gain=Math.min(target,1-(1-this.gain)*this.release);
        }else if(this.bypassRemaining>0){
          this.bypassRemaining--;
          this.gain=this.bypassRemaining===0?1:Math.min(1,this.gain+this.bypassStep);
        }
        valueL=Math.fround(l*this.gain);valueR=Math.fround(r*this.gain);
        // Both multiplication and the configured ceiling have Float32 endpoints.
        // A final rounding guard never permits a sample beyond that endpoint.
        if(this.enabled){valueL=Math.max(-this.ceiling,Math.min(this.ceiling,valueL));valueR=Math.max(-this.ceiling,Math.min(this.ceiling,valueR));}
        this.minimumGain=Math.min(this.minimumGain,this.gain);
        // Fade the limited output, so loud input cannot fight the listening curve.
        // Unity leaves the existing samples (including signed zero) unchanged.
        if(envelope!==1){valueL=Math.fround(valueL*envelope);valueR=Math.fround(valueR*envelope);}
      }
      outLeft[frame]=valueL;outRight[frame]=valueR;
      const peakL=Math.abs(valueL),peakR=Math.abs(valueR);
      this.peak[0]=Math.max(this.peak[0],peakL);this.peak[1]=Math.max(this.peak[1],peakR);
      this.heldPeak[0]=Math.max(this.heldPeak[0],peakL);this.heldPeak[1]=Math.max(this.heldPeak[1],peakR);
      this.clipped[0] ||= peakL>=1;this.clipped[1] ||= peakR>=1;
      this.squares[0]+=valueL*valueL;this.squares[1]+=valueR*valueR;
    }
    this.frames+=frames;
  }

  takeMeterSnapshot():OutputMeterSnapshot {
    const result:OutputMeterSnapshot={available:true,peak:[...this.peak],
      rms:this.frames?[Math.sqrt(this.squares[0]/this.frames),Math.sqrt(this.squares[1]/this.frames)]:[0,0],
      heldPeak:[...this.heldPeak],clipped:[...this.clipped],
      gainReductionDb:this.minimumGain<1?-20*Math.log10(this.minimumGain):0,error:this.error};
    this.frames=0;this.peak=[0,0];this.squares=[0,0];this.minimumGain=1;
    return result;
  }

  resetPeaks():void {this.heldPeak=[0,0];this.clipped=[false,false];}

  reset():void {
    this.gain=1;this.bypassRemaining=0;this.frames=0;this.peak=[0,0];this.squares=[0,0];
    this.minimumGain=1;this.error=null;this.resetPeaks();
  }
}
