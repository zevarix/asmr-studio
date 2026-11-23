import type { OutputLimiterSettings, Scene, SceneCommand } from '@asmr-studio/contracts';
import type {OutputMeterSnapshot} from './output-processor.js';
export type PlaybackState = 'idle'|'loading'|'ready'|'playing'|'paused'|'interrupted'|'error';
export interface ListeningTimerSnapshot {
  remainingSeconds:number;
  phase:'idle'|'steady'|'fading-in'|'fading-out'|'finished';
  gain:number;
}
export interface PlaybackSnapshot {
  state: PlaybackState;
  positionSeconds: number;
  loadedAssetIds: string[];
  error: string|null;
  listeningTimer?:ListeningTimerSnapshot;
  transition?: {
    blend:number;
    phase:'manual'|'waiting'|'running'|'complete';
    remainingSeconds:number;
  };
}
export interface Mixer {
  setScene(scene:Scene):Promise<void>;
  /** Reconcile edits to the loaded scene without restarting unchanged layers or its clock. Latest edit wins. */
  updateScene(scene:Scene):Promise<void>;
  play():Promise<void>;
  pause():void;
  stop():void;
  apply(command:SceneCommand):void;
  subscribe(listener:(state:PlaybackSnapshot)=>void):()=>void;
  /** Output measurements have their own subscription; they do not update transport state. */
  subscribeOutput(listener:(snapshot:OutputMeterSnapshot)=>void):()=>void;
  resetOutputPeaks():void;
  /** Borrow original PCM already loaded or loading; never mutate it or start a new load. */
  getDecodedAsset(id:string):AudioBuffer|Promise<AudioBuffer>|undefined;
  dispose():void;
}
export interface MixerOptions {
  context:AudioContext;
  loadAsset:(id:string)=>Promise<AudioBuffer>;
  decodedBudgetBytes:number;
  /** Original recording duration, shared with the offline renderer. */
  assetDurationSeconds?:(id:string)=>number|undefined;
  /** Register a transport tick and return its cancellation function. */
  scheduleTick?:(tick:()=>void)=>()=>void;
  /** Optional browser adapter. An enabled scene limiter requires this processor. */
  createOutputStage?:(context:AudioContext)=>Promise<MixerOutputStage>;
}

export interface MixerOutputStage {
  node:AudioNode;
  /** Sample-accurate listening envelope, after the limiter and before final meters. */
  listeningGain:AudioParam;
  setLimiter(settings:OutputLimiterSettings|undefined,smooth:boolean):void;
  subscribe(listener:(snapshot:OutputMeterSnapshot)=>void):()=>void;
  resetPeaks():void;
  reset():void;
  dispose():void;
}
