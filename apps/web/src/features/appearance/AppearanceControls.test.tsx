import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,fireEvent,render,screen,within} from '@testing-library/react';
import {AppearanceControls} from './AppearanceControls.js';
import {applyColorMode,applyTheme,COLOR_MODE_STORAGE_KEY,colorModes,getColorMode,getCurrentTheme,initializeTheme,THEME_STORAGE_KEY,themes} from './theme.js';

function mockSystemColorScheme(initialDark=false) {
  let dark=initialDark;
  const listeners=new Set<()=>void>();
  const query={
    get matches(){return dark;},
    media:'(prefers-color-scheme: dark)',
    addEventListener:vi.fn((type:string,listener:()=>void)=>{if(type==='change')listeners.add(listener);}),
    removeEventListener:vi.fn((type:string,listener:()=>void)=>{if(type==='change')listeners.delete(listener);}),
  };
  vi.stubGlobal('matchMedia',vi.fn(()=>query));
  return {
    setDark(value:boolean){dark=value;for(const listener of listeners)listener();},
    listenerCount:()=>listeners.size,
  };
}

afterEach(()=>{
  applyColorMode('dark');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.colorMode;
  delete document.documentElement.dataset.colorModePreference;
});

describe('browser appearance preference',()=>{
  it('restores every supported theme before the app mounts',()=>{
    for(const theme of themes){
      window.localStorage.setItem(THEME_STORAGE_KEY,theme.id);
      expect(initializeTheme()).toBe(theme.id);
      expect(document.documentElement).toHaveAttribute('data-theme',theme.id);
    }
  });

  it('uses Sage when the preference is missing or from an unknown theme',()=>{
    expect(initializeTheme()).toBe('sage');
    window.localStorage.setItem(THEME_STORAGE_KEY,'unrecognized');
    expect(initializeTheme()).toBe('sage');
    expect(document.documentElement).toHaveAttribute('data-theme','sage');
  });

  it('continues to apply themes when access to browser storage is denied',()=>{
    const system=mockSystemColorScheme();
    vi.spyOn(window,'localStorage','get').mockImplementation(()=>{throw new DOMException('Storage denied','SecurityError');});
    expect(initializeTheme()).toBe('sage');
    expect(getColorMode()).toBe('dark');
    expect(()=>applyTheme('ocean')).not.toThrow();
    expect(getCurrentTheme()).toBe('ocean');
    expect(applyColorMode('system')).toBe(false);
    expect(getColorMode()).toBe('system');
    expect(document.documentElement).toHaveAttribute('data-color-mode','light');
    system.setDark(true);
    expect(document.documentElement).toHaveAttribute('data-color-mode','dark');
    expect(getCurrentTheme()).toBe('ocean');
  });

  it('keeps an in-memory choice when the browser cannot save it',()=>{
    vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('Storage full','QuotaExceededError');});
    initializeTheme();
    render(<AppearanceControls/>);
    fireEvent.click(screen.getByRole('button',{name:'Appearance Sage'}));
    fireEvent.click(screen.getByRole('radio',{name:'Ember'}));
    expect(screen.getByRole('radio',{name:'Ember'})).toBeChecked();
    expect(getCurrentTheme()).toBe('ember');
    fireEvent.click(screen.getByRole('radio',{name:'Light'}));
    expect(screen.getByRole('radio',{name:'Light'})).toBeChecked();
    expect(getColorMode()).toBe('light');
    expect(document.documentElement).toHaveAttribute('data-color-mode','light');
    expect(screen.getByText('Applied for this visit.')).toBeVisible();
  });
});

describe('color mode preference',()=>{
  it('keeps Dark as the default even on a light system and ignores unknown preferences',()=>{
    mockSystemColorScheme();
    initializeTheme();
    expect(getColorMode()).toBe('dark');
    expect(document.documentElement).toHaveAttribute('data-color-mode','dark');
    window.localStorage.setItem(COLOR_MODE_STORAGE_KEY,'unknown-mode');
    initializeTheme();
    expect(getColorMode()).toBe('dark');
    expect(document.documentElement).toHaveAttribute('data-color-mode','dark');
  });

  it('restores both independent preferences before the app mounts',()=>{
    mockSystemColorScheme();
    window.localStorage.setItem(THEME_STORAGE_KEY,'ocean');
    for(const mode of colorModes){
      window.localStorage.setItem(COLOR_MODE_STORAGE_KEY,mode.id);
      expect(initializeTheme()).toBe('ocean');
      expect(getCurrentTheme()).toBe('ocean');
      expect(getColorMode()).toBe(mode.id);
      expect(document.documentElement).toHaveAttribute('data-color-mode',mode.id==='dark'?'dark':'light');
    }
  });

  it('follows live system changes while selected and leaves an explicit choice alone',()=>{
    const system=mockSystemColorScheme();
    window.localStorage.setItem(COLOR_MODE_STORAGE_KEY,'system');
    initializeTheme();
    expect(document.documentElement).toHaveAttribute('data-color-mode','light');
    expect(system.listenerCount()).toBe(1);
    system.setDark(true);
    expect(document.documentElement).toHaveAttribute('data-color-mode','dark');
    expect(getColorMode()).toBe('system');
    expect(window.localStorage.getItem(COLOR_MODE_STORAGE_KEY)).toBe('system');
    applyTheme('rose');
    expect(getColorMode()).toBe('system');
    applyColorMode('light');
    expect(getCurrentTheme()).toBe('rose');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('rose');
    expect(system.listenerCount()).toBe(0);
    system.setDark(false);system.setDark(true);
    expect(getColorMode()).toBe('light');
    expect(document.documentElement).toHaveAttribute('data-color-mode','light');
  });

  it('replaces the system listener when preferences are initialized or selected again',()=>{
    const system=mockSystemColorScheme(true);
    window.localStorage.setItem(COLOR_MODE_STORAGE_KEY,'system');
    for(let repeat=0;repeat<3;repeat++){
      initializeTheme();
      expect(system.listenerCount()).toBe(1);
      applyColorMode('system');
      expect(system.listenerCount()).toBe(1);
    }
    system.setDark(false);
    expect(document.documentElement).toHaveAttribute('data-color-mode','light');
    applyColorMode('dark');
    expect(system.listenerCount()).toBe(0);
    expect(document.documentElement).toHaveAttribute('data-color-mode','dark');
  });

  it('uses Dark when the system color query is unavailable',()=>{
    vi.stubGlobal('matchMedia',undefined);
    window.localStorage.setItem(COLOR_MODE_STORAGE_KEY,'system');
    expect(()=>initializeTheme()).not.toThrow();
    expect(getColorMode()).toBe('system');
    expect(document.documentElement).toHaveAttribute('data-color-mode','dark');
    applyColorMode('light');
    expect(document.documentElement).toHaveAttribute('data-color-mode','light');
  });
});

describe('appearance picker',()=>{
  it('shows named native choices, applies a selection and retains it across view remounts',()=>{
    initializeTheme();
    const first=render(<AppearanceControls/>);
    fireEvent.click(screen.getByRole('button',{name:'Appearance Sage'}));
    expect(screen.getByRole('radio',{name:'Sage'})).toBeChecked();
    expect(screen.getByRole('radio',{name:'Sage'})).toHaveFocus();
    expect(within(screen.getByRole('group',{name:'Accent color'})).getAllByRole('radio')).toHaveLength(6);
    expect(within(screen.getByRole('group',{name:'Color mode'})).getByRole('radio',{name:'Dark'})).toBeChecked();
    fireEvent.click(screen.getByRole('radio',{name:'Amethyst'}));
    fireEvent.click(screen.getByRole('radio',{name:'Light'}));
    expect(document.documentElement).toHaveAttribute('data-theme','amethyst');
    expect(document.documentElement).toHaveAttribute('data-color-mode','light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('amethyst');
    expect(window.localStorage.getItem(COLOR_MODE_STORAGE_KEY)).toBe('light');
    first.unmount();
    render(<AppearanceControls/>);
    fireEvent.click(screen.getByRole('button',{name:'Appearance Amethyst'}));
    expect(screen.getByRole('radio',{name:'Amethyst'})).toBeChecked();
    expect(screen.getByRole('radio',{name:'Amethyst'})).toHaveFocus();
    expect(screen.getByRole('radio',{name:'Light'})).toBeChecked();
  });

  it('closes on Escape or the close button and returns focus to its trigger',()=>{
    initializeTheme();
    render(<AppearanceControls/>);
    const trigger=screen.getByRole('button',{name:'Appearance Sage'});
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('radio',{name:'Sage'}),{key:'Escape'});
    expect(trigger).toHaveAttribute('aria-expanded','false');
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('radio',{name:'Dark'}),{key:'Escape'});
    expect(trigger).toHaveAttribute('aria-expanded','false');
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    // Pointer selection can leave document focus outside the picker in Safari.
    fireEvent.keyDown(document,{key:'Escape'});
    expect(trigger).toHaveAttribute('aria-expanded','false');
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button',{name:'Close appearance'}));
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded','false');
  });

  it('dismisses for outside pointer or focus without moving focus back',()=>{
    initializeTheme();
    render(<><AppearanceControls/><button>Next control</button></>);
    const trigger=screen.getByRole('button',{name:'Appearance Sage'});
    const outside=screen.getByRole('button',{name:'Next control'});
    fireEvent.click(trigger);
    fireEvent.pointerDown(outside);
    expect(trigger).toHaveAttribute('aria-expanded','false');
    fireEvent.click(trigger);
    act(()=>outside.focus());
    expect(trigger).toHaveAttribute('aria-expanded','false');
    expect(outside).toHaveFocus();
  });

  it('retains native radio keyboard behavior and honors a disabled editor',()=>{
    initializeTheme();
    const view=render(<fieldset><AppearanceControls/></fieldset>);
    fireEvent.click(screen.getByRole('button',{name:'Appearance Sage'}));
    const radio=screen.getByRole('radio',{name:'Sage'});
    const mode=screen.getByRole('radio',{name:'Dark'});
    for(const control of [radio,mode])for(const key of ['ArrowRight','ArrowDown','ArrowLeft','ArrowUp','Tab']){
      const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});
      fireEvent(control,event);
      expect(event.defaultPrevented).toBe(false);
    }
    view.rerender(<fieldset disabled><AppearanceControls/></fieldset>);
    expect(radio).toBeDisabled();
    expect(mode).toBeDisabled();
    fireEvent.click(screen.getByRole('radio',{name:'Rose'}));
    fireEvent.click(screen.getByRole('radio',{name:'Light'}));
    expect(getCurrentTheme()).toBe('sage');
    expect(getColorMode()).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(COLOR_MODE_STORAGE_KEY)).toBeNull();
  });
});
