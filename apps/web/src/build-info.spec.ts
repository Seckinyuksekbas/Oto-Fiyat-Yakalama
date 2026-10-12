import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILD_API_ORIGIN_FILE, readBuildApiOrigin } from './build-info';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oto-web-build-info-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readBuildApiOrigin', () => {
  it('returns null when no build record exists (local builds)', () => {
    expect(readBuildApiOrigin(tempDir())).toBeNull();
  });

  it('returns the recorded build-time origin', () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.next'));
    writeFileSync(join(dir, BUILD_API_ORIGIN_FILE), 'http://api:3001\n');
    expect(readBuildApiOrigin(dir)).toBe('http://api:3001');
  });

  it('treats an empty record as absent', () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.next'));
    writeFileSync(join(dir, BUILD_API_ORIGIN_FILE), '');
    expect(readBuildApiOrigin(dir)).toBeNull();
  });
});
