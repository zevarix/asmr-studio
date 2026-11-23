import {useState} from 'react';
import {describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,within} from '@testing-library/react';
import type {ListeningTimerSettings,Scene} from '@asmr-studio/contracts';
import type {PlaybackSnapshot} from '@asmr-studio/audio-engine';
import {fixtureScene} from '../../../../../tests/fixtures/scene.js';
import {MixerView} from './MixerView.js';
import {Transport} from './Transport.js';

const timer:ListeningTimerSettings={enabled:true,durationSeconds:2700,fadeInSeconds:0,fadeOutSeconds:180};
const ready:PlaybackSnapshot={state:'ready',positionSeconds:0,loadedAssetIds:[],error:null};
function Studio({initial,playback=ready,disabled=false,onChange=vi.fn()}:{
  initial?:Partial<Scene>;playback?:PlaybackSnapshot;disabled?:boolean;onChange?:(value:unknown)=>void;
}) {
  const [scene,setScene]=useState<Scene>({...fixtureScene(),durationSeconds:null,...initial});
  return <fieldset disabled={disabled}><MixerView scene={scene} playback={playback} onStart={vi.fn()} onPause={vi.fn()} onStop={vi.fn()}
    onCommand={command=>{onChange(command);if(command.type==='setListeningTimer')setScene(previous=>({...previous,listeningTimer:command.timer,durationSeconds:null}));}}/></fieldset>;
}
function panel(){return screen.getByRole('group',{name:'Listening timer settings'});}
function field(name:string){return within(panel()).getByRole('spinbutton',{name});}
function change(name:string,value:string){fireEvent.change(field(name),{target:{value}});}
function apply(){fireEvent.click(within(panel()).getByRole('button',{name:'Apply timer'}));}
function open(){fireEvent.click(screen.getByText('Listening timer',{exact:true}));}

describe('listening timer controls',()=>{
  it('starts off without changing the recipe and enables the starting values only on request',()=>{
    const onChange=vi.fn();render(<Studio onChange={onChange}/>);open();
    expect(within(panel()).getByRole('combobox',{name:'Listening timer mode'})).toHaveValue('off');
    expect(field('Stop after (minutes)')).toHaveValue(45);expect(field('Stop after (minutes)')).toBeDisabled();
    expect(field('Fade in (minutes)')).toHaveValue(0);expect(field('Fade out (minutes)')).toHaveValue(3);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(within(panel()).getByRole('combobox',{name:'Listening timer mode'}),{target:{value:'on'}});
    expect(onChange).toHaveBeenCalledExactlyOnceWith({type:'setListeningTimer',timer});
    expect(field('Stop after (minutes)')).toBeEnabled();
  });

  it('applies interdependent durations together and preserves fractional minutes',()=>{
    const onChange=vi.fn();render(<Studio initial={{listeningTimer:timer}} onChange={onChange}/>);open();
    change('Stop after (minutes)','2');change('Fade out (minutes)','0.5');change('Fade in (minutes)','0.25');
    expect(onChange).not.toHaveBeenCalled();expect(screen.getByText('Apply changes to update the timer.')).toBeVisible();
    apply();
    expect(onChange).toHaveBeenCalledExactlyOnceWith({type:'setListeningTimer',timer:{enabled:true,durationSeconds:120,fadeInSeconds:15,fadeOutSeconds:30}});
    expect(field('Fade in (minutes)')).toHaveAttribute('step','any');
    expect(field('Fade in (minutes)')).toBeValid();
    expect(within(panel()).getByRole('button',{name:'Apply timer'})).toBeDisabled();
  });

  it('preserves accepted seconds exactly when another minutes field changes',()=>{
    const onChange=vi.fn(),saved={enabled:true,durationSeconds:1.89,fadeInSeconds:0,fadeOutSeconds:.49};
    render(<Studio initial={{listeningTimer:saved}} onChange={onChange}/>);open();
    change('Fade in (minutes)','.001');apply();
    expect(onChange).toHaveBeenCalledExactlyOnceWith({type:'setListeningTimer',timer:{...saved,fadeInSeconds:.06}});
  });

  it.each([
    ['Stop after (minutes)','0',/greater than zero/i],
    ['Fade in (minutes)','-1',/zero or more/i],
    ['Stop after (minutes)','2',/fit/i],
    ['Fade out (minutes)','',/enter a number/i],
  ])('keeps accepted settings when %s is %s', (name,value,message)=>{
    const onChange=vi.fn();render(<Studio initial={{listeningTimer:timer}} onChange={onChange}/>);open();change(name,value);apply();
    expect(screen.getByRole('alert')).toHaveTextContent(message);expect(onChange).not.toHaveBeenCalled();
    expect(field(name)).toHaveAttribute('aria-invalid','true');
  });

  it('retains accepted durations when off and discards an unapplied draft',()=>{
    const onChange=vi.fn(),saved={...timer,durationSeconds:600,fadeInSeconds:30,fadeOutSeconds:60};
    render(<Studio initial={{listeningTimer:saved}} onChange={onChange}/>);open();change('Fade in (minutes)','2');
    const mode=within(panel()).getByRole('combobox',{name:'Listening timer mode'});
    fireEvent.change(mode,{target:{value:'off'}});
    expect(onChange).toHaveBeenCalledExactlyOnceWith({type:'setListeningTimer',timer:{...saved,enabled:false}});
    expect(field('Fade in (minutes)')).toHaveValue(.5);expect(field('Fade in (minutes)')).toBeDisabled();
    fireEvent.change(mode,{target:{value:'on'}});
    expect(onChange).toHaveBeenLastCalledWith({type:'setListeningTimer',timer:saved});
    expect(field('Fade in (minutes)')).toHaveValue(.5);
  });

  it('exposes a legacy finite scene without inventing fades or editing it on mount',()=>{
    const onChange=vi.fn();render(<Studio initial={{durationSeconds:90}} onChange={onChange}/>);open();
    expect(within(panel()).getByRole('combobox',{name:'Listening timer mode'})).toHaveValue('on');
    expect(field('Stop after (minutes)')).toHaveValue(1.5);expect(field('Fade out (minutes)')).toHaveValue(0);
    expect(onChange).not.toHaveBeenCalled();
    change('Fade in (minutes)','.25');apply();
    expect(onChange).toHaveBeenCalledExactlyOnceWith({type:'setListeningTimer',timer:{enabled:true,durationSeconds:90,fadeInSeconds:15,fadeOutSeconds:0}});
  });

  it('submits with Enter and ignores synthetic events under a disabled editor',()=>{
    const onChange=vi.fn();const view=render(<Studio initial={{listeningTimer:timer}} onChange={onChange}/>);open();
    change('Fade in (minutes)','.5');fireEvent.keyDown(field('Fade in (minutes)'),{key:'Enter'});
    expect(onChange).toHaveBeenCalledExactlyOnceWith({type:'setListeningTimer',timer:{...timer,fadeInSeconds:30}});
    view.unmount();onChange.mockClear();render(<Studio disabled initial={{listeningTimer:timer}} onChange={onChange}/>);open();
    fireEvent.change(within(panel()).getByRole('combobox',{name:'Listening timer mode'}),{target:{value:'off'}});
    change('Fade in (minutes)','.5');fireEvent.keyDown(field('Fade in (minutes)'),{key:'Enter'});apply();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('updates remaining time without changing the recipe or announcing every clock tick',()=>{
    const onChange=vi.fn();const playback:PlaybackSnapshot={...ready,state:'playing',positionSeconds:2600,
      listeningTimer:{remainingSeconds:100,phase:'fading-out',gain:.5}};
    const view=render(<Studio initial={{listeningTimer:timer}} playback={playback} onChange={onChange}/>);
    expect(screen.getByRole('timer',{name:'Time remaining'})).toHaveTextContent('1:40');
    expect(screen.getByRole('status')).toHaveTextContent('Playing · Fading out');
    expect(screen.getByRole('status')).not.toHaveTextContent(/\d+:\d+/);
    expect(screen.getByLabelText('Elapsed time')).toHaveTextContent('43:20');
    view.rerender(<Studio initial={{listeningTimer:timer}} playback={{...playback,positionSeconds:2601,listeningTimer:{...playback.listeningTimer!,remainingSeconds:99}}} onChange={onChange}/>);
    expect(screen.getByRole('timer',{name:'Time remaining'})).toHaveTextContent('1:39');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('timer',{name:'Time remaining'}).closest('[aria-live="polite"]')).toBeNull();
  });

  it('keeps Stop available to reset a finished timer and Start available to replay it',()=>{
    const onStop=vi.fn(),onStart=vi.fn();
    render(<Transport playback={{...ready,positionSeconds:120,listeningTimer:{remainingSeconds:0,phase:'finished',gain:0}}}
      hasLayers onStart={onStart} onPause={vi.fn()} onStop={onStop}/>);
    expect(screen.getByRole('status')).toHaveTextContent('Timer finished');
    expect(screen.getByRole('button',{name:'Stop'})).toBeEnabled();
    fireEvent.click(screen.getByRole('button',{name:'Stop'}));expect(onStop).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button',{name:'Start listening'}));expect(onStart).toHaveBeenCalledOnce();
  });
});
