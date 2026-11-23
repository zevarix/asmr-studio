import {useState} from 'react';
import {describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,within} from '@testing-library/react';
import type {SceneCommand,StereoMovementSettings} from '@asmr-studio/contracts';
import {fixtureLayer} from '../../../../../tests/fixtures/scene.js';
import {LayerControls} from './LayerControls.js';

function Harness({initial,center=0,disabled=false,onCommand=()=>{}}:{
  initial?:StereoMovementSettings;center?:number;disabled?:boolean;onCommand?:(command:SceneCommand)=>void;
}) {
  const [layer,setLayer]=useState(()=>fixtureLayer({id:'brush',pan:center,...(initial?{movement:initial}:{})}));
  return <fieldset disabled={disabled}><LayerControls layer={layer} label="Brushing" durationSeconds={30}
    onCommand={command=>{
      onCommand(command);
      if(command.type==='setLayerMovement')setLayer(current=>({...current,movement:command.movement}));
      if(command.type==='setLayerPan')setLayer(current=>({...current,pan:command.pan}));
    }}/></fieldset>;
}

function openMovement() {
  const summary=screen.getByText('Movement',{exact:true}).closest('summary')!;
  fireEvent.click(summary);
  expect(summary.parentElement).toHaveAttribute('open');
  return within(screen.getByRole('group',{name:'Brushing movement'}));
}

describe('per-layer movement controls',()=>{
  it('shows an off summary and retained starting values without editing a legacy layer',()=>{
    const onCommand=vi.fn();
    render(<Harness onCommand={onCommand}/>);
    expect(screen.getByText('Movement',{exact:true}).closest('summary')).toHaveTextContent('Off');
    const panel=openMovement();
    expect(panel.getByRole('combobox',{name:'Movement mode'})).toHaveValue('off');
    expect(panel.getByRole('slider',{name:'Width'})).toHaveValue('30');
    expect(panel.getByRole('slider',{name:'Width'})).toBeDisabled();
    expect(panel.getByRole('spinbutton',{name:'Cycle time'})).toHaveValue(30);
    expect(panel.getByRole('spinbutton',{name:'Cycle time'})).toBeDisabled();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('enables this layer, edits width and cycle time, and retains both while off',()=>{
    const onCommand=vi.fn();
    render(<Harness onCommand={onCommand}/>);
    const panel=openMovement();
    const mode=panel.getByRole('combobox',{name:'Movement mode'});
    const width=panel.getByRole('slider',{name:'Width'});
    const cycle=panel.getByRole('spinbutton',{name:'Cycle time'});
    fireEvent.change(mode,{target:{value:'sway'}});
    expect(onCommand).toHaveBeenLastCalledWith({type:'setLayerMovement',layerId:'brush',movement:{enabled:true,width:.3,cycleSeconds:30}});
    expect(width).toBeEnabled();expect(cycle).toBeEnabled();
    fireEvent.change(width,{target:{value:'54'}});
    expect(onCommand).toHaveBeenLastCalledWith({type:'setLayerMovement',layerId:'brush',movement:{enabled:true,width:.54,cycleSeconds:30}});
    fireEvent.change(cycle,{target:{value:'12.5'}});
    expect(onCommand).toHaveBeenLastCalledWith({type:'setLayerMovement',layerId:'brush',movement:{enabled:true,width:.54,cycleSeconds:12.5}});
    expect(screen.getByText('Movement',{exact:true}).closest('summary')).toHaveTextContent('Sway · 54% · 12.5 s');
    fireEvent.change(mode,{target:{value:'off'}});
    expect(onCommand).toHaveBeenLastCalledWith({type:'setLayerMovement',layerId:'brush',movement:{enabled:false,width:.54,cycleSeconds:12.5}});
    expect(width).toBeDisabled();expect(width).toHaveValue('54');
    expect(cycle).toBeDisabled();expect(cycle).toHaveValue(12.5);
    fireEvent.change(width,{target:{value:'80'}});
    fireEvent.change(cycle,{target:{value:'60'}});
    expect(onCommand).toHaveBeenCalledTimes(4);
    fireEvent.change(mode,{target:{value:'sway'}});
    expect(onCommand).toHaveBeenLastCalledWith({type:'setLayerMovement',layerId:'brush',movement:{enabled:true,width:.54,cycleSeconds:12.5}});
  });

  it('permits a temporary empty or out-of-range cycle draft without sending an invalid recipe',()=>{
    const onCommand=vi.fn();
    render(<Harness initial={{enabled:true,width:.3,cycleSeconds:30}} onCommand={onCommand}/>);
    const cycle=openMovement().getByRole('spinbutton',{name:'Cycle time'});
    expect(cycle).toHaveAttribute('min','2');expect(cycle).toHaveAttribute('max','600');
    expect(cycle).toHaveAttribute('step','any');
    fireEvent.change(cycle,{target:{value:''}});
    expect(cycle).toHaveValue(null);expect(onCommand).not.toHaveBeenCalled();
    fireEvent.change(cycle,{target:{value:'1'}});
    expect(cycle).toHaveAttribute('aria-invalid','true');expect(onCommand).not.toHaveBeenCalled();
    fireEvent.blur(cycle);
    expect(cycle).toHaveValue(30);expect(cycle).not.toHaveAttribute('aria-invalid','true');
    fireEvent.change(cycle,{target:{value:'601'}});
    fireEvent.blur(cycle);
    expect(cycle).toHaveValue(30);expect(onCommand).not.toHaveBeenCalled();
    fireEvent.change(cycle,{target:{value:'2.25'}});
    expect(onCommand).toHaveBeenLastCalledWith({type:'setLayerMovement',layerId:'brush',movement:{enabled:true,width:.3,cycleSeconds:2.25}});
  });

  it('explains the effective travel range when the center constrains the requested width',()=>{
    render(<Harness initial={{enabled:true,width:.3,cycleSeconds:30}} center={.9}/>);
    const panel=openMovement();
    expect(panel.getByRole('slider',{name:'Width'})).toHaveValue('30');
    expect(panel.getByText('Travel: Right 80% to Right 100%.')).toBeVisible();
    expect(panel.getByText('Width is limited by the stereo position.')).toBeVisible();
    fireEvent.change(screen.getByRole('slider',{name:'Stereo position'}),{target:{value:'100'}});
    expect(panel.getByText('Move the stereo position away from the edge to hear sway.')).toBeVisible();
    expect(panel.getByRole('slider',{name:'Width'})).toHaveValue('30');
  });

  it('accepts fractional cycles as natively valid and adjusts them by one second with arrow keys',()=>{
    const onCommand=vi.fn();
    render(<Harness initial={{enabled:true,width:.3,cycleSeconds:2.125}} onCommand={onCommand}/>);
    const cycle=openMovement().getByRole('spinbutton',{name:'Cycle time'});
    expect(cycle).toBeValid();
    const up=new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true});
    fireEvent(cycle,up);
    expect(up.defaultPrevented).toBe(true);
    expect(cycle).toHaveValue(3.125);expect(cycle).toBeValid();
    fireEvent.keyDown(cycle,{key:'ArrowDown'});
    expect(cycle).toHaveValue(2.125);
    fireEvent.keyDown(cycle,{key:'ArrowDown'});
    expect(cycle).toHaveValue(2);
    fireEvent.change(cycle,{target:{value:'599.75'}});
    expect(cycle).toBeValid();
    fireEvent.keyDown(cycle,{key:'ArrowUp'});
    expect(cycle).toHaveValue(600);expect(cycle).toBeValid();
    expect(onCommand).toHaveBeenLastCalledWith({type:'setLayerMovement',layerId:'brush',movement:{enabled:true,width:.3,cycleSeconds:600}});
    const calls=onCommand.mock.calls.length;
    fireEvent.keyDown(cycle,{key:'ArrowUp'});
    expect(onCommand).toHaveBeenCalledTimes(calls);
  });

  it('makes zero width explicit without switching off or changing the saved cycle',()=>{
    const onCommand=vi.fn();
    render(<Harness initial={{enabled:true,width:0,cycleSeconds:45}} onCommand={onCommand}/>);
    const panel=openMovement();
    expect(panel.getByRole('combobox',{name:'Movement mode'})).toHaveValue('sway');
    expect(panel.getByText('Width is zero; the stereo position stays fixed.')).toBeVisible();
    expect(screen.getByText('Movement',{exact:true}).closest('summary')).toHaveTextContent('Sway · 0% · 45 s');
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('honors the containing disabled fieldset for mode, width, and cycle edits',()=>{
    const onCommand=vi.fn();
    render(<Harness initial={{enabled:true,width:.3,cycleSeconds:30}} disabled onCommand={onCommand}/>);
    const panel=openMovement();
    const mode=panel.getByRole('combobox',{name:'Movement mode'});
    const width=panel.getByRole('slider',{name:'Width'});
    const cycle=panel.getByRole('spinbutton',{name:'Cycle time'});
    for(const element of [mode,width,cycle])expect(element).toBeDisabled();
    fireEvent.change(mode,{target:{value:'off'}});
    fireEvent.change(width,{target:{value:'80'}});
    fireEvent.change(cycle,{target:{value:'60'}});
    fireEvent.keyDown(cycle,{key:'ArrowUp'});
    expect(onCommand).not.toHaveBeenCalled();
    expect(cycle).toHaveValue(30);
  });

  it('retains native slider and cursor keys and does not add animated/live readouts',()=>{
    render(<Harness initial={{enabled:true,width:.3,cycleSeconds:30}}/>);
    const panel=openMovement();
    const width=panel.getByRole('slider',{name:'Width'});
    const cycle=panel.getByRole('spinbutton',{name:'Cycle time'});
    for(const [element,keys] of [[width,['ArrowUp','ArrowDown','Home','End']],[cycle,['Home','End']]] as const)for(const key of keys){
      const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});
      fireEvent(element,event);expect(event.defaultPrevented).toBe(false);
    }
    expect(width).toHaveAttribute('aria-valuetext','30 percent width');
    expect(cycle).toHaveAttribute('aria-valuetext','30 seconds per cycle');
    expect(screen.getByRole('group',{name:'Brushing movement'}).querySelector('[aria-live="polite"], [aria-live="assertive"]')).toBeNull();
  });
});
