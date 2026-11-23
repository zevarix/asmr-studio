import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {parseAssetRecord, type AssetRecord} from '@asmr-studio/contracts';
import {fixtureAsset, fixtureLayer} from '../../../../../tests/fixtures/scene.js';
import {SourceDetails} from './SourceDetails.js';
import {SoundLibrary} from './SoundLibrary.js';

const asset = parseAssetRecord({...fixtureAsset(), displayName: 'Forest rain',
  provenance: {kind: 'licensed', source: 'Recorded by Test Artist. CC BY 4.0 (https://example.com/license). Edited to a 30-second excerpt.'}});
const label = `Source and permission for ${asset.displayName}`;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
let showModal: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // jsdom has no native top layer or focus trap; browser QA covers those platform behaviors.
  showModal = vi.fn(function(this: HTMLDialogElement) { this.setAttribute('open', ''); });
  close = vi.fn(function(this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute('open'); this.dispatchEvent(new Event('close'));
  });
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {configurable: true, value: showModal},
    close: {configurable: true, value: close},
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  for (const [name, descriptor] of [['showModal', originalShowModal], ['close', originalClose]] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
  vi.restoreAllMocks();
});

function openSource() {
  const button = screen.getByRole('button', {name: label});
  button.focus(); fireEvent.click(button);
  return {button, dialog: screen.getByRole('dialog', {name: label})};
}

describe('source and permission dialog', () => {
  it('opens a labelled native modal outside the tile, focuses close, and returns focus on dismissal', () => {
    const {container} = render(<div className="sound-tile"><SourceDetails asset={asset}/></div>);
    const button = screen.getByRole('button', {name: label});
    expect(button).not.toHaveFocus();
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(container.querySelector('dialog')).toBeNull();
    const {dialog} = openSource();
    expect(showModal).toHaveBeenCalledOnce(); expect(dialog.parentElement).toBe(document.body);
    expect(button).toHaveAttribute('aria-controls', dialog.id);
    expect(within(dialog).getByRole('heading', {name: asset.displayName})).toBeVisible();
    const closeButton = within(dialog).getByRole('button', {name: 'Close source and permission'});
    expect(closeButton).toHaveFocus();
    fireEvent.click(closeButton);
    expect(close).toHaveBeenCalledOnce(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('closes on native Escape cancellation and backdrop clicks without treating content or dragged clicks as dismissal', () => {
    render(<SourceDetails asset={asset}/>);
    const {button, dialog} = openSource();
    const cancelled = new Event('cancel', {cancelable: true});
    fireEvent(dialog, cancelled);
    expect(cancelled.defaultPrevented).toBe(true); expect(button).toHaveFocus();
    expect(dialog).not.toHaveAttribute('open');
    fireEvent.click(button);
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({x: 100, y: 100, left: 100, top: 100,
      right: 500, bottom: 500, width: 400, height: 400, toJSON: () => ({})});
    fireEvent.pointerDown(dialog, {clientX: 150, clientY: 150});
    fireEvent.click(dialog, {clientX: 150, clientY: 150});
    expect(dialog).toHaveAttribute('open');
    fireEvent.pointerDown(within(dialog).getByRole('heading', {name: 'Source'}), {clientX: 150, clientY: 150});
    fireEvent.click(dialog, {clientX: 10, clientY: 10});
    expect(dialog).toHaveAttribute('open');
    fireEvent.pointerDown(dialog, {clientX: 10, clientY: 10});
    fireEvent.click(dialog, {clientX: 10, clientY: 10});
    expect(dialog).not.toHaveAttribute('open'); expect(button).toHaveFocus();
  });

  it('preserves complete attribution text and describes each actual permission state', () => {
    const {rerender} = render(<SourceDetails asset={asset}/>);
    const {dialog} = openSource();
    expect(within(dialog).getByText(asset.provenance.source!)).toBeVisible();
    expect(within(dialog).getByText('Private use permitted.')).toBeVisible();
    const messages = {
      permitted: 'Redistribution permitted under the source terms.',
      forbidden: 'Redistribution is not permitted.',
      unknown: 'Redistribution permission is not recorded.',
    } as const;
    for (const redistribution of ['permitted', 'forbidden', 'unknown'] as const) {
      rerender(<SourceDetails asset={{...asset, rights: {privateUse: 'permitted', redistribution}}}/>);
      expect(within(dialog).getByText(messages[redistribution])).toBeVisible();
      expect(within(dialog).getByText(asset.provenance.source!)).toBeVisible();
    }
    rerender(<SourceDetails asset={{...asset, rights: {privateUse: 'unknown', redistribution: 'unknown'}}}/>);
    expect(within(dialog).getByText('Private-use permission is not recorded.')).toBeVisible();
    expect(within(dialog).queryByText('Private use permitted.')).not.toBeInTheDocument();
  });

  it('retains the original-recording and missing-source explanations', () => {
    const {rerender} = render(<SourceDetails asset={{...asset, provenance: {kind: 'original', source: null}}}/>);
    const {dialog} = openSource();
    expect(within(dialog).getByText('Original recording')).toBeVisible();
    rerender(<SourceDetails asset={{...asset, provenance: {kind: 'unknown', source: null}}}/>);
    expect(within(dialog).getByText('Source not recorded')).toBeVisible();
  });

  it('keeps HTTP and HTTPS source URLs visible and opens them without opener access', () => {
    const {rerender} = render(<SourceDetails asset={asset}/>);
    const {dialog} = openSource();
    for (const source of ['https://example.com/recording?take=2', 'http://example.com/credits']) {
      rerender(<SourceDetails asset={{...asset, provenance: {kind: 'licensed', source}}}/>);
      const link = within(dialog).getByRole('link', {name: source});
      expect(link).toHaveAttribute('href', source); expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('shows unsafe URL schemes and markup as text instead of executable links or HTML', () => {
    const {rerender} = render(<SourceDetails asset={asset}/>);
    const {dialog} = openSource();
    for (const source of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///private/source.wav', '<img src=x onerror=alert(1)>']) {
      rerender(<SourceDetails asset={{...asset, provenance: {kind: 'licensed', source}}}/>);
      expect(within(dialog).getByText(source)).toBeVisible();
      expect(within(dialog).queryByRole('link')).not.toBeInTheDocument();
      expect(dialog.querySelector('script, img')).toBeNull();
    }
  });

  it('does not restore focus to a disconnected trigger when an open tile unmounts', () => {
    const {unmount} = render(<SourceDetails asset={asset}/>);
    const {button} = openSource();
    const focus = vi.spyOn(button, 'focus');
    unmount();
    expect(close).toHaveBeenCalledOnce(); expect(focus).not.toHaveBeenCalled();
    expect(document.querySelector('.source-dialog')).toBeNull();
  });
});

describe('source information in the sound library', () => {
  it('leaves the selected sound and its preview running while opening and closing information', async () => {
    const onCommand = vi.fn(); const onAddAsset = vi.fn();
    const {container} = render(<SoundLibrary assets={[asset]} layers={[fixtureLayer()]} mixActive={false}
      onCommand={onCommand} onAddAsset={onAddAsset}/>);
    await act(async () => { fireEvent.click(screen.getByRole('button', {name: `Preview ${asset.displayName}`})); });
    expect(screen.getByRole('button', {name: `Stop preview of ${asset.displayName}`})).toHaveAttribute('aria-pressed', 'true');
    vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
    vi.mocked(HTMLMediaElement.prototype.load).mockClear();
    vi.mocked(HTMLMediaElement.prototype.play).mockClear();
    const tile = container.querySelector('.sound-tile')!;
    const children = Array.from(tile.children);
    const {dialog, button} = openSource();
    expect(Array.from(tile.children)).toEqual(children); expect(tile.querySelector('dialog')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', {name: 'Close source and permission'}));
    expect(button).toHaveFocus();
    expect(screen.getByRole('button', {name: `Stop preview of ${asset.displayName}`})).toHaveAttribute('aria-pressed', 'true');
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
    expect(onCommand).not.toHaveBeenCalled(); expect(onAddAsset).not.toHaveBeenCalled();
  });

  it('keeps source information available during a playing mix without sending scene commands', () => {
    const onCommand = vi.fn(); const onAddAsset = vi.fn();
    render(<SoundLibrary assets={[asset] as AssetRecord[]} layers={[fixtureLayer()]} mixActive
      onCommand={onCommand} onAddAsset={onAddAsset}/>);
    expect(screen.getByRole('button', {name: `Preview ${asset.displayName}`})).toBeDisabled();
    expect(screen.getByRole('button', {name: label})).toBeEnabled();
    openSource();
    expect(onCommand).not.toHaveBeenCalled(); expect(onAddAsset).not.toHaveBeenCalled();
  });
});
