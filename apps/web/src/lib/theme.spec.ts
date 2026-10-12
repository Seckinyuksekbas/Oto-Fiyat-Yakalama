import { applyPreference, themeColor, themeInitScript, watchSystemTheme } from './theme';

function mockMatchMedia(light: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: light && query.includes('light'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function runInitScript() {
  new Function(themeInitScript)();
}

describe('theme init script (FOUC guard)', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    localStorage.clear();
  });

  it('does not throw when localStorage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => runInitScript()).not.toThrow();
    spy.mockRestore();
  });

  it('follows a light system preference when nothing is stored', () => {
    mockMatchMedia(true);
    runInitScript();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('falls back to dark with a dark system preference', () => {
    mockMatchMedia(false);
    runInitScript();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('stored choice wins over system preference', () => {
    mockMatchMedia(true);
    localStorage.setItem('theme', 'dark');
    runInitScript();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it("applyPreference('system') removes the stored key and resolves from the system", () => {
    mockMatchMedia(true);
    localStorage.setItem('theme', 'dark');
    expect(applyPreference('system')).toBe('light');
    expect(localStorage.getItem('theme')).toBeNull();
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('watchSystemTheme (root listener)', () => {
  type Listener = () => void;
  let light = false;
  let listeners: Listener[] = [];

  beforeEach(() => {
    light = false;
    listeners = [];
    localStorage.clear();
    document.documentElement.dataset.theme = 'dark';
    window.matchMedia = ((query: string) => ({
      get matches() {
        return light && query.includes('light');
      },
      media: query,
      addEventListener: (_: string, fn: Listener) => listeners.push(fn),
      removeEventListener: (_: string, fn: Listener) => {
        listeners = listeners.filter((l) => l !== fn);
      },
    })) as unknown as typeof window.matchMedia;
  });

  function flipSystem(toLight: boolean) {
    light = toLight;
    for (const l of [...listeners]) l();
  }

  it("updates data-theme when the system theme changes and the preference is 'system'", () => {
    const stop = watchSystemTheme();
    flipSystem(true);
    expect(document.documentElement.dataset.theme).toBe('light');
    flipSystem(false);
    expect(document.documentElement.dataset.theme).toBe('dark');
    stop();
  });

  it('leaves an explicit preference alone', () => {
    localStorage.setItem('theme', 'dark');
    const stop = watchSystemTheme();
    flipSystem(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
    stop();
  });

  it('stops listening after cleanup', () => {
    const stop = watchSystemTheme();
    stop();
    expect(listeners).toHaveLength(0);
  });
});

describe('themeColor', () => {
  it('has a dark and a light media entry matching the bg tokens', () => {
    expect(themeColor).toEqual([
      { media: '(prefers-color-scheme: dark)', color: '#0E0F11' },
      { media: '(prefers-color-scheme: light)', color: '#F7F6F3' },
    ]);
  });
});
