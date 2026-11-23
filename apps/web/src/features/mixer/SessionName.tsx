import {useEffect,useRef,useState} from 'react';

export function SessionName({title,onRename}:{title:string;onRename?:((title:string)=>void)|undefined}) {
  const [draft,setDraft]=useState(title);
  const cancelled=useRef(false);
  useEffect(()=>setDraft(title),[title]);
  if(!onRename)return <h2>{title}</h2>;
  const commit=()=>{
    if(cancelled.current){cancelled.current=false;setDraft(title);return;}
    const next=draft.trim();
    if(!next){setDraft(title);return;}
    if(next!==title)onRename(next);
    setDraft(next);
  };
  return <label className="session-name"><span className="field-label">Session name</span>
    <input type="text" aria-label="Session name" value={draft} onChange={event=>setDraft(event.target.value)} onBlur={commit}
      onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}else if(event.key==='Escape'){cancelled.current=true;setDraft(title);event.currentTarget.blur();}}}/>
  </label>;
}
