import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {parseAssetRecord,parseScene,type AssetRecord} from '@asmr-studio/contracts';
import {fixtureAsset,fixtureLayer,fixtureScene} from '../../../../../tests/fixtures/scene.js';
import {SoundLibrary} from './SoundLibrary.js';
import {LayerControls} from './LayerControls.js';
import {SessionLibraryControls} from './SessionLibraryControls.js';
import {MixerView} from './MixerView.js';

const rain=parseAssetRecord({...fixtureAsset(),displayName:'Rain',durationSeconds:90});
const brush=parseAssetRecord({...fixtureAsset(),id:'asset-brush',displayName:'Soft brush',roles:['texture'],durationSeconds:4.5});
const voice=parseAssetRecord({...fixtureAsset(),id:'asset-voice',displayName:'Reading',roles:['narration']});
const assets:AssetRecord[]=[rain,brush,voice];

beforeEach(()=>{
  vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
  vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
});
afterEach(()=>vi.restoreAllMocks());

describe('sound library controls',()=>{
  it('combines category, name, and active filters without editing the scene',()=>{
    const onCommand=vi.fn();
    render(<SoundLibrary assets={assets} layers={[fixtureLayer()]} onCommand={onCommand} onAddAsset={vi.fn()} mixActive={false}/>);
    fireEvent.click(screen.getByRole('button',{name:'Textures'}));
    expect(screen.getByRole('button',{name:'Add Soft brush as texture'})).toBeVisible();
    expect(screen.queryByRole('button',{name:'Remove Rain from mix'})).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox',{name:'Search sounds'}),{target:{value:'absent'}});
    expect(screen.getByText(/No sounds match/)).toBeVisible();
    fireEvent.change(screen.getByRole('searchbox',{name:'Search sounds'}),{target:{value:''}});
    fireEvent.click(screen.getByRole('button',{name:'All sounds'}));
    fireEvent.click(screen.getByRole('checkbox',{name:'In this mix'}));
    expect(screen.getByRole('button',{name:'Remove Rain from mix'})).toBeVisible();
    expect(screen.queryByRole('button',{name:'Add Soft brush as texture'})).not.toBeInTheDocument();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('adjusts and removes only the selected sound while retaining neighboring layers',()=>{
    const onCommand=vi.fn();
    const layers=[fixtureLayer(),fixtureLayer({id:'brush-layer',assetId:brush.id,role:'texture',gain:.3})];
    render(<SoundLibrary assets={assets} layers={layers} onCommand={onCommand} onAddAsset={vi.fn()} mixActive={false}/>);
    fireEvent.change(screen.getByRole('slider',{name:'Rain volume'}),{target:{value:'23'}});
    expect(onCommand).toHaveBeenLastCalledWith({type:'setLayerGain',layerId:'ambience',gain:.23});
    fireEvent.click(screen.getByRole('button',{name:'Remove Rain from mix'}));
    expect(onCommand).toHaveBeenLastCalledWith({type:'removeLayer',layerId:'ambience'});
    expect(screen.getByRole('slider',{name:'Soft brush volume'})).toHaveValue('30');
    expect(screen.getByText('1:30')).toBeVisible();
  });

  it('stops a preview when the mix starts and ignores the obsolete play rejection',async()=>{
    let reject!: (error:Error)=>void;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(()=>new Promise((_resolve,no)=>{reject=no;}));
    const props={assets,layers:[],onCommand:vi.fn(),onAddAsset:vi.fn()};
    const {rerender}=render(<SoundLibrary {...props} mixActive={false}/>);
    fireEvent.click(screen.getByRole('button',{name:'Preview Rain'}));
    expect(screen.getByRole('button',{name:'Stop preview of Rain'})).toHaveAttribute('aria-pressed','true');
    rerender(<SoundLibrary {...props} mixActive/>);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(screen.getByRole('button',{name:'Preview Rain'})).toBeDisabled();
    await act(async()=>{reject(new Error('old playback request'));});
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not submit the starter library twice while its request is running',async()=>{
    let resolve!:()=>void;
    const install=vi.fn(()=>new Promise<void>(yes=>{resolve=yes;}));
    render(<SoundLibrary assets={[]} layers={[]} onCommand={vi.fn()} mixActive={false} onInstallStarterSounds={install}/>);
    fireEvent.click(screen.getByRole('button',{name:'Add starter sounds'}));
    fireEvent.click(screen.getByRole('button',{name:'Adding starter sounds…'}));
    expect(install).toHaveBeenCalledOnce();
    await act(async()=>resolve());
    expect(screen.getByText(/Starter sounds are ready/)).toBeVisible();
  });
});

describe('loop and session controls',()=>{
  it('protects a dirty mix before creating a distinct transition',async()=>{
    const onNewTransition=vi.fn();
    const onSave=vi.fn().mockResolvedValue(true);
    render(<SessionLibraryControls sceneId="current" savedScenes={[]} busy={false} dirty onNew={vi.fn()}
      onNewTransition={onNewTransition} onOpen={vi.fn()} onSave={onSave} onSaveCopy={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button',{name:'New transition'}));
    expect(onNewTransition).not.toHaveBeenCalled();
    expect(screen.getByRole('group',{name:'Unsaved session changes'})).toHaveTextContent('starting a new transition');
    fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
    expect(onNewTransition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'New transition'}));
    fireEvent.click(screen.getByRole('button',{name:'Save and continue'}));
    await waitFor(()=>expect(onNewTransition).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('rejects invalid loop limits and applies valid bounds to only the requested layer',()=>{
    const layer=fixtureLayer({loop:{startSeconds:0,endSeconds:2,crossfadeSeconds:.02}});
    const onCommand=vi.fn();
    render(<LayerControls layer={layer} durationSeconds={3} onCommand={onCommand}/>);
    fireEvent.click(screen.getByText('Loop details'));
    fireEvent.change(screen.getByRole('spinbutton',{name:'Loop end'}),{target:{value:'4'}});
    fireEvent.click(screen.getByRole('button',{name:'Apply loop'}));
    expect(screen.getByRole('alert')).toHaveTextContent(/within the recording/);
    expect(onCommand).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('spinbutton',{name:'Loop end'}),{target:{value:'2.5'}});
    fireEvent.change(screen.getByRole('spinbutton',{name:'Loop crossfade'}),{target:{value:'2'}});
    fireEvent.click(screen.getByRole('button',{name:'Apply loop'}));
    expect(screen.getByRole('alert')).toHaveTextContent(/half the loop/);
    fireEvent.change(screen.getByRole('spinbutton',{name:'Loop crossfade'}),{target:{value:'.25'}});
    fireEvent.click(screen.getByRole('button',{name:'Apply loop'}));
    expect(onCommand).toHaveBeenCalledExactlyOnceWith({type:'setLayerLoop',layerId:'ambience',loop:{startSeconds:0,endSeconds:2.5,crossfadeSeconds:.25}});
    fireEvent.click(screen.getByRole('checkbox',{name:'Loop'}));
    expect(onCommand).toHaveBeenLastCalledWith({type:'setLayerLoop',layerId:'ambience',loop:null});
  });

  it('keeps the current session if saving before a switch fails',async()=>{
    const onNew=vi.fn();
    const onSave=vi.fn().mockResolvedValue(false);
    render(<SessionLibraryControls sceneId="current" savedScenes={[]} busy={false} dirty onNew={onNew} onOpen={vi.fn()} onSave={onSave} onSaveCopy={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button',{name:'New session'}));
    fireEvent.click(screen.getByRole('button',{name:'Save and continue'}));
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(/not all been saved/));
    expect(onNew).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
    expect(screen.queryByRole('group',{name:'Unsaved session changes'})).not.toBeInTheDocument();
  });

  it('opens the selected saved session only after the current changes are saved',async()=>{
    const onOpen=vi.fn();
    const onSave=vi.fn().mockResolvedValue(true);
    render(<SessionLibraryControls sceneId="current" savedScenes={[{id:'saved',title:'Evening',revision:1,durationSeconds:null,layerCount:2,kind:'mix'}]}
      busy={false} dirty onNew={vi.fn()} onOpen={onOpen} onSave={onSave} onSaveCopy={vi.fn()}/>);
    fireEvent.change(screen.getByRole('combobox',{name:'Open saved session'}),{target:{value:'saved'}});
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Save and continue'}));
    await waitFor(()=>expect(onOpen).toHaveBeenCalledExactlyOnceWith('saved'));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('cancels a session-name edit with Escape and restores the saved label',()=>{
    const onRename=vi.fn();
    render(<MixerView scene={parseScene(fixtureScene())} playback={{state:'ready',positionSeconds:0,loadedAssetIds:[],error:null}}
      onCommand={vi.fn()} onStart={vi.fn()} onPause={vi.fn()} onStop={vi.fn()} onRename={onRename}/>);
    const name=screen.getByRole('textbox',{name:'Session name'});
    name.focus();
    fireEvent.change(name,{target:{value:'Accidental edit'}});
    fireEvent.keyDown(name,{key:'Escape'});
    expect(onRename).not.toHaveBeenCalled();
    expect(name).toHaveValue('Quiet room');
  });
});
