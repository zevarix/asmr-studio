import {useEffect, useRef, useState, type ReactNode,type RefObject} from 'react';
import type {AssetRecord, Layer, SceneCommand} from '@asmr-studio/contracts';
import {formatDuration, roleNames} from './sound-utils.js';
import {SourceDetails} from './SourceDetails.js';
import IconCheck from '@tabler/icons-react/icons/IconCheck';
import IconChevronRight from '@tabler/icons-react/icons/IconChevronRight';
import IconLibrary from '@tabler/icons-react/icons/IconLibrary';
import IconPlayerPlay from '@tabler/icons-react/icons/IconPlayerPlay';
import IconPlayerStop from '@tabler/icons-react/icons/IconPlayerStop';
import IconPlus from '@tabler/icons-react/icons/IconPlus';
import IconSearch from '@tabler/icons-react/icons/IconSearch';
import {SoundIcon} from './SoundIcon.js';
import {RangeInput} from './RangeInput.js';

interface Props {
  assets: AssetRecord[];
  layers: Layer[];
  onAddAsset?: ((asset: AssetRecord, role: Layer['role']) => void) | undefined;
  onCommand: (command: SceneCommand) => void;
  mixActive: boolean;
  previewStopToken?: number;
  previewStopRef?:RefObject<(()=>void)|null>;
  onPreviewStart?:()=>void;
  importTools?: ReactNode;
  onInstallStarterSounds?: (() => Promise<void>) | undefined;
}

export function SoundLibrary({assets, layers, onAddAsset, onCommand, mixActive,
  previewStopToken = 0, previewStopRef,onPreviewStart,importTools, onInstallStarterSounds}: Props) {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<'all' | Layer['role']>('all');
  const [activeOnly, setActiveOnly] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installMessage, setInstallMessage] = useState('');
  const [installError, setInstallError] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const previewGeneration = useRef(0);
  const previewing = useRef<string | null>(null);
  const installationPending = useRef(false);

  const stopPreview = () => {
    previewGeneration.current++;
    previewing.current = null;
    const element = audio.current;
    if (element?.getAttribute('src')) {
      element.pause();
      element.removeAttribute('src');
      element.load();
    }
    setPreviewId(null);
  };
  useEffect(()=>{
    if(!previewStopRef)return;
    previewStopRef.current=stopPreview;
    return()=>{if(previewStopRef.current===stopPreview)previewStopRef.current=null;};
  },[previewStopRef]);
  useEffect(() => {
    if (mixActive) stopPreview();
  }, [mixActive]);
  useEffect(() => { stopPreview(); }, [previewStopToken]);
  useEffect(() => {
    const element = audio.current;
    return () => {
      previewGeneration.current++;
      if (element?.getAttribute('src')) {
        element.pause();
        element.removeAttribute('src');
        element.load();
      }
    };
  }, []);

  const preview = async (asset: AssetRecord) => {
    if (mixActive) return;
    const wasPlaying = previewing.current === asset.id;
    stopPreview();
    setPreviewError('');
    if (wasPlaying) return;
    onPreviewStart?.();
    const element = audio.current;
    if (!element) return;
    const generation = previewGeneration.current;
    previewing.current = asset.id;
    setPreviewId(asset.id);
    element.src = '/api/assets/' + encodeURIComponent(asset.id) + '/content';
    element.volume = .25;
    try { await element.play(); }
    catch {
      if (generation !== previewGeneration.current) return;
      stopPreview();
      setPreviewError('This recording could not be previewed. Try importing a browser-supported audio file.');
    }
  };
  const install = async () => {
    if (!onInstallStarterSounds || installationPending.current) return;
    installationPending.current = true;
    setInstalling(true); setInstallMessage(''); setInstallError(false);
    try {
      await onInstallStarterSounds();
      setInstallMessage('Starter sounds are ready. Choose a sound to add it to your mix.');
    } catch {
      setInstallError(true);
      setInstallMessage('Starter sounds could not be added. Your existing recordings and mix are still here. Try again when the connection is available.');
    } finally { installationPending.current = false; setInstalling(false); }
  };

  const byAsset = new Map<string, Layer[]>();
  for (const layer of layers) {
    const selected = byAsset.get(layer.assetId) ?? [];
    selected.push(layer); byAsset.set(layer.assetId, selected);
  }
  const needle = query.trim().toLocaleLowerCase();
  const filtered = assets.filter(asset =>
    (role === 'all' || asset.roles.includes(role)) &&
    (!activeOnly || byAsset.has(asset.id)) &&
    (!needle || (asset.displayName + ' ' + asset.roles.map(value => roleNames[value]).join(' ')).toLocaleLowerCase().includes(needle)));

  return <section className="library panel" aria-label="Sound library">
    <div className="panel-head"><div><h2>Sound library</h2>
      <p className="panel-description">Choose sounds, then balance each layer.</p></div>
      <span className="count-label">{assets.length} {assets.length === 1 ? 'sound' : 'sounds'}</span>
    </div>
    <audio ref={audio} preload="none" onEnded={stopPreview}
      onError={() => {
        if (previewing.current) { stopPreview(); setPreviewError('This recording could not be previewed.'); }
      }}/>
    {assets.length === 0 && <div className="library-empty">
      <p className="empty-copy">Import audio to start building your session. Your recordings stay private to your studio.</p>
      {onInstallStarterSounds && <button type="button" className="primary" disabled={installing} onClick={() => {void install();}}>
        {installing ? 'Adding starter sounds…' : 'Add starter sounds'}</button>}
    </div>}
    {assets.length > 0 && <>
      <div className="library-search">
        <label className="search-field"><IconSearch size={18} stroke={1.7} aria-hidden="true"/><span className="sr-only">Search sounds</span><input type="search" aria-label="Search sounds"
          placeholder="Search sounds…" value={query} onChange={event => setQuery(event.target.value)}/></label>
        <label className="active-filter"><input type="checkbox" checked={activeOnly}
          onChange={event => setActiveOnly(event.target.checked)}/>In this mix</label>
      </div>
      <div className="sound-categories" role="group" aria-label="Sound categories">
        {(['all', 'ambience', 'texture', 'narration'] as const).map(value => <button type="button" key={value}
          aria-pressed={role === value} onClick={() => setRole(value)}>
          {value === 'all' ? 'All sounds' : value === 'texture' ? 'Textures' : roleNames[value]}</button>)}
      </div>
      <p className="library-result-count">{filtered.length} {filtered.length === 1 ? 'sound' : 'sounds'}{activeOnly ? ' in this mix' : ''}
        {mixActive ? ' · Pause the mix to preview a recording.' : ' · Preview recordings before adding them.'}</p>
      {filtered.length === 0
        ? <p className="empty-copy">No sounds match these filters. Try another search or category.</p>
        : <ul className="sound-grid">{filtered.map(asset => {
          const active = byAsset.get(asset.id) ?? [];
          const selected = active.length > 0;
          const primary = active[0];
          const addRole = role !== 'all' && asset.roles.includes(role) ? role : asset.roles[0]!;
          return <li key={asset.id} className={'sound-tile' + (selected ? ' is-selected' : '')}>
            <button type="button" className="sound-toggle" aria-pressed={selected}
              aria-label={selected ? 'Remove ' + asset.displayName + ' from mix' : 'Add ' + asset.displayName + ' as ' + addRole}
              disabled={!selected && !onAddAsset} onClick={() => {
                stopPreview();
                if (selected) for (const layer of active) onCommand({type:'removeLayer', layerId:layer.id});
                else onAddAsset?.(asset, addRole);
              }}>
              <span className="sound-kind-icon"><SoundIcon name={asset.displayName} role={asset.roles[0]!}/></span>
              <span className="sound-title"><strong>{asset.displayName}</strong>
                <small>{asset.roles.map(value => roleNames[value]).join(' · ')}</small></span>
              <span className="sound-mark" aria-hidden="true">{selected ? <IconCheck size={14} stroke={2}/> : <IconPlus size={14} stroke={1.7}/>}</span>
            </button>
            <div className="sound-meta"><span>{formatDuration(asset.durationSeconds)}</span>
              <span>{asset.channels === 1 ? 'Mono' : 'Stereo'}</span>
              {selected && <span className="selected-label">{active.length === 1 ? 'In mix' : active.length + ' layers'}</span>}
            </div>
            <div className="tile-level-slot">{primary && active.length === 1 && <label className="tile-level">
              <span className="sr-only">{asset.displayName} volume</span>
              <RangeInput aria-label={asset.displayName + ' volume'} min="0" max="100" step="1"
                value={Math.round(primary.gain * 100)} onChange={event => onCommand({type:'setLayerGain',layerId:primary.id,gain:Number(event.target.value)/100})}/>
              <span>{Math.round(primary.gain * 100)}%</span>
            </label>}
            {active.length > 1 && <p className="tile-note">Adjust each layer in the active mix.</p>}</div>
            <div className="sound-footer"><button type="button" className="preview-button" disabled={mixActive}
              aria-label={(previewId === asset.id ? 'Stop preview of ' : 'Preview ') + asset.displayName}
              aria-pressed={previewId === asset.id} onClick={() => {void preview(asset);}}>
              {previewId === asset.id ? <IconPlayerStop size={15} stroke={1.7} aria-hidden="true"/> : <IconPlayerPlay size={15} stroke={1.7} aria-hidden="true"/>}
              {previewId === asset.id ? 'Stop preview' : 'Preview'}</button>
              <SourceDetails asset={asset}/></div>
          </li>;
        })}</ul>}
    </>}
    {previewError && <p className="error" role="alert">{previewError}</p>}
    {installMessage && <p className={installError ? 'error' : ''} role={installError ? 'alert' : undefined}>{installMessage}</p>}
    <div className="library-imports">{importTools}
      {assets.length > 0 && onInstallStarterSounds && <details className="starter-details">
        <summary><span className="summary-label"><IconLibrary size={18} stroke={1.7} aria-hidden="true"/>Starter sounds</span><IconChevronRight className="summary-chevron" size={18} stroke={1.7} aria-hidden="true"/></summary><p>Add the studio's collection to your library. Existing recordings stay available.</p>
        <button type="button" disabled={installing} onClick={() => {void install();}}>{installing ? 'Adding starter sounds…' : 'Add starter sounds'}</button>
      </details>}
    </div>
  </section>;
}
