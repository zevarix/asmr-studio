import {useState} from 'react';
import {describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,within} from '@testing-library/react';
import {flatEqualizer,type EqualizerSettings} from '@asmr-studio/contracts';
import {EqualizerControls} from './EqualizerControls.js';

const adjusted:EqualizerSettings = {bassDb:3,midDb:-2,trebleDb:1.5,bypassed:false};

function Harness({initial=adjusted,onChange,disabled=false,outerDisabled=false}:{
  initial?:EqualizerSettings;onChange:(value:EqualizerSettings)=>void;disabled?:boolean;outerDisabled?:boolean;
}) {
  const [value,setValue] = useState(initial);
  return <fieldset disabled={outerDisabled}><EqualizerControls label="Master equalizer" value={value} disabled={disabled}
    onChange={next => {onChange(next); setValue(next);}}/></fieldset>;
}

function slider(band:'Bass'|'Mid'|'Treble'):HTMLInputElement {
  return screen.getByRole('slider',{name:'Master equalizer ' + band}) as HTMLInputElement;
}

function pointerCapture(element:HTMLInputElement,size=72) {
  const captured = new Set<number>();
  const set = vi.fn((id:number) => {captured.add(id);});
  const release = vi.fn((id:number) => {captured.delete(id);});
  Object.defineProperties(element,{
    getBoundingClientRect:{configurable:true,value:() => new DOMRect(100,100,size,size)},
    setPointerCapture:{configurable:true,value:set},
    hasPointerCapture:{configurable:true,value:(id:number) => captured.has(id)},
    releasePointerCapture:{configurable:true,value:release},
  });
  return {captured,set,release};
}

function around(degrees:number,size=72) {
  const angle = degrees * Math.PI / 180;
  const center = 100 + size / 2;
  const radius = size / 2 - 6;
  return {clientX:center + Math.sin(angle) * radius,clientY:center - Math.cos(angle) * radius};
}

const pointer = {pointerId:7,isPrimary:true,pointerType:'mouse',button:0,buttons:1,...around(0)};

describe('equalizer controls',() => {
  it('uses labelled native ranges with neutral defaults and keeps compact groups independently accessible',() => {
    const {rerender} = render(<EqualizerControls label="Master equalizer" value={undefined} onChange={vi.fn()}/>);
    const group = screen.getByRole('group',{name:'Master equalizer'});
    expect(within(group).getByRole('heading',{name:'Master equalizer'})).toBeVisible();
    expect(within(group).getByText('Tone for the whole mix')).toBeVisible();
    expect(within(group).getAllByText('0 dB')).toHaveLength(3);
    for (const band of ['Bass','Mid','Treble'] as const) {
      const input = slider(band);
      expect(input).toHaveAttribute('type','range');
      expect(input).toHaveAttribute('min','-12');
      expect(input).toHaveAttribute('max','12');
      expect(input).toHaveAttribute('step','0.5');
      expect(input).toHaveAttribute('aria-valuetext','0 decibels');
      expect(input).toHaveValue('0');
    }
    expect(within(group).getByRole('button',{name:'Bypass'})).toHaveAttribute('aria-pressed','false');
    rerender(<EqualizerControls label="Rain equalizer" value={adjusted} onChange={vi.fn()} compact hideTitle/>);
    const compact = screen.getByRole('group',{name:'Rain equalizer'});
    expect(within(compact).queryByRole('heading')).not.toBeInTheDocument();
    expect(within(compact).getByRole('slider',{name:'Rain equalizer Bass'})).toHaveValue('3');
    expect(within(compact).getByRole('button',{name:'Reset'})).toBeVisible();
    expect(within(compact).getByText('Warmth')).toBeVisible();
    expect(within(compact).getByText('Detail')).toBeVisible();
    expect(within(compact).getByText('Air')).toBeVisible();
  });

  it('accepts native range changes, preserves other bands and leaves keyboard handling to the browser',() => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange}/>);
    const bass = slider('Bass');
    fireEvent.change(bass,{target:{value:'-1.5'}});
    expect(onChange).toHaveBeenLastCalledWith({...adjusted,bassDb:-1.5});
    expect(screen.getByText('-1.5 dB')).toBeVisible();
    expect(slider('Mid')).toHaveValue('-2');
    expect(slider('Treble')).toHaveValue('1.5');
    // jsdom does not execute native range keyboard defaults; the browser suite does.
    for (const key of ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End']) {
      const event = new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});
      fireEvent(bass,event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('bypasses without losing settings, prevents edits while bypassed, and resets to enabled neutral bands',() => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange}/>);
    const bypass = screen.getByRole('button',{name:'Bypass'});
    fireEvent.click(bypass);
    expect(onChange).toHaveBeenLastCalledWith({...adjusted,bypassed:true});
    expect(bypass).toHaveAttribute('aria-pressed','true');
    for (const input of screen.getAllByRole('slider')) expect(input).toBeDisabled();
    expect(slider('Bass')).toHaveValue('3');
    expect(screen.getByText('+3 dB')).toBeVisible();
    fireEvent.pointerDown(slider('Bass'),pointer);
    fireEvent.change(slider('Bass'),{target:{value:'8'}});
    fireEvent.doubleClick(slider('Mid'));
    expect(onChange).toHaveBeenCalledOnce();
    fireEvent.click(bypass);
    expect(onChange).toHaveBeenLastCalledWith(adjusted);
    expect(slider('Bass')).not.toBeDisabled();
    expect(slider('Bass')).toHaveValue('3');
    fireEvent.click(bypass);
    fireEvent.click(screen.getByRole('button',{name:'Reset'}));
    expect(onChange).toHaveBeenLastCalledWith(flatEqualizer());
    expect(bypass).toHaveAttribute('aria-pressed','false');
    for (const input of screen.getAllByRole('slider')) {
      expect(input).not.toBeDisabled(); expect(input).toHaveValue('0');
    }
  });

  it.each([64,72])('turns a %i pixel knob in both directions without click jumps or competing pointers',size => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange}/>);
    const bass = slider('Bass');
    const capture = pointerCapture(bass,size);
    fireEvent.pointerDown(bass,{...pointer,...around(0,size)});
    expect(bass).toHaveFocus();
    expect(capture.set).toHaveBeenCalledWith(7);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerDown(bass,{...pointer,pointerId:8,isPrimary:false});
    fireEvent.pointerMove(bass,{...pointer,pointerId:8,...around(45,size)});
    expect(onChange).not.toHaveBeenCalled();
    expect(capture.set).toHaveBeenCalledOnce();
    fireEvent.pointerMove(bass,{...pointer,...around(45,size)});
    expect(onChange).toHaveBeenLastCalledWith({...adjusted,bassDb:7});
    fireEvent.pointerMove(bass,{...pointer,...around(45.1,size)});
    expect(onChange).toHaveBeenCalledOnce();
    fireEvent.pointerUp(bass,{...pointer,buttons:0,...around(22.5,size)});
    expect(onChange).toHaveBeenLastCalledWith({...adjusted,bassDb:5});
    expect(capture.release).toHaveBeenCalledWith(7);
    fireEvent.pointerMove(bass,{...pointer,...around(90,size)});
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('reverses immediately at either end stop and double-click resets only the selected band',() => {
    const onChange = vi.fn();
    render(<Harness initial={{...adjusted,bassDb:11}} onChange={onChange}/>);
    const bass = slider('Bass');
    pointerCapture(bass);
    fireEvent.pointerDown(bass,pointer);
    fireEvent.pointerMove(bass,{...pointer,...around(45)});
    expect(slider('Bass')).toHaveValue('12');
    fireEvent.pointerMove(bass,{...pointer,...around(90)});
    expect(onChange).toHaveBeenCalledOnce();
    fireEvent.pointerMove(bass,{...pointer,...around(78.75)});
    expect(bass).toHaveValue('11');
    for (const angle of [-45,-135,-180,135]) fireEvent.pointerMove(bass,{...pointer,...around(angle)});
    expect(onChange).toHaveBeenLastCalledWith({...adjusted,bassDb:-12});
    fireEvent.pointerUp(bass,{...pointer,buttons:0,...around(146.25)});
    expect(bass).toHaveValue('-11');
    fireEvent.doubleClick(bass);
    expect(onChange).toHaveBeenLastCalledWith({...adjusted,bassDb:0});
    expect(bass).toHaveValue('0');
    expect(slider('Mid')).toHaveValue('-2');
    expect(slider('Treble')).toHaveValue('1.5');
  });

  it('accumulates small circular movements before snapping to half-decibel steps',() => {
    render(<Harness onChange={vi.fn()}/>);
    const bass = slider('Bass');
    pointerCapture(bass);
    fireEvent.pointerDown(bass,pointer);
    for (let angle=1;angle<=45;angle++) fireEvent.pointerMove(bass,{...pointer,...around(angle)});
    expect(bass).toHaveValue('7');
  });

  it.each([{from:170,to:-170,want:'2'},{from:-170,to:170,want:'-2'}])(
    'crosses the bottom angle seam from $from to $to without a full-range jump',({from,to,want}) => {
      render(<Harness initial={flatEqualizer()} onChange={vi.fn()}/>);
      const bass = slider('Bass');
      pointerCapture(bass);
      fireEvent.pointerDown(bass,{...pointer,...around(from)});
      fireEvent.pointerUp(bass,{...pointer,buttons:0,...around(to)});
      expect(bass).toHaveValue(want);
    });

  it('ignores the unstable center and resumes turning without jumping across the dial',() => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange}/>);
    const bass = slider('Bass');
    pointerCapture(bass);
    fireEvent.pointerDown(bass,pointer);
    fireEvent.pointerMove(bass,{...pointer,clientX:136,clientY:136});
    fireEvent.pointerMove(bass,{...pointer,...around(180)});
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(bass,{...pointer,buttons:0,...around(-135)});
    expect(bass).toHaveValue('7');
  });

  it('allows a touch beginning at the center to acquire a direction before turning',() => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange}/>);
    const bass = slider('Bass');
    pointerCapture(bass);
    const touch = {...pointer,pointerType:'touch'};
    fireEvent.pointerDown(bass,{...touch,clientX:136,clientY:136});
    fireEvent.pointerMove(bass,{...touch,...around(0)});
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(bass,{...touch,buttons:0,...around(45)});
    expect(bass).toHaveValue('7');
  });

  it('does not jump when a fast stroke crosses the center between pointer events',() => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange}/>);
    const bass = slider('Bass');
    pointerCapture(bass);
    fireEvent.pointerDown(bass,pointer);
    fireEvent.pointerMove(bass,{...pointer,...around(180)});
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(bass,{...pointer,buttons:0,...around(-135)});
    expect(bass).toHaveValue('7');
  });

  it.each(['cancel','lost capture'] as const)('ends a drag on %s and accepts a fresh gesture',ending => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange}/>);
    const mid = slider('Mid');
    const capture = pointerCapture(mid);
    fireEvent.pointerDown(mid,pointer);
    fireEvent.pointerMove(mid,{...pointer,...around(22.5)});
    expect(mid).toHaveValue('0');
    if (ending === 'cancel') {
      fireEvent.pointerCancel(mid,pointer);
      expect(capture.release).toHaveBeenCalledWith(7);
    } else {
      capture.captured.delete(7);
      fireEvent.lostPointerCapture(mid,pointer);
    }
    fireEvent.pointerMove(mid,{...pointer,clientY:0});
    expect(onChange).toHaveBeenCalledOnce();
    fireEvent.pointerDown(mid,{...pointer,pointerId:8});
    fireEvent.pointerUp(mid,{...pointer,pointerId:8,buttons:0,...around(5.625)});
    expect(onChange).toHaveBeenLastCalledWith({...adjusted,midDb:0.5});
  });

  it.each(['own fieldset','containing fieldset'] as const)('honors a disabled %s during a drag and for every action',source => {
    const onChange = vi.fn();
    const {rerender} = render(<Harness onChange={onChange}/>);
    const bass = slider('Bass');
    const capture = pointerCapture(bass);
    fireEvent.pointerDown(bass,pointer);
    rerender(<Harness onChange={onChange} disabled={source === 'own fieldset'} outerDisabled={source === 'containing fieldset'}/>);
    expect(bass).toBeDisabled();
    expect(capture.release).toHaveBeenCalledWith(7);
    fireEvent.pointerMove(bass,{...pointer,clientY:0});
    fireEvent.pointerDown(bass,{...pointer,pointerId:8});
    fireEvent.change(bass,{target:{value:'-8'}});
    fireEvent.doubleClick(bass);
    fireEvent.click(screen.getByRole('button',{name:'Reset'}));
    fireEvent.click(screen.getByRole('button',{name:'Bypass'}));
    expect(onChange).not.toHaveBeenCalled();
    expect(capture.set).toHaveBeenCalledOnce();
  });

  it('blocks wheel adjustment and releases its pointer capture and wheel listener on unmount',() => {
    const onChange = vi.fn();
    const {unmount} = render(<Harness onChange={onChange}/>);
    const bass = slider('Bass');
    const capture = pointerCapture(bass);
    bass.focus();
    const wheel = new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true});
    fireEvent(bass,wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerDown(bass,pointer);
    unmount();
    expect(capture.release).toHaveBeenCalledWith(7);
    const afterUnmount = new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true});
    fireEvent(bass,afterUnmount);
    expect(afterUnmount.defaultPrevented).toBe(false);
  });
});
