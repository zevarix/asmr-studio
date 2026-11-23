import {useEffect,useId,useState} from 'react';
import IconChevronRight from '@tabler/icons-react/icons/IconChevronRight';
import IconPlus from '@tabler/icons-react/icons/IconPlus';
import IconRefresh from '@tabler/icons-react/icons/IconRefresh';
import IconArrowsShuffle from '@tabler/icons-react/icons/IconArrowsShuffle';
import IconX from '@tabler/icons-react/icons/IconX';
import {defaultOccasional,OCCASIONAL_MIN_PAUSE_SECONDS,OCCASIONAL_MAX_PAUSE_SECONDS,OCCASIONAL_MAX_ALTERNATES,
  type AssetRecord,type Layer,type OccasionalSettings} from '@asmr-studio/contracts';
import {RangeInput} from './RangeInput.js';
import './OccasionalControls.css';

interface Props {layer:Layer;assets:AssetRecord[];label:string;onChange:(settings:OccasionalSettings)=>void}
function newSeed(previous?:number):number {
  const value=crypto.getRandomValues(new Uint32Array(1))[0]!;
  return value===previous?(value+1)>>>0:value;
}

/** Controls edit a saved recipe. The audio clock and seeded scheduler own the events. */
export function OccasionalControls({layer,assets,label,onChange}:Props) {
  const settings=layer.occasional??defaultOccasional();
  const [minimum,setMinimum]=useState(String(settings.minPauseSeconds));
  const [maximum,setMaximum]=useState(String(settings.maxPauseSeconds));
  const [query,setQuery]=useState(''),[selected,setSelected]=useState('');
  const modeId=useId(),minId=useId(),maxId=useId(),pauseHintId=useId(),searchId=useId(),selectId=useId(),levelId=useId(),panId=useId();
  useEffect(()=>{
    setMinimum(String(settings.minPauseSeconds));setMaximum(String(settings.maxPauseSeconds));
  },[settings.minPauseSeconds,settings.maxPauseSeconds,settings.enabled]);
  const min=Number(minimum),max=Number(maximum);
  const valid=minimum.trim()!==''&&maximum.trim()!==''&&Number.isFinite(min)&&Number.isFinite(max)
    &&min>=OCCASIONAL_MIN_PAUSE_SECONDS&&max<=OCCASIONAL_MAX_PAUSE_SECONDS&&min<=max;
  const changed=min!==settings.minPauseSeconds||max!==settings.maxPauseSeconds;
  const candidates=assets.filter(asset=>asset.id!==layer.assetId&&!settings.alternateAssetIds.includes(asset.id));
  const matches=candidates.filter(asset=>asset.displayName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selectedId=matches.some(asset=>asset.id===selected)?selected:'';
  const byId=new Map(assets.map(asset=>[asset.id,asset]));
  const limit=settings.alternateAssetIds.length>=OCCASIONAL_MAX_ALTERNATES;
  return <div className="occasional-playback">
    <label className="occasional-mode" htmlFor={modeId}><span>Playback mode</span>
      <select id={modeId} value={settings.enabled?'occasional':'standard'} onChange={event=>{
        if(event.currentTarget.matches(':disabled'))return;
        const enabled=event.currentTarget.value==='occasional';
        if(enabled!==settings.enabled)onChange({...settings,enabled,...(!layer.occasional?{seed:newSeed()}: {})});
      }}><option value="standard">Standard</option><option value="occasional">Occasionally</option></select>
    </label>
    {settings.enabled&&<details className="occasional-details" open>
      <summary><span className="summary-label"><IconArrowsShuffle size={18} stroke={1.7} aria-hidden="true"/>Occasional sounds</span>
        <IconChevronRight className="summary-chevron" size={18} stroke={1.7} aria-hidden="true"/></summary>
      <fieldset className="occasional-controls" aria-label={label}>
        <p className="occasional-hint">Plays a whole recording, then pauses. Your loop settings are kept for Standard playback.</p>
        <div className="occasional-pauses">
          <label htmlFor={minId}>Minimum pause<input id={minId} type="number" min={OCCASIONAL_MIN_PAUSE_SECONDS}
            max={OCCASIONAL_MAX_PAUSE_SECONDS} step="any" value={minimum} aria-describedby={pauseHintId}
            aria-invalid={!valid||undefined} onChange={event=>{if(!event.currentTarget.matches(':disabled'))setMinimum(event.currentTarget.value);}}/></label>
          <label htmlFor={maxId}>Maximum pause<input id={maxId} type="number" min={OCCASIONAL_MIN_PAUSE_SECONDS}
            max={OCCASIONAL_MAX_PAUSE_SECONDS} step="any" value={maximum} aria-describedby={pauseHintId}
            aria-invalid={!valid||undefined} onChange={event=>{if(!event.currentTarget.matches(':disabled'))setMaximum(event.currentTarget.value);}}/></label>
        </div>
        <p id={pauseHintId} className="occasional-hint">Seconds after each recording ends. Use 0.25–3,600 seconds; minimum cannot exceed maximum.</p>
        <button type="button" className="occasional-apply" disabled={!valid||!changed} onClick={event=>{
          if(!event.currentTarget.matches(':disabled')&&valid)onChange({...settings,minPauseSeconds:min,maxPauseSeconds:max});
        }}>Apply pauses</button>
        {!valid&&<p className="occasional-error" role="status">Enter a valid minimum and maximum pause.</p>}
        <div className="occasional-alternates">
          <h3>Alternate recordings <span>{settings.alternateAssetIds.length} / {OCCASIONAL_MAX_ALTERNATES}</span></h3>
          <p className="occasional-hint">The main recording stays included. Add alternatives to shuffle through.</p>
          {settings.alternateAssetIds.length>0&&<ul className="occasional-members">{settings.alternateAssetIds.map(id=>{
            const name=byId.get(id)?.displayName??id+' (unavailable)';
            return <li key={id}><span>{name}</span><button type="button" aria-label={'Remove alternate '+name}
              onClick={event=>{if(!event.currentTarget.matches(':disabled'))onChange({...settings,alternateAssetIds:settings.alternateAssetIds.filter(item=>item!==id)});}}>
              <IconX size={17} aria-hidden="true"/></button></li>;
          })}</ul>}
          <label className="occasional-search" htmlFor={searchId}>Search alternate recordings
            <input id={searchId} type="search" value={query} disabled={limit} placeholder="Find a recording…"
              onChange={event=>{if(!event.currentTarget.matches(':disabled'))setQuery(event.currentTarget.value);}}/></label>
          <div className="occasional-add">
            <label htmlFor={selectId}><span className="sr-only">Alternate recording</span><select id={selectId} value={selectedId} disabled={limit||matches.length===0}
              onChange={event=>{if(!event.currentTarget.matches(':disabled'))setSelected(event.currentTarget.value);}}>
              <option value="">{limit?'All seven alternates selected':matches.length?'Choose a recording':'No matching recordings'}</option>
              {matches.map(asset=><option key={asset.id} value={asset.id}>{asset.displayName}</option>)}
            </select></label>
            <button type="button" disabled={limit||!selectedId} onClick={event=>{
              if(event.currentTarget.matches(':disabled')||!selectedId||limit)return;
              onChange({...settings,alternateAssetIds:[...settings.alternateAssetIds,selectedId]});setSelected('');
            }}><IconPlus size={17} aria-hidden="true"/>Add</button>
          </div>
        </div>
        <div className="occasional-variation">
          <label htmlFor={levelId}><span>Level variation</span><span>{Math.round(settings.levelVariation*100)}%</span></label>
          <RangeInput id={levelId} min={0} max={25} step={1} value={settings.levelVariation*100}
            aria-valuetext={`Up to ${Math.round(settings.levelVariation*100)} percent quieter`} onChange={event=>{
              if(!event.currentTarget.matches(':disabled'))onChange({...settings,levelVariation:event.currentTarget.valueAsNumber/100});
            }}/>
          <p className="occasional-hint">Some events play more quietly, up to this amount.</p>
          <label htmlFor={panId}><span>Position variation</span><span>{Math.round(settings.panVariation*100)}%</span></label>
          <RangeInput id={panId} min={0} max={25} step={1} value={settings.panVariation*100}
            aria-valuetext={`Up to ${Math.round(settings.panVariation*100)} percent left or right`} onChange={event=>{
              if(!event.currentTarget.matches(':disabled'))onChange({...settings,panVariation:event.currentTarget.valueAsNumber/100});
            }}/>
          <p className="occasional-hint">Varies each event before the layer’s stereo position and movement.</p>
        </div>
        <button type="button" className="occasional-new" onClick={event=>{
          if(!event.currentTarget.matches(':disabled'))onChange({...settings,seed:newSeed(settings.seed)});
        }}><IconRefresh size={17} aria-hidden="true"/>New variation</button>
        <p className="occasional-hint">The same saved mix repeats the same sequence. New variation chooses a fresh one.</p>
      </fieldset>
    </details>}
  </div>;
}
