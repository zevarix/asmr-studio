import {useState} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {applyCommand,defaultOccasional,parseScene,type OccasionalSettings,type SceneCommand} from '@asmr-studio/contracts';
import {fixtureAsset,fixtureLayer,fixtureScene} from '../../../../../tests/fixtures/scene.js';
import {FakeContext,fakeBuffer} from '../../../../../packages/audio-engine/src/test-utils/fake-context.js';
import {LayerControls} from './LayerControls.js';
import {MixerView} from './MixerView.js';
import type {LoopAudioService} from './loop-audio-service.js';

const loop={startSeconds:.1,endSeconds:.8,crossfadeSeconds:.05};
const assets=[fixtureAsset(),...Array.from({length:8},(_,i)=>({...fixtureAsset(),id:'alt-'+i,displayName:'Brush '+i}))];
const enabled={...defaultOccasional(42),enabled:true};
function scene(occasional?:OccasionalSettings){
  return parseScene({...fixtureScene(),layers:[{...fixtureLayer(),loop,...(occasional?{occasional}:{})}]});
}
function Harness({initial,disabled=false,onCommand=()=>{}}:{
  initial?:OccasionalSettings;disabled?:boolean;onCommand?:(command:SceneCommand)=>void;
}){
  const [draft,setDraft]=useState(()=>scene(initial));
  return <fieldset disabled={disabled}><LayerControls layer={draft.layers[0]!} assets={assets} label="Rain"
    durationSeconds={2} onCommand={command=>{onCommand(command);setDraft(previous=>applyCommand(previous,command));}}/></fieldset>;
}
const mode=()=>screen.getByRole('combobox',{name:'Playback mode'});
const change=(node:HTMLElement,value:string)=>fireEvent.change(node,{target:{value}});
const panel=()=>within(screen.getByRole('group',{name:'Rain occasional playback'}));
afterEach(()=>vi.restoreAllMocks());

describe('occasional layer controls',()=>{
  it('generates a seed only on first enable and keeps the saved loop and recipe across mode changes',()=>{
    const rng=vi.spyOn(crypto,'getRandomValues');
    const onCommand=vi.fn();
    render(<Harness onCommand={onCommand}/>);
    expect(mode()).toHaveValue('standard');expect(rng).not.toHaveBeenCalled();expect(onCommand).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox',{name:'Loop'})).toBeChecked();
    change(mode(),'occasional');
    const command=onCommand.mock.lastCall![0];
    expect(command).toEqual({type:'setLayerOccasional',layerId:'ambience',occasional:{...enabled,seed:expect.any(Number)}});
    expect(rng).toHaveBeenCalledOnce();expect(screen.queryByRole('checkbox',{name:'Loop'})).toBeNull();
    expect(panel().getByRole('spinbutton',{name:'Minimum pause'})).toHaveValue(4);
    expect(panel().getByRole('spinbutton',{name:'Maximum pause'})).toHaveValue(12);
    expect(panel().getByRole('slider',{name:/Level variation/})).toHaveValue('0');
    expect(panel().getByRole('slider',{name:/Position variation/})).toHaveValue('0');
    change(mode(),'standard');
    expect(onCommand.mock.lastCall![0].occasional).toEqual({...command.occasional,enabled:false});
    expect(screen.getByRole('checkbox',{name:'Loop'})).toBeChecked();
    change(mode(),'occasional');expect(onCommand.mock.lastCall![0]).toEqual(command);
    expect(rng).toHaveBeenCalledOnce();expect(onCommand).toHaveBeenCalledTimes(3);
  });

  it('applies a valid pause range together and keeps empty, reversed and out-of-range drafts local',()=>{
    const onCommand=vi.fn();render(<Harness initial={enabled} onCommand={onCommand}/>);
    const min=panel().getByRole('spinbutton',{name:'Minimum pause'});
    const max=panel().getByRole('spinbutton',{name:'Maximum pause'});
    const apply=panel().getByRole('button',{name:'Apply pauses'});
    expect(apply).toBeDisabled();
    for(const [lower,upper] of [['','12'],['13','12'],['.24','12'],['1','3601']] as const){
      change(min,lower);change(max,upper);
      expect(min).toHaveAttribute('aria-invalid','true');expect(apply).toBeDisabled();
      fireEvent.click(apply);expect(onCommand).not.toHaveBeenCalled();
    }
    change(min,'.375');change(max,'3600');expect(apply).toBeEnabled();expect(onCommand).not.toHaveBeenCalled();
    fireEvent.click(apply);
    expect(onCommand).toHaveBeenCalledExactlyOnceWith({type:'setLayerOccasional',layerId:'ambience',
      occasional:{...enabled,minPauseSeconds:.375,maxPauseSeconds:3600}});
    expect(apply).toBeDisabled();
  });

  it('filters by name, excludes the main recording and selected alternates, and enforces the seven-alternate limit',()=>{
    const onCommand=vi.fn();render(<Harness initial={{...enabled,alternateAssetIds:assets.slice(1,7).map(asset=>asset.id)}} onCommand={onCommand}/>);
    const search=panel().getByRole('searchbox',{name:'Search alternate recordings'});
    const select=panel().getByRole('combobox',{name:'Alternate recording'});const add=panel().getByRole('button',{name:'Add'});
    expect(within(select).queryByRole('option',{name:assets[0]!.displayName})).toBeNull();
    expect(within(select).queryByRole('option',{name:'Brush 2'})).toBeNull();
    change(search,' unknown ');expect(select).toBeDisabled();expect(add).toBeDisabled();
    change(search,' BRuSH 6 ');expect(within(select).getAllByRole('option')).toHaveLength(2);
    change(select,'alt-6');fireEvent.click(add);
    expect(onCommand.mock.lastCall![0].occasional.alternateAssetIds).toEqual(assets.slice(1,8).map(asset=>asset.id));
    expect(select).toBeDisabled();expect(add).toBeDisabled();expect(search).toBeDisabled();
    fireEvent.click(panel().getByRole('button',{name:'Remove alternate Brush 6'}));
    expect(onCommand.mock.lastCall![0].occasional.alternateAssetIds).toEqual(assets.slice(1,7).map(asset=>asset.id));
    expect(search).toBeEnabled();expect(within(select).getByRole('option',{name:'Brush 6'})).toBeInTheDocument();
  });

  it('saves both variation amounts and guarantees a different seed even when the random draw repeats',()=>{
    vi.spyOn(crypto,'getRandomValues').mockImplementation(buffer=>{(buffer as Uint32Array)[0]=0xffff_ffff;return buffer;});
    const initial={...enabled,seed:0xffff_ffff,alternateAssetIds:['alt-2']};
    const onCommand=vi.fn();render(<Harness initial={initial} onCommand={onCommand}/>);
    change(panel().getByRole('slider',{name:/Level variation/}),'15');
    change(panel().getByRole('slider',{name:/Position variation/}),'25');
    fireEvent.click(panel().getByRole('button',{name:'New variation'}));
    expect(onCommand.mock.lastCall![0].occasional).toEqual({...initial,levelVariation:.15,panVariation:.25,seed:0});
    expect(onCommand).toHaveBeenCalledTimes(3);
  });

  it('honors a disabled parent fieldset for mode, drafts, alternates and variation',()=>{
    const onCommand=vi.fn();render(<Harness disabled initial={{...enabled,alternateAssetIds:['missing']}} onCommand={onCommand}/>);
    const group=panel();
    for(const input of [mode(),...group.getAllByRole('spinbutton'),...group.getAllByRole('slider'),
      group.getByRole('combobox'),group.getByRole('searchbox')]){
      expect(input).toBeDisabled();change(input,input===mode()?'standard':'2');
    }
    for(const button of group.getAllByRole('button')){expect(button).toBeDisabled();fireEvent.click(button);}
    expect(group.getByRole('button',{name:/Remove alternate missing.*unavailable/})).toBeDisabled();
    expect(group.getByRole('spinbutton',{name:'Minimum pause'})).toHaveValue(4);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('stops the active loop audition and releases its buffer when the layer becomes occasional',async()=>{
    const context=new FakeContext(),buffer=fakeBuffer(1,48000);
    const service={context:()=>context as unknown as AudioContext,acquire:vi.fn(async()=>buffer),
      waveform:vi.fn(async()=>({durationSeconds:1,sampleRate:48000,frameCount:48000,min:new Float32Array(1),max:new Float32Array(1)})),
      peek:vi.fn(),release:vi.fn(),dispose:vi.fn()} satisfies LoopAudioService;
    function Room(){
      const [draft,setDraft]=useState(()=>scene());
      return <MixerView scene={draft} assets={[assets[0]!]} loopAudioService={service}
        playback={{state:'ready',positionSeconds:0,loadedAssetIds:[],error:null}}
        onCommand={command=>setDraft(previous=>applyCommand(previous,command))} onStart={()=>{}} onPause={()=>{}} onStop={()=>{}}/>;
    }
    render(<Room/>);fireEvent.click(screen.getByText('Loop details'));
    const preview=await screen.findByRole('button',{name:'Preview join'});
    await waitFor(()=>expect(preview).toBeEnabled());fireEvent.click(preview);
    await screen.findByRole('button',{name:'Stop preview'});
    await waitFor(()=>expect(context.sources[0]?.starts).toHaveLength(1));
    change(mode(),'occasional');
    expect(screen.queryByRole('button',{name:'Stop preview'})).toBeNull();expect(screen.queryByText('Loop details')).toBeNull();
    expect(context.sources[0]!.stops.length).toBeGreaterThan(0);expect(context.sources[0]!.buffer).toBeNull();
    expect(service.release).toHaveBeenCalledOnce();
  });
});
