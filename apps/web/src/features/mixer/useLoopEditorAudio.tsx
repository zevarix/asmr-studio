import {useCallback,useLayoutEffect,useRef,useState} from 'react';
import {createLoopJoinPreview} from '@asmr-studio/audio-engine';
import type {AssetRecord,Loop} from '@asmr-studio/contracts';
import type {LoopAudioService} from './loop-audio-service.js';
import type {LoopPreviewState,LoopWaveformState} from './LoopEditor.js';

interface Options {
  mixActive:boolean;
  stopToken:number;
  onPreviewStart:()=>void;
}

const rampSeconds = .02;
const previewGain = .25;

export function useLoopEditorAudio(service:LoopAudioService|undefined, asset:AssetRecord|undefined,
    editorKey:string|null, options:Options) {
  const [waveform,setWaveform] = useState<LoopWaveformState>({status:'idle'});
  const [previewState,setPreviewState] = useState<LoopPreviewState>({status:'idle'});
  const [ready,setReady] = useState(false);
  const decoded = useRef<AudioBuffer|null>(null);
  const nodes = useRef<{source:AudioBufferSourceNode;gain:GainNode;context:AudioContext;start:number;end:number;fading:boolean}|null>(null);
  const generation = useRef(0);
  const input = useRef({asset,service,editorKey,options});
  useLayoutEffect(()=>{input.current={asset,service,editorKey,options};});

  const disconnect = useCallback(()=>{
    const graph = nodes.current;
    nodes.current = null;
    if (!graph) return;
    graph.source.onended = null;
    try {graph.source.stop();} catch { /* A source can fail before start. */ }
    graph.source.disconnect();
    graph.gain.disconnect();
    graph.source.buffer = null;
  },[]);
  const stopPreview = useCallback(()=>{
    generation.current++;
    disconnect();
    setPreviewState({status:'idle'});
  },[disconnect]);

  const fadePreview = useCallback(()=>{
    generation.current++;
    setPreviewState({status:'idle'});
    const graph = nodes.current;
    if (!graph || graph.fading) return;
    const now = graph.context.currentTime;
    const remaining = graph.end - now;
    if (remaining <= 0 || graph.context.state !== 'running') {disconnect(); return;}
    // Anchor the new ramp at the gain reached by the original attack or release.
    const level = previewGain * Math.max(0,Math.min(1,(now-graph.start)/rampSeconds,remaining/rampSeconds));
    const stop = Math.min(graph.end,now+rampSeconds);
    graph.fading = true;
    graph.source.onended = ()=>{if (nodes.current === graph) disconnect();};
    try {
      graph.gain.gain.cancelScheduledValues(now);
      graph.gain.gain.setValueAtTime(level,now);
      graph.gain.gain.linearRampToValueAtTime(0,stop);
      graph.source.stop(stop);
    } catch {disconnect();}
  },[disconnect]);

  useLayoutEffect(()=>{stopPreview();},[options.mixActive,options.stopToken,stopPreview]);
  useLayoutEffect(()=>{
    const recording = input.current.asset;
    const controller = new AbortController();
    const {signal} = controller;
    decoded.current = null;
    setReady(false);
    if (!editorKey || !service || !recording) {
      setWaveform({status:'idle'});
      return;
    }
    setWaveform({status:'loading'});
    const load = async()=>{
      let metadata:{sampleRate:number;frameCount:number}|undefined;
      try {
        const buffer = await service.acquire(recording,signal);
        if (signal.aborted) return;
        decoded.current = buffer;
        setReady(true);
        metadata = {sampleRate:buffer.sampleRate,frameCount:buffer.length};
        setWaveform({status:'loading',...metadata});
        const peaks = await service.waveform(recording,buffer,signal);
        if (!signal.aborted) setWaveform({status:'ready',...metadata,waveform:peaks});
      } catch (cause) {
        if (!signal.aborted) setWaveform({status:'error',...metadata,error:cause instanceof Error ? cause.message : 'The waveform is unavailable.'});
      }
    };
    void load();
    return ()=>{
      controller.abort();
      stopPreview();
      decoded.current = null;
      service.release();
    };
  },[asset?.id,asset?.sha256,service,editorKey,stopPreview]);

  const onPlay = useCallback((loop:Loop)=>{
    const {service:active,options:settings,editorKey:key} = input.current;
    if (!decoded.current || !active || !key || settings.mixActive) return;
    stopPreview();
    const token = generation.current;
    setPreviewState({status:'loading'});
    const play = async()=>{
      try {
        const context = active.context();
        const resumed = context.resume();
        settings.onPreviewStart();
        await resumed;
        const buffer = decoded.current;
        if (generation.current !== token || input.current.options.mixActive || !buffer) return;
        const clip = createLoopJoinPreview(buffer,loop,(channels,frames,rate)=>context.createBuffer(channels,frames,rate));
        const gain = context.createGain();
        const source = context.createBufferSource();
        const start = context.currentTime;
        const end = start + clip.length / clip.sampleRate;
        nodes.current = {gain,source,context,start,end,fading:false};
        source.buffer = clip;
        source.connect(gain);
        gain.connect(context.destination);
        gain.gain.setValueAtTime(0,start);
        gain.gain.linearRampToValueAtTime(previewGain,start+rampSeconds);
        gain.gain.setValueAtTime(previewGain,end-rampSeconds);
        gain.gain.linearRampToValueAtTime(0,end);
        source.onended = ()=>{if (generation.current === token) stopPreview();};
        source.start(start);
        setPreviewState({status:'playing'});
      } catch {
        if (generation.current !== token) return;
        disconnect();
        setPreviewState({status:'error',error:'The loop join could not be previewed.'});
      }
    };
    void play();
  },[stopPreview,disconnect]);
  return {waveform,preview:{state:previewState,disabled:!ready||options.mixActive,requiresPause:options.mixActive,onPlay,onStop:fadePreview},stopPreview};
}
