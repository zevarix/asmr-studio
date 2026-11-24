export const THEME_STORAGE_KEY='asmr-studio.theme';
export const COLOR_MODE_STORAGE_KEY='asmr-studio.color-mode';
export const themes=[
  {id:'sage',name:'Sage'},
  {id:'ocean',name:'Ocean'},
  {id:'amethyst',name:'Amethyst'},
  {id:'ember',name:'Ember'},
  {id:'rose',name:'Rose'},
  {id:'graphite',name:'Graphite'},
] as const;
export type ThemeId=(typeof themes)[number]['id'];
export const colorModes=[
  {id:'light',name:'Light'},
  {id:'dark',name:'Dark'},
  {id:'system',name:'System'},
] as const;
export type ColorMode=(typeof colorModes)[number]['id'];
const defaultTheme:ThemeId='sage';
const defaultColorMode:ColorMode='dark';
let stopFollowingSystem:(()=>void)|undefined;

function acceptedTheme(value:string|null|undefined):ThemeId|null {
  return themes.some(theme=>theme.id===value)?value as ThemeId:null;
}

function acceptedColorMode(value:string|null|undefined):ColorMode|null {
  return colorModes.some(mode=>mode.id===value)?value as ColorMode:null;
}

function setColorMode(mode:ColorMode):void {
  stopFollowingSystem?.();
  stopFollowingSystem=undefined;
  document.documentElement.dataset.colorModePreference=mode;
  if(mode!=='system'){
    document.documentElement.dataset.colorMode=mode;
    return;
  }
  const query=typeof window.matchMedia==='function'?window.matchMedia('(prefers-color-scheme: dark)'):undefined;
  const followSystem=()=>{
    document.documentElement.dataset.colorMode=query?.matches===false?'light':'dark';
  };
  followSystem();
  if(query){
    query.addEventListener('change',followSystem);
    stopFollowingSystem=()=>query.removeEventListener('change',followSystem);
  }
}

/** Apply both browser preferences before mounting the app, without editing a mix. */
export function initializeTheme():ThemeId {
  let theme:ThemeId=defaultTheme;
  let mode:ColorMode=defaultColorMode;
  try {theme=acceptedTheme(window.localStorage.getItem(THEME_STORAGE_KEY))??defaultTheme;}
  catch {/* Private or restricted storage still permits an in-memory theme. */}
  try {mode=acceptedColorMode(window.localStorage.getItem(COLOR_MODE_STORAGE_KEY))??defaultColorMode;}
  catch {/* Keep the existing dark appearance when storage cannot be read. */}
  document.documentElement.dataset.theme=theme;
  setColorMode(mode);
  return theme;
}

export function getCurrentTheme():ThemeId {
  return acceptedTheme(document.documentElement.dataset.theme)??defaultTheme;
}

export function applyTheme(theme:ThemeId):boolean {
  document.documentElement.dataset.theme=theme;
  try {window.localStorage.setItem(THEME_STORAGE_KEY,theme);return true;}
  catch {return false;}
}

export function getColorMode():ColorMode {
  return acceptedColorMode(document.documentElement.dataset.colorModePreference)??defaultColorMode;
}

export function applyColorMode(mode:ColorMode):boolean {
  setColorMode(mode);
  try {window.localStorage.setItem(COLOR_MODE_STORAGE_KEY,mode);return true;}
  catch {return false;}
}
