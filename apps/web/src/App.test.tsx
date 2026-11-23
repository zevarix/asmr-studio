import {StrictMode} from 'react';
import {act,render,waitFor} from '@testing-library/react';
import * as engineModule from '@asmr-studio/audio-engine';
import * as sessionModule from './features/mixer/useSession.js';
import {applyCommand,defaultOccasional,parseScene,type SceneCommand} from '@asmr-studio/contracts';
import {afterEach,expect,it,vi} from 'vitest';
import {fixtureAsset,fixtureScene} from '../../../tests/fixtures/scene.js';
import {App} from './App.js';
import {MixerView} from './features/mixer/MixerView.js';
import type {MixerViewProps} from './features/mixer/MixerView.js';

vi.mock('./features/mixer/MixerView.js',()=>({MixerView:vi.fn((_props:MixerViewProps)=>null)}));
vi.mock('./features/mixer/useSession.js',()=>({useSession:()=>({scene:fixtureScene(),assets:[],missingAssets:[]})}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

it('keeps the mounted loop audio service usable through Strict Mode effect replay and disposes it on unmount',async()=>{
  const buffer = {sampleRate:48000,length:48000,numberOfChannels:1} as AudioBuffer;
  const close = vi.fn(async()=>{});
  vi.stubGlobal('AudioContext',class {
    sampleRate = 48000;
    close = close;
    decodeAudioData = async()=>buffer;
  });
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(Uint8Array.of(1))));
  const {unmount} = render(<StrictMode><App/></StrictMode>);
  const service = vi.mocked(MixerView).mock.lastCall?.[0].loopAudioService;
  expect(service).toBeDefined();
  const asset = fixtureAsset();
  await expect(service!.acquire(asset,new AbortController().signal)).resolves.toBe(buffer);
  expect(service!.peek(asset.id)).toBe(buffer);
  expect(close).not.toHaveBeenCalled();
  unmount();
  expect(service!.peek(asset.id)).toBeUndefined();
  expect(close).toHaveBeenCalledOnce();
  await expect(service!.acquire(asset,new AbortController().signal)).rejects.toThrow(/closed/);
});

it('uses current catalog durations and supersedes a pending start when an occasional edit adds an alternate',async()=>{
  let scene=parseScene({...fixtureScene(),layers:[fixtureScene().layers[0]]});
  const catalog=[fixtureAsset()];
  const session=sessionModule.useSession();
  vi.spyOn(sessionModule,'useSession').mockImplementation(()=>({...session,scene,assets:[...catalog],
    getScene:()=>scene,edit:(command:SceneCommand)=>scene=applyCommand(scene,command)}));
  let finishFirst!:()=>void,finishLatest!:()=>void;
  const first=new Promise<void>(resolve=>{finishFirst=resolve;}),latest=new Promise<void>(resolve=>{finishLatest=resolve;});
  const engine={setScene:vi.fn<engineModule.Mixer['setScene']>().mockReturnValueOnce(first).mockReturnValueOnce(latest),
    updateScene:vi.fn(),apply:vi.fn(),play:vi.fn(async()=>{}),pause:vi.fn(),stop:vi.fn(),subscribe:()=>()=>{},
    subscribeOutput:()=>()=>{},resetOutputPeaks:vi.fn(),getDecodedAsset:vi.fn(),dispose:vi.fn()} satisfies engineModule.Mixer;
  const create=vi.spyOn(engineModule,'createMixer').mockReturnValue(engine);
  vi.stubGlobal('AudioContext',class {async resume(){} async close(){}});
  const {rerender}=render(<App/>);
  const view=()=>vi.mocked(MixerView).mock.lastCall![0];
  act(()=>view().onStart());
  await waitFor(()=>expect(engine.setScene).toHaveBeenCalledTimes(1));
  const duration=create.mock.calls[0]![0].assetDurationSeconds!;
  expect(duration('asset-rain')).toBe(2);expect(duration('alt')).toBeUndefined();
  catalog.push({...fixtureAsset(),id:'alt',durationSeconds:.375});rerender(<App/>);
  expect(duration('alt')).toBe(.375);
  const occasional={...defaultOccasional(42),enabled:true,alternateAssetIds:['alt']};
  act(()=>view().onCommand({type:'setLayerOccasional',layerId:scene.layers[0]!.id,occasional}));
  expect(engine.setScene).toHaveBeenCalledTimes(2);
  expect(engine.setScene.mock.lastCall![0].layers[0]!.occasional).toEqual(occasional);
  expect(engine.apply).not.toHaveBeenCalled();expect(engine.play).not.toHaveBeenCalled();
  await act(async()=>finishLatest());expect(engine.play).toHaveBeenCalledOnce();
  await act(async()=>finishFirst());expect(engine.play).toHaveBeenCalledOnce();
});
