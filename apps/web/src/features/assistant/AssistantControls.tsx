import {useState} from 'react';
import type {AssistantDeviceState,AssistantRegistration} from '@asmr-studio/contracts';
import './AssistantControls.css';

export function AssistantControls({connection,connecting,message,disabled,state,onConnect,onDisconnect}:{
  connection:AssistantRegistration|null;connecting:boolean;message:string;disabled:boolean;state:AssistantDeviceState;
  onConnect:(name:string)=>Promise<void>;onDisconnect:()=>void;
}){
  const [name,setName]=useState('Studio browser');
  const [settings,setSettings]=useState(false);
  const config={ASMR_STUDIO_URL:window.location.origin,ASMR_CONTROL_TOKEN:connection?.controlToken??''};
  return <section className="assistant-controls" aria-label="Assistant controls">
    <details><summary>Assistant controls <span>{connection?'Connected':'Off'}</span></summary>
      <p>Let a connected assistant adjust this browser’s mix and playback. You can keep using every mixer control.</p>
      {!connection?<div className="assistant-connect">
        <label>Playback device name <input type="text" maxLength={80} value={name} disabled={connecting} onChange={event=>setName(event.target.value)}/></label>
        <button type="button" disabled={disabled||connecting||!name.trim()} onClick={()=>{setSettings(false);void onConnect(name.trim());}}>
          {connecting?'Connecting…':'Enable for this browser'}</button>
        {connecting&&<button type="button" onClick={onDisconnect}>Cancel connection</button>}
      </div>:<>
        <p role="status">Connected as {name}. Playback: {state.playback.state}. Draft version {state.stateVersion}.
          {state.savedRevision===null?' No saved revision.':` Saved revision ${state.savedRevision}.`}{state.dirty?' Unsaved changes.':''}</p>
        <div className="assistant-actions"><button type="button" onClick={()=>{setSettings(false);onDisconnect();}}>Disconnect assistant</button>
          <button type="button" aria-expanded={settings} onClick={()=>setSettings(value=>!value)}>Connection settings</button></div>
        {settings&&<div className="assistant-settings">
          <p>Use these environment settings for the local ASMR Studio MCP server. This key controls only this browser. Disconnecting blocks new commands.</p>
          <pre aria-label="MCP environment settings">{JSON.stringify(config,null,2)}</pre>
          <p>Playback device: <code>{connection.deviceId}</code></p>
          <p>Connection: <code>{connection.epoch}</code></p>
          <p>Keep the key private. Closing or reloading this tab requires a new connection.</p>
        </div>}
      </>}
      {message&&<p role="status">{message}</p>}
    </details>
  </section>;
}
