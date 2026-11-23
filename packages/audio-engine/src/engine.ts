import { applyCommand, parseScene, playbackAssetIds, scenePlaybackAssetIds, sceneLayerCount, SceneValidationError, listeningDuration, type CapturedMix, type EqualizerSettings, type Layer, type ListeningTimerSettings, type Scene, type SceneCommand } from '@asmr-studio/contracts';
import {createOccasionalSchedule,OCCASIONAL_SAMPLE_RATE,type OccasionalEvent} from './occasional.js';
import { loopExtraBytes, prepareLoop, type PreparedLoop } from './loops.js';
import {EQ_BANDS} from './equalizer.js';
import {emptyOutputMeterSnapshot,type OutputMeterSnapshot} from './output-processor.js';
import {LayerMovement,movementParameters} from './movement.js';
import {holdLinearAutomation} from './automation.js';
import {ListeningTimerController} from './listening-timer-controller.js';
import {TransitionController} from './transition-controller.js';
import type { Mixer, MixerOptions, MixerOutputStage, PlaybackSnapshot, PlaybackState } from './types.js';
interface EnvelopePoint { time:number; value:number }
interface LayerPlayback {
  envelope:GainNode;
  eventPan:StereoPannerNode|null;
  sources:Map<AudioBufferSourceNode,number>;
  end:number;
  points:EnvelopePoint[];
  loop:{key:string;prepared:PreparedLoop}|null;
  stopping:boolean;
}
interface PreparedPlayback {start():void;dispose():void}
interface EqualizerGraph { filters:BiquadFilterNode[]; targets:number[] }
interface OccasionalQueue { schedule:ReturnType<typeof createOccasionalSchedule>; lastIndex:number; through:number }
type SideId='a'|'b';
interface SideBus {
  id:SideId;capture:CapturedMix;equalizer:EqualizerGraph;gain:GainNode;blend:GainNode;
  stage:MixerOutputStage|null;fallback:GainNode|null;listening:ListeningTimerController;
  unsubscribe:()=>void;graphs:Set<LayerGraph>;accepted:boolean;retiring:boolean;disposed:boolean;error:string|null;
}
interface LayerOwner {key:string;layer:Layer;owner:Scene;side:SideId|null}
interface LayerGraph { side:SideBus|null; occasional:OccasionalQueue|null; equalizer:EqualizerGraph; gain:GainNode; pan:StereoPannerNode; movement:LayerMovement; playbacks:Set<LayerPlayback> }
const RAMP_SECONDS = 0.02;
const OCCASIONAL_LOOKAHEAD_SECONDS = 1;

function levelAt(points:EnvelopePoint[],time:number):number {
  let previous = points[0]!;
  if (time <= previous.time) return previous.value;
  for (const point of points.slice(1)) {
    if (time < point.time) return previous.value+(point.value-previous.value)*(time-previous.time)/(point.time-previous.time);
    previous = point;
  }
  return previous.value;
}

export function createMixer(options:MixerOptions):Mixer {
  const {context,loadAsset,decodedBudgetBytes} = options;
  if (!Number.isSafeInteger(decodedBudgetBytes) || decodedBudgetBytes <= 0) throw new SceneValidationError('A positive decoded-memory budget is required');
  const offline = 'startRendering' in context;
  const master = context.createGain();
  const meter = context.createAnalyser();
  master.connect(meter); meter.connect(context.destination);
  let outputStage:MixerOutputStage|null=null;
  let listening:ListeningTimerController|null=null;
  let listeningFallback:GainNode|null=null;
  let pendingOutputStage:Promise<void>|null=null;
  let unsubscribeOutputStage:(()=>void)|null=null;
  let outputSnapshot=emptyOutputMeterSnapshot();
  const outputListeners=new Set<(snapshot:OutputMeterSnapshot)=>void>();
  let masterEqualizer:EqualizerGraph|null = null;
  let scene:Scene|null = null;
  let desiredScene:Scene|null = null;
  let state:PlaybackState = 'idle';
  let error:string|null = null;
  let position = 0;
  let startedAt = 0;
  let generation = 0;
  let editGeneration = 0;
  let disposed = false;
  let pendingPlay:Promise<void>|null = null;
  let cancelTick:(()=>void)|null = null;
  let buffers = new Map<string,AudioBuffer>();
  let loops = new Map<string,PreparedLoop>();
  const pendingAssets = new Map<string,Promise<AudioBuffer>>();
  const graphs = new Map<string,LayerGraph>();
  const retiringGraphs = new Set<LayerGraph>();
  let sideBuses=new Map<SideId,SideBus>();
  const retiringSides=new Set<SideBus>();
  const transition=new TransitionController(context);
  const listeners = new Set<(snapshot:PlaybackSnapshot)=>void>();
  const currentPosition = () => state === 'playing' ? position + Math.max(0,context.currentTime-startedAt) : position;
  const notify = () => {
    const elapsed=currentPosition();
    const timing=listening?.snapshot(elapsed,state);
    const blending=transition.snapshot(elapsed);
    const snapshot:PlaybackSnapshot = {state,positionSeconds:elapsed,loadedAssetIds:[...buffers.keys()],error,...(timing?{listeningTimer:timing}:{}),...(blending?{transition:blending}:{})};
    for (const listener of listeners) listener({...snapshot,loadedAssetIds:[...snapshot.loadedAssetIds],
      ...(snapshot.listeningTimer?{listeningTimer:{...snapshot.listeningTimer}}:{}),...(snapshot.transition?{transition:{...snapshot.transition}}:{})});
  };
  function ownedLayers(owner:Scene):LayerOwner[] {
    if(!owner.transition)return owner.layers.map(layer=>({key:layer.id,layer,owner,side:null}));
    return (['a','b'] as const).flatMap(side=>{
      const capture=owner.transition![side];
      return capture?capture.scene.layers.map(layer=>({key:JSON.stringify([side,capture.id,layer.id]),layer,owner:capture.scene,side})):[];
    });
  }
  function assertAlive():void { if (disposed) throw new Error('This mixer has been disposed'); }
  function assertCurrent(isCurrent:(()=>boolean)|undefined):void {
    if(isCurrent&&!isCurrent())throw new SceneValidationError('The playback request is no longer current');
  }
  function cloneOutput(value:OutputMeterSnapshot):OutputMeterSnapshot {
    return {...value,peak:[...value.peak],rms:[...value.rms],heldPeak:[...value.heldPeak],clipped:[...value.clipped]};
  }
  function notifyOutput():void {for(const listener of outputListeners)listener(cloneOutput(outputSnapshot));}
  function requireOutputStage(next:Scene):void {
    if(next.outputLimiter?.enabled&&!outputStage)throw new SceneValidationError('An output processor is required to enable the peak limiter');
  }
  function receiveOutput(value:OutputMeterSnapshot):void {
    if(disposed)return;
    outputSnapshot=cloneOutput(value);
    if(value.error&&state!=='error'){
      generation++;pendingPlay=null;clearPlayback();state='error';error=value.error;notify();
    }
    notifyOutput();
  }
  async function prepareOutputStage():Promise<void> {
    if(outputStage||!options.createOutputStage)return;
    if(pendingOutputStage)return pendingOutputStage;
    const pending=Promise.resolve().then(()=>options.createOutputStage!(context)).then(stage=>{
      if(disposed){stage.dispose();return;}
      try{
        stage.node.connect(meter);
        master.disconnect();master.connect(stage.node);
        outputStage=stage;listening=new ListeningTimerController(context,stage.listeningGain);outputSnapshot={...emptyOutputMeterSnapshot(),available:true};
        let initializing=true;
        unsubscribeOutputStage=stage.subscribe(value=>{
          if(initializing){outputSnapshot=cloneOutput(value);notifyOutput();}
          else receiveOutput(value);
        });
        initializing=false;
        if(outputSnapshot.error)throw new SceneValidationError(outputSnapshot.error);
        notifyOutput();
      }catch(failure){
        outputStage=null;listening=null;unsubscribeOutputStage?.();unsubscribeOutputStage=null;
        master.disconnect();master.connect(meter);stage.dispose();throw failure;
      }
    });
    pendingOutputStage=pending;
    try{await pending;}finally{if(pendingOutputStage===pending)pendingOutputStage=null;}
  }
  function prepareListening(next:Scene):()=>void {
    if(listening||!next.listeningTimer)return()=>{};
    const gain=context.createGain();
    try{
      gain.gain.setValueAtTime(1,context.currentTime);
      const controller=new ListeningTimerController(context,gain.gain);
      gain.connect(meter);master.disconnect();master.connect(gain);
      listeningFallback=gain;listening=controller;
      return()=>{if(listening===controller){gain.disconnect();master.disconnect();master.connect(meter);listening=null;listeningFallback=null;}};
    }catch(error){gain.disconnect();master.disconnect();master.connect(meter);throw error;}
  }
  function stopTimer():void { cancelTick?.(); cancelTick=null; }
  function disconnectEqualizer(equalizer:EqualizerGraph):void {
    for (const filter of equalizer.filters) filter.disconnect();
  }
  function clearMasterEqualizer():void {
    if (masterEqualizer) disconnectEqualizer(masterEqualizer);
    masterEqualizer = null;
  }
  function disposeSide(side:SideBus):void {
    if(side.disposed)return;side.disposed=true;side.accepted=false;
    side.unsubscribe();side.listening.pause();side.stage?.dispose();side.fallback?.disconnect();
    disconnectEqualizer(side.equalizer);side.gain.disconnect();side.blend.disconnect();retiringSides.delete(side);
  }
  function finishSide(side:SideBus):void {if(side.retiring&&side.graphs.size===0)disposeSide(side);}
  function retireSide(side:SideBus):void {side.retiring=true;retiringSides.add(side);finishSide(side);}
  function clearSides():void {
    transition.clear();
    for(const side of new Set([...sideBuses.values(),...retiringSides]))retireSide(side);
    sideBuses.clear();
  }
  function finishGraph(graph:LayerGraph):void {
    if (graph.playbacks.size === 0 && retiringGraphs.delete(graph)) {
      graph.movement.dispose();disconnectEqualizer(graph.equalizer); graph.gain.disconnect(); graph.pan.disconnect();
      if(graph.side){graph.side.graphs.delete(graph);finishSide(graph.side);}
    }
  }
  function finishSource(graph:LayerGraph,playback:LayerPlayback,source:AudioBufferSourceNode):void {
    source.onended = null; source.disconnect(); source.buffer = null; playback.sources.delete(source);
    if (playback.sources.size === 0) { playback.envelope.disconnect(); playback.eventPan?.disconnect(); graph.playbacks.delete(playback); finishGraph(graph); }
  }
  function discardSource(graph:LayerGraph,playback:LayerPlayback,source:AudioBufferSourceNode):void {
    try { source.stop(); } catch { /* An already-ended source is safe to retire. */ }
    finishSource(graph,playback,source);
  }
  function clearLayerPlayback(graph:LayerGraph,playback:LayerPlayback):void {
    for (const source of playback.sources.keys()) discardSource(graph,playback,source);
  }
  function releaseLayerPlayback(graph:LayerGraph,playback:LayerPlayback):void {
    if (playback.stopping) return;
    const now = context.currentTime;
    const value = levelAt(playback.points,now);
    if (value === 0 || (!offline && context.state !== 'running')) { clearLayerPlayback(graph,playback); return; }
    playback.stopping = true;
    const end = Math.min(now+RAMP_SECONDS,playback.end);
    // Capture the scheduled level even during an attack or a natural release.
    const gain = playback.envelope.gain;
    holdLinearAutomation(gain,value,now); gain.setValueAtTime(value,now); gain.linearRampToValueAtTime(0,end);
    playback.points = [{time:now,value},{time:end,value:0}];
    for (const [source,when] of playback.sources) {
      if (when >= end) discardSource(graph,playback,source);
      else source.stop(end);
    }
  }
  function retireGraph(graph:LayerGraph,smooth=false):void {
    graph.occasional=null;
    retiringGraphs.add(graph);
    for (const playback of graph.playbacks) {
      if (smooth) releaseLayerPlayback(graph,playback); else clearLayerPlayback(graph,playback);
    }
    finishGraph(graph);
  }
  function clearGraphs():void {
    for (const graph of [...graphs.values(),...retiringGraphs]) retireGraph(graph);
    graphs.clear();
  }
  function clearPlayback(smooth=false,resetMovement=false):void {
    stopTimer();
    transition.pause();
    for(const side of new Set([...sideBuses.values(),...retiringSides]))side.listening.pause();
    for (const graph of [...graphs.values(),...retiringGraphs]) {
      graph.occasional=null;graph.movement.pause(resetMovement);
      for (const playback of graph.playbacks) {
        if (smooth) releaseLayerPlayback(graph,playback); else clearLayerPlayback(graph,playback);
      }
    }
  }
  function timelineEnd(owner:Scene|null=scene,assets=buffers):number {
    if (!owner) return 0;
    if(owner.transition){
      const settings=owner.transition;
      // Finite sources keep their own gates. Let a later timed fade finish in
      // silence so natural completion holds its B endpoint instead of rewinding.
      const fadeEnd=settings.a&&settings.b&&settings.mode==='timed'?settings.startSeconds+settings.durationSeconds:0;
      return Math.max(fadeEnd,...(['a','b'] as const).map(side=>{
        const capture=settings[side];return capture?timelineEnd(capture.scene,assets):0;
      }));
    }
    const duration=listeningDuration(owner.listeningTimer,owner.durationSeconds);
    if (duration !== null) return duration;
    if (owner.layers.some(layer=>layer.occasional?.enabled || layer.loop !== null)) return Infinity;
    return Math.max(0,...owner.layers.map(layer=>layer.startSeconds+(assets.get(layer.assetId)?.duration ?? 0)));
  }
  function completeIfDue():boolean {
    if(state!=='playing'||!scene)return false;
    const deadline=listening?.deadlineTime;
    const due=scene.listeningTimer?.enabled?deadline!==null&&deadline!==undefined&&context.currentTime>=deadline:currentPosition()>=timelineEnd();
    if(!due)return false;
    const endpoint=timelineEnd();generation++;pendingPlay=null;clearPlayback(false,true);listening?.pause();
    if(scene.listeningTimer?.enabled){listening?.finish();position=endpoint;}else position=scene.transition?endpoint:0;
    state='ready';configureTransition(false,true);notify();return true;
  }
  function hasAudibleTail():boolean {
    return [...graphs.values(),...retiringGraphs].some(graph=>[...graph.playbacks].some(playback=>levelAt(playback.points,context.currentTime)>0&&context.currentTime<playback.end));
  }
  function ramp(param:AudioParam,value:number,now=context.currentTime):void {
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
    else { param.cancelScheduledValues(now); param.setValueAtTime(param.value,now); }
    param.linearRampToValueAtTime(value,now+RAMP_SECONDS);
  }
  function equalizerGain(settings:EqualizerSettings|undefined,index:number):number {
    return !settings || settings.bypassed ? 0 : Math.fround(settings[EQ_BANDS[index]!.key]);
  }
  function createEqualizer(settings:EqualizerSettings|undefined):EqualizerGraph {
    const filters:BiquadFilterNode[] = [];
    const targets:number[] = [];
    try {
      for (const [index,band] of EQ_BANDS.entries()) {
        const filter = context.createBiquadFilter(); filters.push(filter);
        filter.type = band.type;
        const value = equalizerGain(settings,index);
        // At zero gain, the frequency-zero limit is exact unity for all three bands.
        // A regular zero-gain biquad can retain floating-point residue after silence.
        filter.frequency.setValueAtTime(value === 0 ? 0 : Math.min(band.frequency,context.sampleRate/2),context.currentTime);
        filter.detune.setValueAtTime(0,context.currentTime);
        if (band.Q !== undefined) filter.Q.setValueAtTime(band.Q,context.currentTime);
        filter.gain.setValueAtTime(value,context.currentTime); targets.push(value);
        filters[index-1]?.connect(filter);
      }
      return {filters,targets};
    } catch (failure) {
      for (const filter of filters) filter.disconnect();
      throw failure;
    }
  }
  function updateEqualizer(equalizer:EqualizerGraph,settings:EqualizerSettings|undefined,smooth:boolean):void {
    const now = context.currentTime;
    for (const [index,filter] of equalizer.filters.entries()) {
      const value = equalizerGain(settings,index);
      if (smooth && equalizer.targets[index] === value) continue;
      const frequency = Math.min(EQ_BANDS[index]!.frequency,context.sampleRate/2);
      // An interrupted return to flat must not switch an active band to zero later.
      filter.frequency.cancelScheduledValues(now);
      if (smooth) {
        filter.frequency.setValueAtTime(frequency,now);
        ramp(filter.gain,value,now);
        if (value === 0) filter.frequency.setValueAtTime(0,now+RAMP_SECONDS);
      } else {
        filter.frequency.setValueAtTime(value === 0 ? 0 : frequency,now);
        filter.gain.cancelScheduledValues(now); filter.gain.setValueAtTime(value,now);
      }
      equalizer.targets[index] = value;
    }
  }
  function audibleGain(layer:Layer,owner:Scene|null=scene):number {
    const soloActive = owner?.layers.some(candidate=>candidate.solo) ?? false;
    return layer.muted || (soloActive && !layer.solo) ? 0 : layer.gain;
  }
  function sideTimer(owner:Scene,assets:Map<string,AudioBuffer>):ListeningTimerSettings|undefined {
    if(owner.listeningTimer?.enabled)return owner.listeningTimer;
    const endpoint=timelineEnd(owner,assets);
    // A finite captured source contributes exact silence after its own endpoint,
    // including EQ/limiter tails, while the other source continues its clock.
    return Number.isFinite(endpoint)?{enabled:true,durationSeconds:endpoint,fadeInSeconds:0,fadeOutSeconds:0}:undefined;
  }
  async function createSide(id:SideId,capture:CapturedMix,assets:Map<string,AudioBuffer>,isCurrent?:()=>boolean):Promise<SideBus> {
    const destination=masterEqualizer!.filters[0]!;
    const equalizer=createEqualizer(capture.scene.masterEqualizer);
    let gain:GainNode|undefined,blend:GainNode|undefined,fallback:GainNode|null=null,stage:MixerOutputStage|null=null;
    let bus:SideBus|undefined;
    try{
      gain=context.createGain();blend=context.createGain();
      gain.gain.setValueAtTime(capture.scene.masterGain,context.currentTime);blend.gain.setValueAtTime(0,context.currentTime);
      if(capture.scene.outputLimiter?.enabled){
        if(!options.createOutputStage)throw new SceneValidationError('An output processor is required to enable a captured mix peak limiter');
        stage=await options.createOutputStage(context);assertCurrent(isCurrent);
        stage.reset();stage.setLimiter(capture.scene.outputLimiter,false);
      }else{fallback=context.createGain();fallback.gain.setValueAtTime(1,context.currentTime);}
      const timing=new ListeningTimerController(context,stage?.listeningGain??fallback!.gain);
      timing.reset(sideTimer(capture.scene,assets));
      equalizer.filters.at(-1)!.connect(gain);gain.connect(stage?.node??fallback!);(stage?.node??fallback!).connect(blend);
      blend.connect(destination);
      bus={id,capture,equalizer,gain,blend,stage,fallback,listening:timing,unsubscribe:()=>{},graphs:new Set(),accepted:false,retiring:false,disposed:false,error:null};
      if(stage){
        const owned=bus;
        bus.unsubscribe=stage.subscribe(value=>{
          if(!value.error||owned.disposed)return;
          owned.error=value.error;
          if(owned.accepted&&!disposed)receiveOutput({...outputSnapshot,available:false,error:value.error});
        });
        if(bus.error)throw new SceneValidationError(bus.error);
      }
      return bus;
    }catch(failure){
      if(bus)disposeSide(bus);
      else{stage?.dispose();fallback?.disconnect();gain?.disconnect();blend?.disconnect();disconnectEqualizer(equalizer);}
      throw failure;
    }
  }
  function sameCapture(left:CapturedMix,right:CapturedMix):boolean {
    return left.id===right.id&&JSON.stringify(left)===JSON.stringify(right);
  }
  async function prepareSides(next:Scene,assets:Map<string,AudioBuffer>,isCurrent?:()=>boolean):Promise<Map<SideId,SideBus>> {
    const prepared=new Map<SideId,SideBus>();
    try{
      assertCurrent(isCurrent);
      for(const id of ['a','b'] as const){
        const capture=next.transition?.[id];if(!capture)continue;
        const old=sideBuses.get(id);
        prepared.set(id,old&&sameCapture(old.capture,capture)?old:await createSide(id,capture,assets,isCurrent));
        assertCurrent(isCurrent);
      }
      return prepared;
    }catch(failure){discardPreparedSides(prepared);throw failure;}
  }
  function discardPreparedSides(prepared:Map<SideId,SideBus>):void {
    for(const [id,side] of prepared)if(sideBuses.get(id)!==side)retireSide(side);
  }
  function configureTransition(smooth:boolean,force=false):void {
    if(!scene?.transition){transition.clear();return;}
    transition.configure(scene.transition,{a:sideBuses.get('a')?.blend.gain??null,b:sideBuses.get('b')?.blend.gain??null},
      currentPosition(),state==='playing',smooth,force);
  }
  function prepareMovementControls(next:Scene,added=new Map<string,LayerGraph>()):()=>void {
    const rollback:Array<()=>void>=[];
    try{
      for(const {key,layer} of ownedLayers(next)){
        const graph=added.get(key)??graphs.get(key);
        if(graph)rollback.push(graph.movement.prepare(layer.pan,layer.movement));
      }
    }catch(error){for(const undo of rollback.reverse())undo();throw error;}
    return()=>{for(const undo of rollback.reverse())undo();};
  }
  function updateControls(smooth:boolean):void {
    if (!scene) return;
    outputStage?.setLimiter(scene.outputLimiter,smooth);
    if (masterEqualizer) updateEqualizer(masterEqualizer,scene.masterEqualizer,smooth);
    if (smooth) ramp(master.gain,scene.masterGain); else master.gain.setValueAtTime(scene.masterGain,context.currentTime);
    for(const side of sideBuses.values()){
      updateEqualizer(side.equalizer,side.capture.scene.masterEqualizer,smooth);
      if(smooth)ramp(side.gain.gain,side.capture.scene.masterGain);else side.gain.gain.setValueAtTime(side.capture.scene.masterGain,context.currentTime);
      side.stage?.setLimiter(side.capture.scene.outputLimiter,smooth);
    }
    configureTransition(smooth);
    for (const {key,layer,owner} of ownedLayers(scene)) {
      const graph = graphs.get(key);
      if (!graph) continue;
      updateEqualizer(graph.equalizer,layer.equalizer,smooth);
      graph.movement.update(layer.pan,layer.movement,smooth);
      if (smooth) ramp(graph.gain.gain,audibleGain(layer,owner));
      else graph.gain.gain.setValueAtTime(audibleGain(layer,owner),context.currentTime);
    }
  }
  function createGraph(layer:Layer,owner:Scene,side:SideBus|null=null):LayerGraph {
    let gain:GainNode|undefined; let pan:StereoPannerNode|undefined; let equalizer:EqualizerGraph|undefined;let movement:LayerMovement|undefined;
    try {
      gain = context.createGain(); pan = context.createStereoPanner();
      equalizer = createEqualizer(layer.equalizer);
      equalizer.filters.at(-1)!.connect(gain); gain.connect(pan); pan.connect((side?.equalizer??masterEqualizer)!.filters[0]!);
      movement=new LayerMovement(context,pan.pan,layer.pan);movement.prepare(layer.pan,layer.movement);movement.update(layer.pan,layer.movement,false);
      const graph:LayerGraph = {side,equalizer,gain,pan,movement,occasional:null,playbacks:new Set<LayerPlayback>()};
      gain.gain.setValueAtTime(audibleGain(layer,owner),context.currentTime);
      side?.graphs.add(graph);
      return graph;
    } catch (failure) {
      if (equalizer) disconnectEqualizer(equalizer);
      movement?.dispose();gain?.disconnect(); pan?.disconnect();
      throw failure;
    }
  }
  function key(layer:Layer):string { return JSON.stringify(layer.occasional?.enabled?[layer.assetId,layer.occasional]:[layer.assetId,layer.loop]); }
  function validateBuffer(buffer:AudioBuffer):AudioBuffer {
    if (![1,2].includes(buffer.numberOfChannels) || buffer.length <= 0 || !Number.isFinite(buffer.duration) || buffer.duration <= 0) {
      throw new SceneValidationError('The mixer accepts valid mono or stereo decoded audio');
    }
    return buffer;
  }
  function load(id:string):Promise<AudioBuffer> {
    const existing = pendingAssets.get(id);
    if (existing) return existing;
    const promise = Promise.resolve().then(()=>loadAsset(id)).then(validateBuffer).finally(()=>{
      if (pendingAssets.get(id) === promise) pendingAssets.delete(id);
    });
    pendingAssets.set(id,promise);
    return promise;
  }
  function prepareLoops(next:Scene,assets:Map<string,AudioBuffer>,previous:Map<string,PreparedLoop>):Map<string,PreparedLoop> {
    const held = new Set(assets.values()); const reusable = new Map(previous);
    for (const graph of [...graphs.values(),...retiringGraphs]) for (const playback of graph.playbacks) {
      for (const source of playback.sources.keys()) if (source.buffer) held.add(source.buffer);
      if (playback.loop) { held.add(playback.loop.prepared.buffer); reusable.set(playback.loop.key,playback.loop.prepared); }
    }
    const size = (buffer:AudioBuffer) => buffer.length*buffer.numberOfChannels*4;
    let bytes = [...held].reduce((sum,buffer)=>sum+size(buffer),0);
    const checkBudget = () => {
      if (!Number.isSafeInteger(bytes) || bytes > decodedBudgetBytes) throw new SceneValidationError('Loop buffers exceed the decoded-memory budget');
    };
    checkBudget();
    const prepared = new Map<string,PreparedLoop>();
    for (const {layer} of ownedLayers(next)) {
      if (layer.occasional?.enabled || !layer.loop || prepared.has(key(layer))) continue;
      const buffer = assets.get(layer.assetId);
      if (!buffer) throw new SceneValidationError('The layer asset has not been loaded');
      const extra = loopExtraBytes(buffer,layer.loop);
      const existing = reusable.get(key(layer));
      bytes += existing ? (held.has(existing.buffer) ? 0 : size(existing.buffer)) : extra;
      checkBudget(); // Include buffers held by release tails before making another allocation.
      const loop = existing ?? prepareLoop(buffer,layer.loop,(channels,length,rate)=>context.createBuffer(channels,length,rate));
      held.add(loop.buffer); prepared.set(key(layer),loop);
    }
    return prepared;
  }
  /** Allocate all replacement nodes while their envelope remains disconnected. */
  function prepareSource(layer:Layer,graph:LayerGraph,at:number,owner:Scene,assets:Map<string,AudioBuffer>,preparedLoops:Map<string,PreparedLoop>,event?:OccasionalEvent):PreparedPlayback|null {
    const buffer=assets.get(event?.assetId??layer.assetId);
    if(!buffer)throw new SceneValidationError('The layer asset has not been loaded');
    const start=event?event.startFrame/OCCASIONAL_SAMPLE_RATE:layer.startSeconds;
    const elapsed=Math.max(0,at-start);
    const when=context.currentTime+Math.max(0,start-at);
    const loop=!event&&layer.loop?preparedLoops.get(key(layer)):undefined;
    const recipeEnd=event?Math.min(timelineEnd(owner,assets),event.endFrame/OCCASIONAL_SAMPLE_RATE):timelineEnd(owner,assets);
    const duration=Math.min(recipeEnd-Math.max(at,start),loop?Infinity:buffer.duration-elapsed);
    if(duration<=0)return null;
    const end=when+duration,fade=Math.min(RAMP_SECONDS,duration/2);
    const envelope=context.createGain();
    // Keep a fresh envelope silent before its first automation sample,
    // including WebKit's fractional sample-boundary rounding.
    envelope.gain.value=0;
    let eventPan:StereoPannerNode|null=null;
    const sources:Array<{source:AudioBufferSourceNode;when:number;offset:number;duration?:number}>=[];
    let playback:LayerPlayback|null=null;
    const dispose=()=>{
      if(playback){clearLayerPlayback(graph,playback);playback=null;}
      else for(const {source} of sources){try{source.stop();}catch{}source.disconnect();source.buffer=null;}
      envelope.disconnect();eventPan?.disconnect();
    };
    const add=(buffer:AudioBuffer,start:number,offset:number,repeated:PreparedLoop|null,length?:number)=>{
      if(start>=end)return;
      const source=context.createBufferSource();sources.push({source,when:start,offset,...(length===undefined?{}:{duration:length})});source.buffer=buffer;
      if(repeated){source.loop=true;source.loopStart=repeated.offsetBaseSeconds;source.loopEnd=repeated.offsetBaseSeconds+repeated.periodSeconds;}
      source.connect(envelope);
    };
    try{
      envelope.gain.setValueAtTime(0,context.currentTime);
      if(event){eventPan=context.createStereoPanner();eventPan.pan.setValueAtTime(event.pan,when);envelope.connect(eventPan);}
      if(!loop)add(buffer,when,elapsed,null);
      else if(elapsed<loop.introSeconds){
        const remaining=loop.introSeconds-elapsed;
        add(buffer,when,loop.originalStartSeconds+elapsed,null,remaining);
        add(loop.buffer,when+remaining,loop.offsetBaseSeconds,loop);
      }else add(loop.buffer,when,loop.offsetBaseSeconds+(elapsed-loop.introSeconds)%loop.periodSeconds,loop);
    }catch(error){dispose();throw error;}
    return {dispose,start(){
      const outgoing=[...graph.playbacks].filter(previous=>previous.stopping&&levelAt(previous.points,when)>0);
      const outgoingLevel=(time:number)=>outgoing.reduce((sum,previous)=>sum+levelAt(previous.points,time),0);
      const peak=event?.gain??1;
      const target:EnvelopePoint[]=[{time:when,value:Math.min(peak,outgoingLevel(when))},{time:when+fade,value:peak}];
      if(Number.isFinite(end)){if(end-fade>when+fade)target.push({time:end-fade,value:peak});target.push({time:end,value:0});}
      const times=new Set(target.map(point=>point.time));
      for(const previous of outgoing)for(const point of previous.points)if(point.time>when&&point.time<end)times.add(point.time);
      const points=[...times].sort((a,b)=>a-b).map(time=>({time,value:Math.max(0,levelAt(target,time)-outgoingLevel(time))}));
      const accepted:LayerPlayback={envelope,eventPan,sources:new Map(),end,points,loop:loop?{key:key(layer),prepared:loop}:null,stopping:false};
      playback=accepted;graph.playbacks.add(accepted);(eventPan??envelope).connect(graph.equalizer.filters[0]!);
      envelope.gain.setValueAtTime(points[0]!.value,when);
      for(const point of points.slice(1))envelope.gain.linearRampToValueAtTime(point.value,point.time);
      try{
        for(const item of sources){
          const {source}=item;accepted.sources.set(source,item.when);source.onended=()=>finishSource(graph,accepted,source);
          if(item.duration===undefined)source.start(item.when,item.offset);else source.start(item.when,item.offset,item.duration);
          if(Number.isFinite(end))source.stop(end);
        }
      }catch(error){dispose();throw error;}
    }};
  }
  function prepareWindow(queue:OccasionalQueue,layer:Layer,graph:LayerGraph,at:number,owner:Scene,assets:Map<string,AudioBuffer>,prepared:Map<string,PreparedLoop>):PreparedPlayback {
    const through=Math.min(at+OCCASIONAL_LOOKAHEAD_SECONDS,timelineEnd(owner,assets));
    const batch:PreparedPlayback[]=[];
    let lastIndex=queue.lastIndex;
    try {
      // Seek directly to the live window after a throttled tick. An event that
      // straddles the previous horizon was already submitted to the audio clock.
      const from=Math.max(at,queue.through);
      if(from<through)for(const event of queue.schedule.events(from,through)){
        if(event.index<=lastIndex)continue;
        lastIndex=event.index;
        const playback=prepareSource(layer,graph,at,owner,assets,prepared,event);
        if(playback)batch.push(playback);
      }
    }catch(error){for(const item of batch)item.dispose();throw error;}
    const dispose=()=>{for(const item of batch)item.dispose();};
    return {dispose,start(){
      try{for(const item of batch)item.start();}
      catch(error){dispose();throw error;}
      queue.lastIndex=lastIndex;queue.through=through;
    }};
  }
  function prepareLayer(layer:Layer,graph:LayerGraph,at:number,owner:Scene=scene!,assets=buffers,prepared=loops):PreparedPlayback|null {
    if(!layer.occasional?.enabled)return prepareSource(layer,graph,at,owner,assets,prepared);
    const durations=new Map(playbackAssetIds(layer).map(id=>[id,graph.side?.capture.assets.find(asset=>asset.id===id)?.durationSeconds
      ??options.assetDurationSeconds?.(id)??assets.get(id)!.duration] as const));
    const queue={schedule:createOccasionalSchedule(layer,durations),lastIndex:-1,through:at};
    const window=prepareWindow(queue,layer,graph,at,owner,assets,prepared);
    return {dispose:window.dispose,start(){window.start();graph.occasional=queue;}};
  }
  function tick():void {
    if(state!=='playing'||completeIfDue()||!scene)return;
    const at=currentPosition();
    try{
      for(const {key,layer,owner} of ownedLayers(scene)){
        const graph=graphs.get(key)!;
        if(graph.occasional)prepareWindow(graph.occasional,layer,graph,at,owner,buffers,loops).start();
      }
    }catch(failure){
      generation++;pendingPlay=null;position=at;clearPlayback();listening?.pause();state='error';
      error=failure instanceof Error?failure.message:'The occasional sound could not be scheduled';
    }
    notify();
  }
  function reconcileLoaded(next:Scene,loaded:Map<string,AudioBuffer>,preparedSides=sideBuses,isCurrent?:()=>boolean):void {
    // Decoding can finish after the audio clock has already silenced this mix.
    // Retire that session before accepting the edit, without reviving playback.
    completeIfDue();
    requireOutputStage(next);
    const needed = new Set(scenePlaybackAssetIds(next));
    const retained = new Map([...loaded].filter(([id])=>needed.has(id)));
    for (const id of needed) if (!retained.has(id)) throw new SceneValidationError('Load new assets with updateScene before adding them to playback');
    // All validation and allocation precede any audible change, including accounting for release tails.
    const prepared = prepareLoops(next,retained,loops);
    const added = new Map<string,LayerGraph>();
    const old = scene; const at = currentPosition();
    const previousLayers=new Map((old?ownedLayers(old):[]).map(value=>[value.key,value]));
    const nextLayers=ownedLayers(next);
    for(const id of ['a','b'] as const){
      const capture=next.transition?.[id];
      if(capture&&(!preparedSides.has(id)||!sameCapture(preparedSides.get(id)!.capture,capture)))
        throw new SceneValidationError('Load captured mixes with updateScene before changing their playback');
      if(capture&&preparedSides.get(id)!.error)throw new SceneValidationError(preparedSides.get(id)!.error!);
    }
    let rollbackMovement=()=>{},rollbackListening=()=>{};
    const starts=new Map<string,()=>void>(),playbacks=new Map<string,PreparedPlayback>();
    try {
      for (const {key,layer,owner,side} of nextLayers) {
        const bus=side?preparedSides.get(side)!:null;
        if(!graphs.has(key)||graphs.get(key)!.side!==bus)added.set(key,createGraph(layer,owner,bus));
      }
      rollbackMovement=prepareMovementControls(next,added);
      rollbackListening=prepareListening(next);
      if(state==='playing')for(const {key:graphKey,layer,owner} of nextLayers){
        const previous=added.has(graphKey)?undefined:previousLayers.get(graphKey)?.layer;
        const previousOwner=previousLayers.get(graphKey)?.owner;
        const durationChanged=!!previousOwner&&listeningDuration(previousOwner.listeningTimer,previousOwner.durationSeconds)!==listeningDuration(owner.listeningTimer,owner.durationSeconds);
        if(!previous||previous.startSeconds!==layer.startSeconds){
          const graph=added.get(graphKey)??graphs.get(graphKey)!;
          starts.set(graphKey,graph.movement.prepareStart(Math.max(0,at-layer.startSeconds),Math.max(0,layer.startSeconds-at),true,movementParameters(layer.pan,layer.movement)));
        }
        if(!previous||key(previous)!==key(layer)||previous.startSeconds!==layer.startSeconds||durationChanged){
          const graph=added.get(graphKey)??graphs.get(graphKey)!;
          const preparedPlayback=prepareLayer(layer,graph,at,owner,retained,prepared);
          if(preparedPlayback)playbacks.set(graphKey,preparedPlayback);
        }
      }
      assertCurrent(isCurrent);
    } catch (failure) {
      for(const playback of playbacks.values())playback.dispose();
      rollbackMovement();rollbackListening();
      for (const graph of added.values()) retireGraph(graph);
      throw failure;
    }
    const oldSides=sideBuses;
    scene = next; buffers = retained; loops = prepared;
    sideBuses=new Map([...preparedSides].filter(([id])=>next.transition?.[id]));
    for(const side of sideBuses.values())side.accepted=true;
    for (const previous of previousLayers.values()) if (!nextLayers.some(layer=>layer.key===previous.key)||added.has(previous.key)) {
      const graph = graphs.get(previous.key);
      if (graph) retireGraph(graph,true);
      graphs.delete(previous.key);
    }
    for(const [id,side] of oldSides)if(sideBuses.get(id)!==side)retireSide(side);
    for(const [id,side] of sideBuses)if(oldSides.get(id)!==side&&state==='playing')side.listening.start(at);
    for (const {key:graphKey,layer,owner} of nextLayers) {
      const previous = added.has(graphKey)?undefined:previousLayers.get(graphKey)?.layer;
      const previousOwner=previousLayers.get(graphKey)?.owner;
      const durationChanged=!!previousOwner&&listeningDuration(previousOwner.listeningTimer,previousOwner.durationSeconds)!==listeningDuration(owner.listeningTimer,owner.durationSeconds);
      const graph = graphs.get(graphKey);
      if (!graph) {
        const created = added.get(graphKey)!; graphs.set(graphKey,created);
        if (state === 'playing') {starts.get(graphKey)?.();playbacks.get(graphKey)?.start();}
      } else if (previous && (key(previous)!==key(layer) || previous.startSeconds!==layer.startSeconds || durationChanged)) {
        // Retiming while paused preserves the held pan/release, but the next Play
        // initializes the new offset just as a retiming during playback does.
        if(state!=='playing'&&previous.startSeconds!==layer.startSeconds)graph.movement.pause(true);
        graph.occasional=null;
        for (const playback of graph.playbacks) releaseLayerPlayback(graph,playback);
        if (state === 'playing') {starts.get(graphKey)?.();playbacks.get(graphKey)?.start();}
      }
    }
    listening?.update(next.listeningTimer,at,state==='playing');
    updateControls(true);
  }
  function interrupted():void {
    if (offline || disposed || context.state === 'running') return;
    if (completeIfDue()) return;
    if (state === 'playing') {
      position = currentPosition(); state = 'interrupted'; generation++; pendingPlay = null; listening?.pause();clearPlayback(); notify();
    } else {listening?.pause();clearPlayback();} // A frozen audio clock must not retain a paused/stopped release tail.
  }
  context.addEventListener('statechange',interrupted);
  const mixer:Mixer = {
    async setScene(input,isCurrent) {
      assertAlive();assertCurrent(isCurrent);
      const next = parseScene(input);
      const token = ++generation; editGeneration++; pendingPlay = null; listening?.pause();clearPlayback(); clearGraphs();clearSides(); clearMasterEqualizer(); loops.clear();
      const oldBuffers = buffers; buffers = new Map(); scene = null; desiredScene = null; position = 0; state = 'loading'; error = null; notify();
      try {
        if(outputSnapshot.error&&outputStage){
          unsubscribeOutputStage?.();unsubscribeOutputStage=null;outputStage.dispose();outputStage=null;listening=null;
          master.disconnect();master.connect(meter);outputSnapshot=emptyOutputMeterSnapshot();notifyOutput();
        }
        await prepareOutputStage();
        if(token!==generation||disposed)return;
        assertCurrent(isCurrent);
        requireOutputStage(next);outputStage?.reset();prepareListening(next);listening?.reset(next.listeningTimer);
        const loaded = new Map<string,AudioBuffer>(); let bytes = 0;
        for (const id of new Set(scenePlaybackAssetIds(next))) {
          const buffer = oldBuffers.get(id) ?? await load(id);
          if (token !== generation || disposed) return;
          assertCurrent(isCurrent);
          bytes += buffer.length*buffer.numberOfChannels*4;
          if (!Number.isSafeInteger(bytes) || bytes > decodedBudgetBytes) throw new SceneValidationError('Audio exceeds the decoded-memory budget');
          loaded.set(id,buffer);
        }
        const prepared = prepareLoops(next,loaded,new Map());
        if (token !== generation || disposed) return;
        assertCurrent(isCurrent);
        masterEqualizer = createEqualizer(next.masterEqualizer);
        masterEqualizer.filters.at(-1)!.connect(master);
        const preparedSides=await prepareSides(next,loaded,isCurrent);
        if(token!==generation||disposed){discardPreparedSides(preparedSides);return;}
        try{
          assertCurrent(isCurrent);
          const sideFailure=[...preparedSides.values()].find(side=>side.error)?.error;
          if(sideFailure)throw new SceneValidationError(sideFailure);
        }catch(failure){discardPreparedSides(preparedSides);throw failure;}
        buffers = loaded; loops = prepared; scene = next; desiredScene = next;sideBuses=preparedSides;
        for(const side of sideBuses.values())side.accepted=true;
        for (const {key,layer,owner,side} of ownedLayers(scene)) graphs.set(key,createGraph(layer,owner,side?sideBuses.get(side)!:null));
        updateControls(false); state = 'ready'; notify();
      } catch (failure) {
        if (token !== generation || disposed) return;
        buffers.clear(); loops.clear(); clearGraphs();clearSides(); clearMasterEqualizer(); scene = null; desiredScene = null; state = 'error';
        error = failure instanceof SceneValidationError ? failure.message : 'The scene audio could not be loaded'; notify();
        throw failure;
      }
    },
    async updateScene(input,isCurrent) {
      assertAlive();assertCurrent(isCurrent);
      const next = parseScene(input);
      if (!scene || scene.id !== next.id) throw new SceneValidationError('Load a scene with setScene before editing its playback');
      const token = ++editGeneration;
      desiredScene = next;
      const loaded = new Map(buffers);
      try {
        // A control command can change desiredScene while a new asset is decoding. Re-read it before committing.
        while (token === editGeneration && !disposed && desiredScene) {
          assertCurrent(isCurrent);
          const target:Scene = desiredScene;
          let bytes=0;
          for (const id of new Set(scenePlaybackAssetIds(target))) {
            let buffer=loaded.get(id)??buffers.get(id);
            if(!buffer){
              try{buffer=await load(id);}
              catch(failure){
                if(token!==editGeneration||disposed)return;
                assertCurrent(isCurrent);
                if(!desiredScene||!scenePlaybackAssetIds(desiredScene).includes(id))break;
                throw failure;
              }
            }
            if (token !== editGeneration || disposed) return;
            assertCurrent(isCurrent);
            loaded.set(id,buffer);
            if(target!==desiredScene)break;
            bytes+=buffer.length*buffer.numberOfChannels*Float32Array.BYTES_PER_ELEMENT;
            if(!Number.isSafeInteger(bytes)||bytes>decodedBudgetBytes)throw new SceneValidationError('Audio exceeds the decoded-memory budget');
          }
          const current:Scene|null = desiredScene;
          if (!current) return;
          if (scenePlaybackAssetIds(current).some(id=>!loaded.has(id))) continue;
          const preparedSides=await prepareSides(current,loaded,isCurrent);
          if(token!==editGeneration||disposed){discardPreparedSides(preparedSides);return;}
          if(current!==desiredScene){discardPreparedSides(preparedSides);continue;}
          try{assertCurrent(isCurrent);reconcileLoaded(current,loaded,preparedSides,isCurrent);}
          catch(failure){discardPreparedSides(preparedSides);throw failure;}
          error = null; notify();
          return;
        }
      } catch (failure) {
        if (token !== editGeneration || disposed) return;
        // A failed addition or loop edit leaves the last playable mix and transport intact.
        desiredScene = scene;
        error = failure instanceof SceneValidationError ? failure.message : 'The new sound could not be loaded';
        notify();
        throw failure;
      }
    },
    async play(isCurrent) {
      assertAlive();assertCurrent(isCurrent);
      if(outputSnapshot.error)throw new Error(outputSnapshot.error);
      if (state === 'playing'&&!completeIfDue()) return;
      if (pendingPlay) return pendingPlay;
      if (!scene || ['loading','error','idle'].includes(state)) throw new Error('Load a valid scene before playing');
      if (sceneLayerCount(scene) === 0) throw new Error('Add a layer before playing');
      const token = generation;
      const promise = (async () => {
        if (!offline && context.state !== 'running') await context.resume();
        if (disposed || generation !== token || !scene) return;
        assertCurrent(isCurrent);
        if (!offline && context.state !== 'running') { state = 'interrupted'; notify(); return; }
        // Resume preserves an expired edit's held release. Only a completed
        // listening session is a fresh replay; legacy transport stays unchanged.
        const rewound=position>=timelineEnd()&&(!scene.listeningTimer?.enabled||state==='ready');const at=rewound?0:position;
        const entries=ownedLayers(scene);
        const starts=entries.map(({key,layer})=>graphs.get(key)!.movement.prepareStart(Math.max(0,at-layer.startSeconds),Math.max(0,layer.startSeconds-at),rewound));
        const playbacks:PreparedPlayback[]=[];
        try{
          for(const {key,layer,owner} of entries){const playback=prepareLayer(layer,graphs.get(key)!,at,owner);if(playback)playbacks.push(playback);}
          assertCurrent(isCurrent);
        }
        catch(error){for(const playback of playbacks)playback.dispose();throw error;}
        const smooth=at>0||hasAudibleTail();
        position=at;
        startedAt = context.currentTime; state = 'playing'; error = null;
        listening?.start(at,smooth);
        for(const side of sideBuses.values())side.listening.start(at,smooth);
        configureTransition(smooth,true);
        for(const start of starts)start();
        for(const playback of playbacks)playback.start();
        if(options.scheduleTick)cancelTick=options.scheduleTick(tick);
        else if(!offline){const timer=setInterval(tick,100);cancelTick=()=>clearInterval(timer);}
        notify();
      })();
      pendingPlay = promise;
      try { await promise; } finally { if (pendingPlay === promise) pendingPlay = null; }
    },
    pause() {
      assertAlive();
      if(completeIfDue())return;
      if (state !== 'playing' && !pendingPlay) return;
      listening?.pause();position = currentPosition(); state = scene ? 'paused' : 'idle'; generation++; pendingPlay = null; clearPlayback(true); notify();
    },
    stop() {
      assertAlive(); generation++; pendingPlay = null; listening?.pause();clearPlayback(true,true); position = 0; error = outputSnapshot.error;
      state = error ? 'error' : scene ? 'ready' : 'idle';configureTransition(true,true); notify();
    },
    apply(command:SceneCommand) {
      assertAlive();
      if (!scene) throw new Error('Load a scene before editing its mix');
      completeIfDue();
      const desired = applyCommand(desiredScene ?? scene,command);
      const targetsLoadedLayer = !('layerId' in command) || scene.layers.some(layer=>layer.id===command.layerId);
      const next = targetsLoadedLayer ? applyCommand(scene,command) : scene;
      requireOutputStage(next);
      if (command.type === 'addLayer' || command.type === 'removeLayer' || command.type === 'setLayerLoop' || command.type === 'setLayerOccasional' || command.type === 'setListeningTimer' || command.type === 'setTransition') reconcileLoaded(next,buffers);
      else { prepareMovementControls(next);scene = next; updateControls(true); }
      desiredScene = desired;
      notify();
    },
    subscribe(listener) {
      assertAlive(); listeners.add(listener); notify();
      return () => { listeners.delete(listener); };
    },
    subscribeOutput(listener) {
      assertAlive();outputListeners.add(listener);listener(cloneOutput(outputSnapshot));
      return()=>{outputListeners.delete(listener);};
    },
    resetOutputPeaks() {assertAlive();outputStage?.resetPeaks();},
    getDecodedAsset(id) {
      if (disposed) return undefined;
      return buffers.get(id) ?? pendingAssets.get(id)?.then(buffer=>{
        const bytes=buffer.length*buffer.numberOfChannels*Float32Array.BYTES_PER_ELEMENT;
        if (!Number.isSafeInteger(bytes) || bytes>decodedBudgetBytes) throw new SceneValidationError('Audio exceeds the decoded-memory budget');
        return buffer;
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true; generation++; editGeneration++; pendingPlay = null; clearPlayback(); clearGraphs();clearSides(); buffers.clear(); loops.clear(); pendingAssets.clear();
      clearMasterEqualizer(); listening?.pause();listeningFallback?.disconnect();listeningFallback=null;listening=null;master.disconnect(); meter.disconnect(); context.removeEventListener('statechange',interrupted);
      unsubscribeOutputStage?.();unsubscribeOutputStage=null;outputStage?.dispose();outputStage=null;
      outputSnapshot=emptyOutputMeterSnapshot();notifyOutput();outputListeners.clear();
      scene = null; desiredScene = null; state = 'idle'; position = 0; error = null; notify(); listeners.clear();
    },
  };
  return mixer;
}
