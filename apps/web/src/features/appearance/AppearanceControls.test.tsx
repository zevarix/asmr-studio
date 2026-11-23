import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,fireEvent,render,screen} from '@testing-library/react';
import {AppearanceControls} from './AppearanceControls.js';
import {applyTheme,getCurrentTheme,initializeTheme,THEME_STORAGE_KEY,themes} from './theme.js';

afterEach(()=>{
  vi.restoreAllMocks();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
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
    vi.spyOn(window,'localStorage','get').mockImplementation(()=>{throw new DOMException('Storage denied','SecurityError');});
    expect(initializeTheme()).toBe('sage');
    expect(()=>applyTheme('ocean')).not.toThrow();
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
    expect(screen.getByText('Applied for this visit.')).toBeVisible();
  });
});

describe('appearance picker',()=>{
  it('shows named native choices, applies a selection and retains it across view remounts',()=>{
    initializeTheme();
    const first=render(<AppearanceControls/>);
    fireEvent.click(screen.getByRole('button',{name:'Appearance Sage'}));
    expect(screen.getByRole('radio',{name:'Sage'})).toBeChecked();
    expect(screen.getByRole('radio',{name:'Sage'})).toHaveFocus();
    expect(screen.getAllByRole('radio')).toHaveLength(6);
    fireEvent.click(screen.getByRole('radio',{name:'Amethyst'}));
    expect(document.documentElement).toHaveAttribute('data-theme','amethyst');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('amethyst');
    first.unmount();
    render(<AppearanceControls/>);
    fireEvent.click(screen.getByRole('button',{name:'Appearance Amethyst'}));
    expect(screen.getByRole('radio',{name:'Amethyst'})).toBeChecked();
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
    for(const key of ['ArrowRight','ArrowDown','ArrowLeft','ArrowUp','Tab']){
      const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});
      fireEvent(radio,event);
      expect(event.defaultPrevented).toBe(false);
    }
    view.rerender(<fieldset disabled><AppearanceControls/></fieldset>);
    expect(radio).toBeDisabled();
    fireEvent.click(screen.getByRole('radio',{name:'Rose'}));
    expect(getCurrentTheme()).toBe('sage');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });
});
