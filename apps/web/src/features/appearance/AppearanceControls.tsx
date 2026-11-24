import {useEffect,useId,useRef,useState} from 'react';
import IconPalette from '@tabler/icons-react/icons/IconPalette';
import IconChevronDown from '@tabler/icons-react/icons/IconChevronDown';
import IconX from '@tabler/icons-react/icons/IconX';
import {applyColorMode,applyTheme,colorModes,getColorMode,getCurrentTheme,themes,type ColorMode,type ThemeId} from './theme.js';
import './AppearanceControls.css';

/** Appearance is a browser preference, independent of the session and audio graph. */
export function AppearanceControls(){
  const [theme,setTheme]=useState(getCurrentTheme);
  const [colorMode,setColorMode]=useState(getColorMode);
  const [open,setOpen]=useState(false);
  const [saved,setSaved]=useState<boolean|null>(null);
  const root=useRef<HTMLDivElement>(null);
  const trigger=useRef<HTMLButtonElement>(null);
  const id=useId(),panelId=id+'-appearance',titleId=id+'-title';
  const current=themes.find(option=>option.id===theme)!;
  const close=()=>{setOpen(false);trigger.current?.focus();};
  useEffect(()=>{
    if(!open)return;
    root.current?.querySelector<HTMLInputElement>('.appearance-options input:checked')?.focus();
    const dismissOutside=(event:Event)=>{
      if(event.target instanceof Node&&!root.current?.contains(event.target))setOpen(false);
    };
    // Safari can leave focus on the document after a pointer selects a radio.
    const dismissOnEscape=(event:KeyboardEvent)=>{
      if(event.key==='Escape'&&!event.defaultPrevented){
        event.preventDefault();setOpen(false);trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown',dismissOutside);
    document.addEventListener('focusin',dismissOutside);
    document.addEventListener('keydown',dismissOnEscape);
    return ()=>{
      document.removeEventListener('pointerdown',dismissOutside);
      document.removeEventListener('focusin',dismissOutside);
      document.removeEventListener('keydown',dismissOnEscape);
    };
  },[open]);
  const select=(next:ThemeId)=>{setSaved(applyTheme(next));setTheme(next);};
  const selectMode=(next:ColorMode)=>{setSaved(applyColorMode(next));setColorMode(next);};
  return <div className="appearance-controls" ref={root}>
    <button className="appearance-trigger" type="button" ref={trigger} aria-label={'Appearance '+current.name} aria-expanded={open} aria-controls={panelId}
      onClick={event=>{if(!event.currentTarget.matches(':disabled'))setOpen(value=>!value);}}>
      <IconPalette size={18} stroke={1.7} aria-hidden="true"/>
      <span>Appearance</span>
      <span className="appearance-current"><span className="appearance-dot" data-theme={theme} aria-hidden="true"/>{current.name}</span>
      <IconChevronDown className="appearance-chevron" size={15} stroke={1.7} aria-hidden="true"/>
    </button>
    {open&&<section className="appearance-panel" id={panelId} aria-labelledby={titleId}>
      <div className="appearance-panel-heading"><h2 id={titleId}>Appearance</h2>
        <button className="appearance-close" type="button" aria-label="Close appearance" onClick={close}>
          <IconX size={18} stroke={1.7} aria-hidden="true"/>
        </button>
      </div>
      <fieldset className="appearance-mode"><legend className="appearance-option-heading">Color mode</legend>
        <div className="appearance-mode-options">{colorModes.map(option=><label className="appearance-mode-choice" key={option.id} data-selected={colorMode===option.id}>
          <input type="radio" name={id+'-color-mode'} value={option.id} checked={colorMode===option.id}
            onChange={event=>{if(!event.currentTarget.matches(':disabled'))selectMode(option.id);}}/>
          <span>{option.name}</span>
        </label>)}</div>
      </fieldset>
      <fieldset className="appearance-options"><legend className="appearance-option-heading">Accent color</legend>
        <div className="appearance-grid">{themes.map(option=><label className="appearance-choice" key={option.id} data-selected={theme===option.id}>
          <input type="radio" name={id+'-theme'} value={option.id} checked={theme===option.id}
            onChange={event=>{if(!event.currentTarget.matches(':disabled'))select(option.id);}}/>
          <span className="appearance-swatch" data-theme={option.id} aria-hidden="true">
            <span className="appearance-swatch-knob"/><span className="appearance-swatch-fader"/>
          </span>
          <span className="appearance-choice-name">{option.name}</span>
        </label>)}</div>
      </fieldset>
      <p className="appearance-help">{saved===null?'System follows your device’s appearance.':saved?'Saved for your next visit.':'Applied for this visit.'}</p>
    </section>}
  </div>;
}
