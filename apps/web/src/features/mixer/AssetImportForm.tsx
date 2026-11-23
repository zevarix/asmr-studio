import {useState,type FormEvent} from 'react';
import IconChevronRight from '@tabler/icons-react/icons/IconChevronRight';
import IconUpload from '@tabler/icons-react/icons/IconUpload';
import type {AssetImportMetadata,Layer} from '@asmr-studio/contracts';
interface Props { onImport:(file:File,metadata:AssetImportMetadata)=>Promise<void> }
export function AssetImportForm({onImport}:Props){
  const [file,setFile]=useState<File|null>(null);
  const [role,setRole]=useState<Layer['role']>('ambience');
  const [provenance,setProvenance]=useState<'original'|'licensed'|'unknown'>('unknown');
  const [permission,setPermission]=useState(false);
  const [source,setSource]=useState('');
  const [pending,setPending]=useState(false);
  const [message,setMessage]=useState('');
  const submit=async(event:FormEvent)=>{
    event.preventDefault();
    if(!file||!permission){setMessage('Choose an audio file and confirm private-use permission.');return;}
    const form=event.currentTarget as HTMLFormElement;
    setPending(true);setMessage('');
    try{
      await onImport(file,{
        displayName:file.name,roles:[role],provenance:{kind:provenance,source:source.trim()||null},
        rights:{privateUse:'permitted',redistribution:'unknown'},
      });
      setFile(null);setMessage('Audio imported. Add it to your mix below.');
      const input=form.elements.namedItem('audio-file') as HTMLInputElement|null;
      if(input) input.value='';
    }catch{setMessage('Import failed. Check that the audio is supported and your permissions are correct.');}
    finally{setPending(false);}
  };
  return <details className="import-details"><summary><span className="summary-label"><IconUpload size={18} stroke={1.7} aria-hidden="true"/>Import your audio</span><IconChevronRight className="summary-chevron" size={18} stroke={1.7} aria-hidden="true"/></summary>
    <form className="import-form" onSubmit={event=>{void submit(event);}}>
    <label>Audio file<input name="audio-file" aria-label="Audio file" type="file" accept="audio/*,.wav,.flac,.mp3,.ogg,.m4a" onChange={event=>setFile(event.target.files?.[0]??null)}/></label>
    <label>Sound role<select aria-label="Sound role" value={role} onChange={event=>setRole(event.target.value as Layer['role'])}>
      <option value="ambience">Ambience</option><option value="texture">Texture</option><option value="narration">Narration</option>
    </select></label>
    <label>Source declaration<select aria-label="Source declaration" value={provenance} onChange={event=>setProvenance(event.target.value as typeof provenance)}>
      <option value="unknown">Not specified</option><option value="original">My original recording</option><option value="licensed">Licensed audio</option>
    </select></label>
    <label>Source or attribution<input aria-label="Source or attribution" type="text" value={source}
      placeholder="Creator, source link, and license (optional)" onChange={event=>setSource(event.target.value)}/></label>
    <label className="permission"><input type="checkbox" checked={permission} onChange={event=>setPermission(event.target.checked)}/>
      I have permission to listen privately to this recording
    </label>
    <button type="submit" disabled={pending||!file||!permission}><IconUpload size={18} stroke={1.7} aria-hidden="true"/>{pending?'Importing…':'Import audio'}</button>
    {message&&(message.startsWith('Import failed')?<p role="alert">{message}</p>:<p>{message}</p>)}
  </form></details>;
}
