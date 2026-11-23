import type {OutputLimiterSettings} from '@asmr-studio/contracts';
import {OUTPUT_WORKLET_NAME,emptyOutputMeterSnapshot,type OutputMeterSnapshot,type OutputWorkletControl} from './output-processor.js';
import type {MixerOutputStage} from './types.js';

const modules=new WeakMap<BaseAudioContext,Map<string,Promise<void>>>();
function clone(value:OutputMeterSnapshot):OutputMeterSnapshot {
  return {...value,peak:[...value.peak],rms:[...value.rms],heldPeak:[...value.heldPeak],clipped:[...value.clipped]};
}

/** The app supplies a bundled module URL; the engine itself remains bundler-independent. */
export async function createWorkletOutputStage(context:AudioContext,moduleUrl:string):Promise<MixerOutputStage> {
  if(!context.audioWorklet||typeof AudioWorkletNode!=='function')throw new Error('This browser cannot start the output processor.');
  let loaded=modules.get(context);
  if(!loaded){loaded=new Map();modules.set(context,loaded);}
  let pending=loaded.get(moduleUrl);
  if(!pending){pending=context.audioWorklet.addModule(moduleUrl);loaded.set(moduleUrl,pending);}
  try{await pending;}catch(error){if(loaded.get(moduleUrl)===pending)loaded.delete(moduleUrl);throw error;}
  if(context.state==='closed')throw new Error('The audio context was closed before the output processor loaded.');
  const node=new AudioWorkletNode(context,OUTPUT_WORKLET_NAME,{numberOfInputs:1,numberOfOutputs:1,
    outputChannelCount:[2],channelCount:2,channelCountMode:'explicit',channelInterpretation:'discrete'});
  let disposed=false;
  let resetEpoch=0;
  let snapshot:OutputMeterSnapshot={...emptyOutputMeterSnapshot(),available:true};
  const listeners=new Set<(value:OutputMeterSnapshot)=>void>();
  const notify=()=>{for(const listener of listeners)listener(clone(snapshot));};
  const send=(message:OutputWorkletControl)=>{if(!disposed)node.port.postMessage(message);};
  node.port.onmessage=(event:MessageEvent<{type:'meter';epoch:number;snapshot:OutputMeterSnapshot}>)=>{
    if(disposed||event.data.type!=='meter')return;
    send({type:'meter-ack'});
    if(event.data.epoch!==resetEpoch||snapshot.error)return;
    snapshot=clone(event.data.snapshot);notify();
  };
  node.onprocessorerror=()=>{
    if(disposed)return;
    snapshot={...snapshot,available:false,peak:[0,0],rms:[0,0],gainReductionDb:0,
      error:'The output processor stopped. Reload this session to start audio again.'};
    notify();
  };
  return {
    node,
    listeningGain:node.parameters.get('listeningGain')!,
    setLimiter(settings:OutputLimiterSettings|undefined,smooth:boolean){
      if(disposed)return;
      const now=context.currentTime;
      node.parameters.get('enabled')!.setValueAtTime(settings?.enabled?1:0,now);
      node.parameters.get('ceilingDb')!.setValueAtTime(settings?.ceilingDb??-1,now);
      node.parameters.get('smooth')!.setValueAtTime(smooth?1:0,now);
    },
    subscribe(listener){if(!disposed){listeners.add(listener);listener(clone(snapshot));}return()=>{listeners.delete(listener);};},
    resetPeaks(){send({type:'reset-peaks'});},
    reset(){
      if(disposed)return;
      resetEpoch=resetEpoch===16_777_215?1:resetEpoch+1;
      node.parameters.get('resetEpoch')!.setValueAtTime(resetEpoch,context.currentTime);
      snapshot={...emptyOutputMeterSnapshot(),available:true};notify();
    },
    dispose(){
      if(disposed)return;
      send({type:'dispose'});disposed=true;node.disconnect();node.port.onmessage=null;
      node.onprocessorerror=null;node.port.close();listeners.clear();
    },
  };
}
