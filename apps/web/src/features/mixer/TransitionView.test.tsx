import {fireEvent,render,screen,within} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import {createEmptyTransition,parseCapturedMix,parseScene} from '@asmr-studio/contracts';
import {fixtureAsset,fixtureScene} from '../../../../../tests/fixtures/scene.js';
import {TransitionView,type TransitionViewProps} from './TransitionView.js';

function props():TransitionViewProps {
  const a=parseCapturedMix({id:'capture-a',scene:fixtureScene(),assets:[fixtureAsset(),{...fixtureAsset(),id:'asset-voice'}]});
  const b=parseCapturedMix({...a,id:'capture-b',scene:{...a.scene,id:'second',title:'Soft evening',revision:3}});
  const empty=createEmptyTransition('arrangement','Quiet transition');
  return {scene:parseScene({...empty,transition:{...empty.transition!,a,b}}),
    savedScenes:[{id:a.scene.id,title:a.scene.title,revision:2,kind:'mix',layerCount:2,durationSeconds:null},
      {id:b.scene.id,title:b.scene.title,revision:3,kind:'mix',layerCount:2,durationSeconds:null},
      {id:'another-transition',title:'Another arrangement',revision:1,kind:'transition',layerCount:4,durationSeconds:null}],
    deckStates:{a:{loading:false,requestedId:null,error:null},b:{loading:false,requestedId:null,error:null}},
    playback:{state:'playing',positionSeconds:12,loadedAssetIds:[],error:null,transition:{blend:0,phase:'manual',remainingSeconds:0}},
    outputMeterSource:null,sessionTools:null,exportTools:null,canStart:true,
    onChooseDeck:vi.fn(),onCancelDeckLoad:vi.fn(),onBlendChange:vi.fn(),onDurationChange:vi.fn(),onTimedTransition:vi.fn(),onCancelTransition:vi.fn(),
    onCommand:vi.fn(),onRename:vi.fn(),onStart:vi.fn(),onPause:vi.fn(),onStop:vi.fn(),onRestart:vi.fn()};
}

describe('saved-mix transition controls',()=>{
  it('shows captured revisions separately from current saved choices and excludes nested arrangements',()=>{
    const configured=props();render(<TransitionView {...configured}/>);
    const a=within(screen.getByRole('region',{name:'Mix A'}));
    expect(a.getByText('Captured revision 1')).toBeVisible();
    expect(a.getByRole('option',{name:'Quiet room · Revision 2'})).toBeInTheDocument();
    expect(screen.queryByRole('option',{name:/Another arrangement/})).not.toBeInTheDocument();
    fireEvent.click(a.getByRole('button',{name:'Use latest saved revision for A'}));
    expect(configured.onChooseDeck).toHaveBeenCalledExactlyOnceWith('a','scene-test');
  });

  it('uses a native, labeled crossfader and explicit timed/restart actions',()=>{
    const configured=props();
    configured.scene.transition!.blend=.35;
    render(<TransitionView {...configured}/>);
    const slider=screen.getByRole('slider',{name:'Crossfader'});
    expect(slider).toHaveAttribute('type','range');
    expect(slider).toHaveAttribute('aria-valuetext','A 65 percent, B 35 percent');
    slider.focus();fireEvent.change(slider,{target:{value:'48'}});
    expect(slider).toHaveFocus();expect(configured.onBlendChange).toHaveBeenCalledWith(.48);
    expect(screen.getByRole('spinbutton',{name:'Transition duration (seconds)'})).toHaveValue(30);
    fireEvent.click(screen.getByRole('button',{name:'Transition to B in 30 seconds'}));
    expect(configured.onTimedTransition).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button',{name:'Restart arrangement'}));
    expect(configured.onRestart).toHaveBeenCalledOnce();
    expect(screen.getByText(/joins the current position/)).toBeVisible();
    expect(screen.getByText(/Slider movements are not recorded/)).toBeVisible();
  });

  it.each(['ready','paused'] as const)('shows the saved manual target immediately while %s audio retains an earlier blend',state=>{
    const configured=props();
    configured.scene.transition!.blend=.35;
    configured.playback={...configured.playback,state,transition:{blend:0,phase:'manual',remainingSeconds:0}};
    const {rerender}=render(<TransitionView {...configured}/>);
    const slider=screen.getByRole('slider',{name:'Crossfader'});
    expect(slider).toHaveValue('35');
    expect(slider).toHaveAttribute('aria-valuetext','A 65 percent, B 35 percent');
    const changed=parseScene({...configured.scene,transition:{...configured.scene.transition!,blend:.62}});
    rerender(<TransitionView {...configured} scene={changed}/>);
    expect(slider).toHaveValue('62');
    expect(slider).toHaveAttribute('aria-valuetext','A 38 percent, B 62 percent');
  });

  it('keeps A transport and master controls available while B prepares',()=>{
    const configured=props();
    configured.deckStates.b={loading:true,requestedId:'second',error:null};
    render(<TransitionView {...configured}/>);
    expect(screen.getByRole('button',{name:'Pause'})).toBeEnabled();
    expect(screen.getByRole('button',{name:'Stop'})).toBeEnabled();
    expect(screen.getByRole('slider',{name:'Master volume'})).toBeEnabled();
    expect(screen.getByRole('slider',{name:'Crossfader'})).toBeDisabled();
    expect(screen.getByRole('combobox',{name:'Choose mix B'})).toBeEnabled();
    expect(screen.getByRole('combobox',{name:'Choose mix A'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:'Cancel loading mix B'}));
    expect(configured.onCancelDeckLoad).toHaveBeenCalledOnce();
  });

  it('announces paused timed playback and keeps countdown updates outside the live region',()=>{
    const configured=props();
    configured.scene.transition!.mode='timed';
    configured.playback={...configured.playback,state:'paused',transition:{blend:.4,phase:'running',remainingSeconds:18}};
    render(<TransitionView {...configured}/>);
    expect(screen.getByText('Timed transition paused')).toHaveAttribute('role','status');
    expect(screen.getByText('18 seconds remaining')).toHaveAttribute('aria-live','off');
    expect(screen.queryByText('Moving to B')).not.toBeInTheDocument();
    expect(screen.getByRole('slider',{name:'Crossfader'})).toHaveValue('40');
    fireEvent.click(screen.getByRole('button',{name:'Cancel transition'}));
    expect(configured.onCancelTransition).toHaveBeenCalledOnce();
  });

  it('validates timing input without applying an invalid duration',()=>{
    const configured=props();render(<TransitionView {...configured}/>);
    fireEvent.change(screen.getByRole('spinbutton',{name:'Transition duration (seconds)'}),{target:{value:'0'}});
    expect(configured.onDurationChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('0.1 to 3,600');
    expect(screen.getByRole('button',{name:'Transition to B'})).toBeDisabled();
    fireEvent.change(screen.getByRole('spinbutton',{name:'Transition duration (seconds)'}),{target:{value:'60'}});
    expect(configured.onDurationChange).toHaveBeenCalledExactlyOnceWith(60);
  });
});
