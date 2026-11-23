import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { parseScene } from '@asmr-studio/contracts';
import { fixtureLayer, fixtureScene } from '../../../../../tests/fixtures/scene.js';
import { MixerView } from './MixerView.js';
import { App } from '../../App.js';
import type { PlaybackSnapshot } from '@asmr-studio/audio-engine';

const snapshot = (state: PlaybackSnapshot['state'], error: string | null = null): PlaybackSnapshot =>
  ({state, error, loadedAssetIds: [], positionSeconds: 12});

function configured() {
  const scene = parseScene({
    ...fixtureScene(),
    layers: [
      fixtureLayer({id:'ambience', role:'ambience', gain:0.4}),
      fixtureLayer({id:'narration', role:'narration', assetId:'asset-voice', gain:0.3}),
    ],
  });
  const onCommand = vi.fn();
  const onStart = vi.fn();
  const onPause = vi.fn();
  const onStop = vi.fn();
  return {scene,onCommand,onStart,onPause,onStop};
}

describe('accessible listening mixer', () => {
  it('provides an explicit Start listening action, never starting on mount', () => {
    const props = configured();
    render(<MixerView {...props} playback={snapshot('ready')} />);
    expect(screen.getByRole('button',{name:'Start listening'})).toBeEnabled();
    expect(props.onStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Start listening'}));
    expect(props.onStart).toHaveBeenCalledOnce();
  });

  it('labels its master slider and exposes its exact numeric value', () => {
    const props = configured();
    render(<MixerView {...props} playback={snapshot('ready')} />);
    expect(screen.getByRole('slider',{name:'Master volume'})).toHaveValue('25');
    expect(screen.getByText('25%')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('slider',{name:'Master volume'}), {target:{value:'60'}});
    expect(props.onCommand).toHaveBeenCalledWith({type:'setMasterGain',gain:0.6});
  });

  it('changes narration gain without sending changes to ambience', () => {
    const props = configured();
    render(<MixerView {...props} playback={snapshot('ready')} />);
    const narration = within(screen.getByRole('group',{name:'Narration: narration'}));
    fireEvent.change(narration.getByRole('slider',{name:'Volume'}), {target:{value:'80'}});
    expect(props.onCommand).toHaveBeenCalledExactlyOnceWith({type:'setLayerGain',layerId:'narration',gain:0.8});
    const ambience = within(screen.getByRole('group',{name:'Ambience: ambience'}));
    expect(ambience.getByRole('slider',{name:'Volume'})).toHaveValue('40');
  });

  it('can remove a selected layer without changing its neighbor', () => {
    const props=configured();
    render(<MixerView {...props} playback={snapshot('ready')} />);
    const narration=within(screen.getByRole('group',{name:'Narration: narration'}));
    fireEvent.click(narration.getByRole('button',{name:'Remove'}));
    expect(props.onCommand).toHaveBeenCalledExactlyOnceWith({type:'removeLayer',layerId:'narration'});
    expect(screen.getByRole('group',{name:'Ambience: ambience'})).toBeInTheDocument();
  });

  it('provides keyboard-operable pressed mute/solo and labeled pan', () => {
    const props = configured();
    render(<MixerView {...props} playback={snapshot('playing')} />);
    const narration = within(screen.getByRole('group',{name:'Narration: narration'}));
    const mute = narration.getByRole('button',{name:'Mute'});
    const solo = narration.getByRole('button',{name:'Solo'});
    expect(mute).toHaveAttribute('aria-pressed','false');
    mute.focus();
    fireEvent.keyDown(mute,{key:'Enter'});
    fireEvent.click(mute);
    expect(props.onCommand).toHaveBeenCalledWith({type:'setMuted',layerId:'narration',muted:true});
    fireEvent.click(solo);
    expect(props.onCommand).toHaveBeenCalledWith({type:'setSolo',layerId:'narration',solo:true});
    expect(narration.getByRole('slider',{name:'Stereo position'})).toHaveValue('0');
  });

  it('explains an empty library and disables starting without sound', () => {
    const props = configured();
    render(<MixerView {...props} scene={parseScene({...props.scene,layers:[]})} playback={snapshot('idle')} />);
    expect(screen.getByText(/Import audio to start building your session/i)).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Start listening'})).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Idle/i);
  });

  it.each(['loading','interrupted','error'] as const)('reports %s as text, not color or animation',state => {
    const props = configured();
    render(<MixerView {...props} playback={snapshot(state,state==='error'?'Audio could not be decoded':null)} />);
    expect(screen.getByRole('status')).toHaveTextContent(new RegExp(state,'i'));
    if(state==='error') expect(screen.getByRole('alert')).toHaveTextContent(/Audio could not be decoded/);
  });

  it('does not steal keyboard focus when a recoverable error appears', () => {
    const props = configured();
    const {rerender} = render(<MixerView {...props} playback={snapshot('ready')} />);
    const slider = screen.getByRole('slider',{name:'Master volume'});
    slider.focus();
    rerender(<MixerView {...props} playback={snapshot('error','Unable to open media')} />);
    expect(slider).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent(/Unable to open media/);
  });

  it('starts the unconfigured application with no audio autoplay or invented sample recording', () => {
    render(<App/>);
    expect(screen.getByRole('button',{name:'Start listening'})).toBeDisabled();
    expect(screen.queryByText(/sample recording/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Import audio to start building your session/i)).toBeInTheDocument();
  });
});
