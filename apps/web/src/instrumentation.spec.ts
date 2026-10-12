import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { register } from './instrumentation';

const buildInfo = vi.hoisted(() => ({ origin: null as string | null }));
vi.mock('./build-info', () => ({ readBuildApiOrigin: () => buildInfo.origin }));

let exitSpy: MockInstance<typeof process.exit>;
let errorSpy: MockInstance<typeof console.error>;
beforeEach(() => {
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  buildInfo.origin = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('instrumentation register', () => {
  it('fails server start on an invalid API_ORIGIN in the Node runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('API_ORIGIN', 'not a url');
    await expect(register()).rejects.toThrow(/API_ORIGIN/);
  });

  it('accepts a valid API_ORIGIN', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('API_ORIGIN', 'http://api:3001');
    await expect(register()).resolves.toBeUndefined();
  });

  it('skips the check outside the Node runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    vi.stubEnv('API_ORIGIN', 'not a url');
    await expect(register()).resolves.toBeUndefined();
  });

  it('exits the process with code 1 on invalid env (standalone server.js only logs a rejected hook)', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('CSP_IMG_EXTRA', 'https://img.example.com/hidden-path');
    await expect(register()).rejects.toThrow(/CSP_IMG_EXTRA/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0])).not.toContain('hidden-path');
  });

  it('does not exit on a valid env', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('CSP_IMG_EXTRA', 'http://127.0.0.1:4100');
    await expect(register()).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('fails server start when runtime API_ORIGIN differs from the build-time record', async () => {
    buildInfo.origin = 'http://api:3001';
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('API_ORIGIN', 'http://other-api:3001');
    await expect(register()).rejects.toThrow(/API_ORIGIN: derleme anındaki/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).not.toContain('other-api');
  });

  it('accepts a runtime API_ORIGIN equal to the build-time record (trailing slash normalized)', async () => {
    buildInfo.origin = 'http://api:3001';
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('API_ORIGIN', 'http://api:3001/');
    await expect(register()).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
