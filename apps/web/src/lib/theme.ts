export type ThemePreference = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'theme';

/** Tarayıcı çubuğu rengi: `--color-bg` tokenları (globals.css) ile aynı; sistem temasına göre seçilir. */
export const themeColor = [
  { media: '(prefers-color-scheme: dark)', color: '#0E0F11' },
  { media: '(prefers-color-scheme: light)', color: '#F7F6F3' },
];

/** FOUC önleyici: <head> içinde, hidrasyondan önce çalışır. */
export const themeInitScript = `(function(){try{var s=localStorage.getItem('${THEME_STORAGE_KEY}');var t=(s==='light'||s==='dark')?s:(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyPreference(pref: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  try {
    if (pref === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* depolama kapalı olabilir */
  }
  return resolved;
}

/**
 * Kökte bir kez bağlanır: tercih `system` iken işletim sistemi teması değişince `data-theme`'i günceller.
 * Tercih değişikliği anında okunur, açık/koyu seçimi yapılmışsa dokunulmaz. Dönen fonksiyon dinleyiciyi kaldırır.
 */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const onChange = () => {
    if (readPreference() !== 'system') return;
    document.documentElement.dataset.theme = resolveTheme('system');
  };
  mq.addEventListener?.('change', onChange);
  return () => mq.removeEventListener?.('change', onChange);
}
