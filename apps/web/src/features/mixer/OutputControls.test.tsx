import {useState} from 'react';
import {describe,expect,it,vi} from 'vitest';
import {act,fireEvent,render,screen} from '@testing-library/react';
import type {OutputLimiterSettings} from '@asmr-studio/contracts';
import type {OutputMeterSnapshot} from '@asmr-studio/audio-engine';
import {OutputControls,type OutputMeterSource} from './OutputControls.js';

const silent:OutputMeterSnapshot={available:true,peak:[0,0],rms:[0,0],heldPeak:[0,0],clipped:[false,false],gainReductionDb:0,error:null};

function meterSource(initial:OutputMeterSnapshot=silent) {
  let snapshot=initial;
  const listeners=new Set<(value:OutputMeterSnapshot)=>void>();
  const emit=(value:OutputMeterSnapshot)=>{snapshot=value;for(const listener of listeners)listener(snapshot);};
  const source:OutputMeterSource={
    subscribeOutput(listener){listeners.add(listener);listener(snapshot);return()=>{listeners.delete(listener);};},
    resetOutputPeaks(){emit({...snapshot,heldPeak:[0,0],clipped:[false,false]});},
  };
  return {source,emit,listeners};
}

function Harness({initial,source=null,onChange=()=>{},disabled=false}:{
  initial?:OutputLimiterSettings;source?:OutputMeterSource|null;onChange?:(value:OutputLimiterSettings)=>void;disabled?:boolean;
}) {
  const [value,setValue]=useState(initial);
  return <fieldset disabled={disabled}><OutputControls value={value} meterSource={source}
    onChange={next=>{setValue(next);onChange(next);}}/></fieldset>;
}

describe('output controls',()=>{
  it('starts off without modifying a legacy recipe and provides labelled native controls',()=>{
    const change=vi.fn();
    render(<Harness onChange={change}/>);
    expect(screen.getByRole('group',{name:'Output levels'})).toBeVisible();
    expect(screen.getByRole('heading',{name:'Output'})).toBeVisible();
    expect(screen.getByRole('button',{name:'Peak limiter'})).toHaveAttribute('aria-pressed','false');
    const ceiling=screen.getByRole('slider',{name:'Output ceiling'});
    expect(ceiling).toHaveValue('-1');
    expect(ceiling).toBeDisabled();
    expect(ceiling).toHaveAttribute('min','-12');
    expect(ceiling).toHaveAttribute('max','-0.1');
    expect(ceiling).toHaveAttribute('step','0.1');
    expect(screen.getByRole('meter',{name:'Left output level'})).toHaveAttribute('value','-60');
    expect(screen.getByRole('meter',{name:'Right output level'})).toHaveAttribute('value','-60');
    expect(screen.getByRole('button',{name:'Reset peaks'})).toBeDisabled();
    expect(screen.getByText('Start listening to see levels.')).toBeVisible();
    expect(change).not.toHaveBeenCalled();
  });

  it('enables, edits the native ceiling, and retains that ceiling through bypass',()=>{
    const change=vi.fn();
    render(<Harness onChange={change}/>);
    const toggle=screen.getByRole('button',{name:'Peak limiter'});
    const ceiling=screen.getByRole('slider',{name:'Output ceiling'});
    fireEvent.click(toggle);
    expect(change).toHaveBeenLastCalledWith({enabled:true,ceilingDb:-1});
    expect(ceiling).toBeEnabled();
    fireEvent.change(ceiling,{target:{value:'-3.2'}});
    expect(change).toHaveBeenLastCalledWith({enabled:true,ceilingDb:-3.2});
    expect(ceiling).toHaveAttribute('aria-valuetext','−3.2 decibels full scale');
    for(const key of ['ArrowUp','ArrowDown','Home','End']){
      const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});
      fireEvent(ceiling,event);
      expect(event.defaultPrevented).toBe(false);
    }
    fireEvent.click(toggle);
    expect(change).toHaveBeenLastCalledWith({enabled:false,ceilingDb:-3.2});
    expect(ceiling).toBeDisabled();
    expect(ceiling).toHaveValue('-3.2');
    fireEvent.change(ceiling,{target:{value:'-8'}});
    expect(change).toHaveBeenCalledTimes(3);
    fireEvent.click(toggle);
    expect(change).toHaveBeenLastCalledWith({enabled:true,ceilingDb:-3.2});
  });

  it('shows channel-specific levels and held full-scale peaks, then resets without changing the recipe',()=>{
    const feed=meterSource();
    const change=vi.fn();
    render(<Harness source={feed.source} onChange={change}/>);
    act(()=>feed.emit({...silent,peak:[.5,.25],rms:[.25,.125],heldPeak:[1.1,.5],clipped:[true,false],gainReductionDb:4.25}));
    const left=screen.getByRole('meter',{name:'Left output level'});
    const right=screen.getByRole('meter',{name:'Right output level'});
    expect(Number(left.getAttribute('value'))).toBeCloseTo(-6.0206,4);
    expect(Number(right.getAttribute('value'))).toBeCloseTo(-12.0412,4);
    expect(left).toHaveAttribute('aria-valuetext','−6.0 decibels full scale; held peak +0.8 decibels full scale');
    expect(screen.getByLabelText('Left held peak')).toHaveTextContent('+0.8');
    expect(screen.getByLabelText('Right held peak')).toHaveTextContent('−6.0');
    expect(screen.getByText('Full scale reached')).toBeVisible();
    expect(screen.getByLabelText('Gain reduction')).toHaveTextContent('4.3 dB');
    expect(screen.getByRole('group',{name:'Output levels'}).querySelector('[aria-live="polite"]')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Reset peaks'}));
    expect(screen.queryByText('Full scale reached')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Left held peak')).toHaveTextContent('−∞');
    expect(screen.getByLabelText('Right held peak')).toHaveTextContent('−∞');
    expect(change).not.toHaveBeenCalled();
  });

  it('subscribes to only the current mixer and clears stale readings when it is replaced',()=>{
    const first=meterSource({...silent,heldPeak:[.5,.5]});
    const second=meterSource({...silent,heldPeak:[.1,.2]});
    const change=vi.fn();
    const {rerender,unmount}=render(<OutputControls value={undefined} meterSource={first.source} onChange={change}/>);
    expect(first.listeners.size).toBe(1);
    rerender(<OutputControls value={undefined} meterSource={second.source} onChange={change}/>);
    expect(first.listeners.size).toBe(0);
    expect(second.listeners.size).toBe(1);
    expect(screen.getByLabelText('Left held peak')).toHaveTextContent('−20.0');
    act(()=>first.emit({...silent,heldPeak:[1,1],clipped:[true,true]}));
    expect(screen.queryByText('Full scale reached')).not.toBeInTheDocument();
    rerender(<OutputControls value={undefined} meterSource={null} onChange={change}/>);
    expect(second.listeners.size).toBe(0);
    expect(screen.getByLabelText('Left held peak')).toHaveTextContent('−∞');
    expect(screen.getByText('Start listening to see levels.')).toBeVisible();
    unmount();
    expect(change).not.toHaveBeenCalled();
  });

  it('shows an output error and honors the containing disabled fieldset',()=>{
    const feed=meterSource({...silent,available:false,error:'Output processor could not start.'});
    const change=vi.fn();
    render(<Harness initial={{enabled:true,ceilingDb:-2}} source={feed.source} onChange={change} disabled/>);
    expect(screen.getByRole('alert')).toHaveTextContent('Output processor could not start.');
    expect(screen.getByRole('button',{name:'Peak limiter'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'Reset peaks'})).toBeDisabled();
    fireEvent.change(screen.getByRole('slider',{name:'Output ceiling'}),{target:{value:'-4'}});
    fireEvent.click(screen.getByRole('button',{name:'Peak limiter'}));
    expect(change).not.toHaveBeenCalled();
  });
});
