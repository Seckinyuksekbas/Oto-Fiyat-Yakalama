import { createHash } from 'node:crypto';
import { buildCsp, generateNonce, themeScriptHash } from './csp';
import { themeInitScript } from './theme';

function directives(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name, values);
  }
  return map;
}

describe('themeScriptHash', () => {
  it('matches an independently computed sha256 of themeInitScript', () => {
    const expected = `'sha256-${createHash('sha256').update(themeInitScript, 'utf8').digest('base64')}'`;
    expect(themeScriptHash()).toBe(expected);
  });
});

describe('buildCsp', () => {
  it('production policy locks down framing, plugins, base and forms and allows the theme hash', () => {
    const d = directives(buildCsp({ dev: false }));
    expect(d.get('default-src')).toEqual(["'self'"]);
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
    expect(d.get('object-src')).toEqual(["'none'"]);
    expect(d.get('base-uri')).toEqual(["'self'"]);
    expect(d.get('form-action')).toEqual(["'self'"]);
    expect(d.get('connect-src')).toEqual(["'self'"]);
    expect(d.get('font-src')).toEqual(["'self'"]);
    expect(d.get('script-src')).toContain(themeScriptHash());
    expect(d.get('script-src')).toContain("'self'");
  });

  it("never allows 'unsafe-inline' scripts, in dev or prod", () => {
    for (const dev of [false, true]) {
      expect(directives(buildCsp({ dev })).get('script-src')).not.toContain("'unsafe-inline'");
    }
  });

  it("allows 'unsafe-eval' only in dev", () => {
    expect(buildCsp({ dev: false })).not.toContain("'unsafe-eval'");
    expect(directives(buildCsp({ dev: true })).get('script-src')).toContain("'unsafe-eval'");
  });
});

describe('nonce', () => {
  it('adds the per-request nonce to script-src next to the theme hash', () => {
    const nonce = generateNonce();
    const script = directives(buildCsp({ dev: false, nonce })).get('script-src');
    expect(script).toContain(`'nonce-${nonce}'`);
    expect(script).toContain(themeScriptHash());
    expect(script).not.toContain("'unsafe-inline'");
  });

  it('generates a fresh base64 nonce of at least 128 bits each call', () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(a, 'base64').length).toBeGreaterThanOrEqual(16);
  });
});
