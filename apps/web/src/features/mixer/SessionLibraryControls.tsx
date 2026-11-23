import {useState} from 'react';
import IconArrowRight from '@tabler/icons-react/icons/IconArrowRight';
import IconArrowsShuffle from '@tabler/icons-react/icons/IconArrowsShuffle';
import IconCopy from '@tabler/icons-react/icons/IconCopy';
import IconDeviceFloppy from '@tabler/icons-react/icons/IconDeviceFloppy';
import IconFolder from '@tabler/icons-react/icons/IconFolder';
import IconPlus from '@tabler/icons-react/icons/IconPlus';
import IconX from '@tabler/icons-react/icons/IconX';
import type {SceneSummary} from '../../api.js';

interface Props {
  sceneId: string;
  savedScenes: SceneSummary[];
  busy: boolean;
  dirty: boolean;
  onNew: () => void | Promise<void>;
  onNewTransition?: () => void | Promise<void>;
  onOpen: (id: string) => void | Promise<void>;
  onSave: () => Promise<boolean>;
  onSaveCopy: () => void | Promise<unknown>;
}
type SwitchAction = {kind:'new'|'new-transition'} | {kind:'open';id:string};

export function SessionLibraryControls({sceneId,savedScenes,busy,dirty,onNew,onNewTransition,onOpen,onSave,onSaveCopy}:Props) {
  const [pending,setPending]=useState<SwitchAction|null>(null);
  const [saving,setSaving]=useState(false);
  const [switchError,setSwitchError]=useState('');
  const unavailable=busy||saving;

  const perform=async(action:SwitchAction)=>{
    setPending(null);setSwitchError('');
    if(action.kind==='new')await onNew();
    else if(action.kind==='new-transition')await onNewTransition?.();
    else if(action.kind==='open')await onOpen(action.id);
  };
  const request=(action:SwitchAction)=>{
    if(unavailable)return;
    setSwitchError('');
    if(dirty)setPending(action);
    else void perform(action);
  };
  const saveAndSwitch=async()=>{
    if(!pending||unavailable)return;
    setSaving(true);setSwitchError('');
    try{
      if(await onSave())await perform(pending);
      else setSwitchError('Your current changes have not all been saved. Keep this session open or discard them explicitly.');
    }catch{setSwitchError('Save failed. Your current session is still open.');}
    finally{setSaving(false);}
  };
  return <div className="session-library">
    <div className="session-library-actions">
      <label className="saved-session-field"><span className="field-label"><IconFolder size={16} stroke={1.7} aria-hidden="true"/>Saved session</span>
        <select aria-label="Open saved session" disabled={unavailable||savedScenes.length===0}
          value={savedScenes.some(item=>item.id===sceneId)?sceneId:''}
          onChange={event=>{if(event.target.value&&event.target.value!==sceneId)request({kind:'open',id:event.target.value});}}>
          <option value="">{savedScenes.length===0?'No saved sessions':'Open saved session…'}</option>
          {savedScenes.map(item=><option key={item.id} value={item.id}>{item.title} · {item.kind==='transition'?'Transition · ':''}{item.layerCount} {item.layerCount===1?'layer':'layers'}</option>)}
        </select>
      </label>
      <button type="button" disabled={unavailable} onClick={()=>request({kind:'new'})}><IconPlus size={18} stroke={1.7} aria-hidden="true"/>New session</button>
      {onNewTransition&&<button type="button" disabled={unavailable} onClick={()=>request({kind:'new-transition'})}><IconArrowsShuffle size={18} stroke={1.7} aria-hidden="true"/>New transition</button>}
      <button type="button" disabled={unavailable} onClick={()=>{void onSaveCopy();}}><IconCopy size={18} stroke={1.7} aria-hidden="true"/>Save a copy</button>
    </div>
    {pending&&<div className="switch-confirmation" role="group" aria-label="Unsaved session changes">
      <p>Save changes before {pending.kind==='new'?'starting a new session':pending.kind==='new-transition'?'starting a new transition':'opening another session'}?</p>
      <div className="session-library-actions">
        <button type="button" className="primary" disabled={unavailable} onClick={()=>{void saveAndSwitch();}}><IconDeviceFloppy size={18} stroke={1.7} aria-hidden="true"/>{saving?'Saving…':'Save and continue'}</button>
        <button type="button" disabled={unavailable} onClick={()=>{void perform(pending);}}><IconArrowRight size={18} stroke={1.7} aria-hidden="true"/>Discard changes and continue</button>
        <button type="button" disabled={unavailable} onClick={()=>{setPending(null);setSwitchError('');}}><IconX size={18} stroke={1.7} aria-hidden="true"/>Cancel</button>
      </div>
      {switchError&&<p className="error" role="alert">{switchError}</p>}
    </div>}
  </div>;
}
