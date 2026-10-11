import { applyPreference, themeInitScript } from './theme';

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
