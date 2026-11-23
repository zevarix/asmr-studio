export const THEME_STORAGE_KEY='asmr-studio.theme';
export const themes=[
  {id:'sage',name:'Sage'},
  {id:'ocean',name:'Ocean'},
  {id:'amethyst',name:'Amethyst'},
  {id:'ember',name:'Ember'},
  {id:'rose',name:'Rose'},
  {id:'graphite',name:'Graphite'},
] as const;
export type ThemeId=(typeof themes)[number]['id'];
const defaultTheme:ThemeId='sage';

function acceptedTheme(value:string|null|undefined):ThemeId|null {
  return themes.some(theme=>theme.id===value)?value as ThemeId:null;
}

/** Apply the browser preference before mounting the app, without editing a mix. */
export function initializeTheme():ThemeId {
  let theme:ThemeId=defaultTheme;
  try {theme=acceptedTheme(window.localStorage.getItem(THEME_STORAGE_KEY))??defaultTheme;}
  catch {/* Private or restricted storage still permits an in-memory theme. */}
  document.documentElement.dataset.theme=theme;
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
