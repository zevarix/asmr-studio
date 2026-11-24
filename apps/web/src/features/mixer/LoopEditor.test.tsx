import {describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen} from '@testing-library/react';
import {fixtureLayer} from '../../../../../tests/fixtures/scene.js';
import {LayerControls} from './LayerControls.js';

const layer = fixtureLayer({loop:{startSeconds:0,endSeconds:1,crossfadeSeconds:.1}});
const decoded = {status:'ready',sampleRate:10,frameCount:20} as const;

describe('visual loop editor',()=>{
  it('keeps an existing custom loop and uses the prepared default only when looping is switched back on',()=>{
    const onCommand=vi.fn();
    const preferredLoop={startSeconds:0,endSeconds:2,crossfadeSeconds:0};
    const {rerender}=render(<LayerControls layer={layer} durationSeconds={2} preferredLoop={preferredLoop}
      loopEditorOpen onCommand={onCommand}/>);
    expect(screen.getByRole('spinbutton',{name:'Loop end'})).toHaveValue(1);
    expect(onCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox',{name:'Loop'}));
    expect(onCommand).toHaveBeenLastCalledWith({type:'setLayerLoop',layerId:layer.id,loop:null});
    rerender(<LayerControls layer={{...layer,loop:null}} durationSeconds={2} preferredLoop={preferredLoop} onCommand={onCommand}/>);
    fireEvent.click(screen.getByRole('checkbox',{name:'Loop'}));
    expect(onCommand).toHaveBeenLastCalledWith({type:'setLayerLoop',layerId:layer.id,loop:preferredLoop});
  });

  it('uses the ordinary loop when a catalog default is longer than the recording',()=>{
    const onCommand=vi.fn();
    render(<LayerControls layer={{...layer,loop:null}} durationSeconds={2}
      preferredLoop={{startSeconds:0,endSeconds:20,crossfadeSeconds:.02}} onCommand={onCommand}/>);
    fireEvent.click(screen.getByRole('checkbox',{name:'Loop'}));
    expect(onCommand).toHaveBeenLastCalledWith({type:'setLayerLoop',layerId:layer.id,
      loop:{startSeconds:0,endSeconds:1.975,crossfadeSeconds:.02}});
  });

  it('previews the exact draft and sends a scene command only when applied',()=>{
    const onCommand = vi.fn();
    const onPlay = vi.fn();
    render(<LayerControls layer={layer} durationSeconds={2} loopEditorOpen waveform={decoded} onCommand={onCommand}
      loopPreview={{state:{status:'idle'},disabled:false,onPlay,onStop:vi.fn()}}/>);

    const crossfade = screen.getByRole('spinbutton',{name:'Loop crossfade'});
    fireEvent.change(crossfade,{target:{value:'.1375'}});
    fireEvent.click(screen.getByRole('button',{name:'Preview join'}));

    expect(onPlay).toHaveBeenCalledExactlyOnceWith({startSeconds:0,endSeconds:1,crossfadeSeconds:.1375});
    expect(onCommand).not.toHaveBeenCalled();
    expect(crossfade).toBeValid();
    fireEvent.click(screen.getByRole('button',{name:'Apply loop'}));
    expect(onCommand).toHaveBeenCalledExactlyOnceWith({type:'setLayerLoop',layerId:layer.id,
      loop:{startSeconds:0,endSeconds:1,crossfadeSeconds:.1375}});
  });

  it('validates the draft with decoded duration and frame rounding',()=>{
    const onCommand = vi.fn();
    render(<LayerControls layer={layer} durationSeconds={3} loopEditorOpen waveform={decoded} onCommand={onCommand}/>);
    const end = screen.getByRole('spinbutton',{name:'Loop end'});
    const start = screen.getByRole('spinbutton',{name:'Loop start'});
    const fade = screen.getByRole('spinbutton',{name:'Loop crossfade'});
    const apply = screen.getByRole('button',{name:'Apply loop'});

    fireEvent.change(end,{target:{value:'2.5'}});
    fireEvent.click(apply);
    expect(screen.getByRole('alert')).toHaveTextContent(/within the recording/);

    fireEvent.change(start,{target:{value:'.96'}});
    fireEvent.change(end,{target:{value:'1.02'}});
    fireEvent.change(fade,{target:{value:'0'}});
    fireEvent.click(apply);
    expect(screen.getByRole('alert')).toHaveTextContent(/decoded sample/);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('keeps exact numeric editing and applying available when waveform decoding fails',()=>{
    const onCommand = vi.fn();
    render(<LayerControls layer={layer} durationSeconds={2} loopEditorOpen waveform={{status:'error'}} onCommand={onCommand}
      loopPreview={{state:{status:'idle'},disabled:false,onPlay:vi.fn(),onStop:vi.fn()}}/>);

    expect(screen.getByText(/waveform unavailable/i)).toBeVisible();
    expect(screen.getByRole('button',{name:'Preview join'})).toBeDisabled();
    fireEvent.change(screen.getByRole('spinbutton',{name:'Loop start'}),{target:{value:'.125'}});
    fireEvent.click(screen.getByRole('button',{name:'Apply loop'}));
    expect(onCommand).toHaveBeenCalledExactlyOnceWith({type:'setLayerLoop',layerId:layer.id,
      loop:{startSeconds:.125,endSeconds:1,crossfadeSeconds:.1}});
  });

  it('offers join preview when decoded audio is ready despite missing waveform peaks',()=>{
    render(<LayerControls layer={layer} durationSeconds={2} loopEditorOpen waveform={{...decoded,status:'error'}}
      onCommand={vi.fn()} loopPreview={{state:{status:'idle'},disabled:false,onPlay:vi.fn(),onStop:vi.fn()}}/>);

    expect(screen.getByRole('button',{name:'Preview join'})).toBeEnabled();
    expect(screen.queryByText(/pause the mix/i)).not.toBeInTheDocument();
  });

  it('stops a pending join when a draft edit changes what would be previewed',()=>{
    const onStop = vi.fn();
    const onCommand = vi.fn();
    render(<LayerControls layer={layer} durationSeconds={2} loopEditorOpen waveform={decoded} onCommand={onCommand}
      loopPreview={{state:{status:'loading'},disabled:false,onPlay:vi.fn(),onStop}}/>);

    fireEvent.change(screen.getByRole('spinbutton',{name:'Loop end'}),{target:{value:'1.6'}});
    expect(onStop).toHaveBeenCalledOnce();
    expect(onCommand).not.toHaveBeenCalled();
  });
});
