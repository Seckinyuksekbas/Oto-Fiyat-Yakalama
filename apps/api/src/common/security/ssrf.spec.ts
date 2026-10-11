import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { assertPublicHttpUrl } from './ssrf';

const pub = (addrs: string[]) => async () => addrs;
const strict = { allowPrivate: false };

describe('assertPublicHttpUrl', () => {
  it.each([
    '127.0.0.1',
    '127.5.5.5',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '0.0.0.0',
    '0.1.2.3',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
  ])('rejects private IPv4 literal %s', async (ip) => {
    await expect(assertPublicHttpUrl(`http://${ip}/x`, strict)).rejects.toBeInstanceOf(AppError);
  });

  it.each(['[::1]', '[::]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1]', '[febf::1]', '[::ffff:10.0.0.1]', '[::ffff:7f00:1]', '[ff02::1]'])(
    'rejects private IPv6 literal %s',
    async (ip) => {
      await expect(assertPublicHttpUrl(`http://${ip}/`, strict)).rejects.toBeInstanceOf(AppError);
    },
  );

  it.each(['172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '8.8.8.8', '169.253.1.1', '223.255.255.255'])(
    'accepts public IPv4 %s',
    async (ip) => {
      await expect(assertPublicHttpUrl(`https://${ip}/`, strict)).resolves.toBeUndefined();
    },
  );

  it('accepts public IPv6 literal and mapped public IPv4', async () => {
    await expect(assertPublicHttpUrl('http://[2606:4700::1111]/', strict)).resolves.toBeUndefined();
    await expect(assertPublicHttpUrl('http://[::ffff:8.8.8.8]/', strict)).resolves.toBeUndefined();
  });

  it('rejects a hostname that resolves to an internal address (any of the results)', async () => {
    await expect(assertPublicHttpUrl('https://evil.example/', { ...strict, lookup: pub(['10.1.2.3']) })).rejects.toBeInstanceOf(AppError);
    await expect(assertPublicHttpUrl('https://evil.example/', { ...strict, lookup: pub(['8.8.8.8', '169.254.169.254']) })).rejects.toBeInstanceOf(AppError);
    await expect(assertPublicHttpUrl('https://evil.example/', { ...strict, lookup: pub(['8.8.8.8', '::1']) })).rejects.toBeInstanceOf(AppError);
  });

  it('accepts a hostname resolving only to public addresses', async () => {
    await expect(assertPublicHttpUrl('https://ok.example/', { ...strict, lookup: pub(['8.8.8.8', '2606:4700::1111']) })).resolves.toBeUndefined();
  });

  it('rejects unresolvable hosts and empty results', async () => {
    await expect(assertPublicHttpUrl('https://nx.example/', { ...strict, lookup: pub([]) })).rejects.toBeInstanceOf(AppError);
    await expect(
      assertPublicHttpUrl('https://nx.example/', {
        ...strict,
        lookup: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('rejects localhost by name when private is not allowed', async () => {
    await expect(assertPublicHttpUrl('http://localhost:3000/', { ...strict, lookup: pub(['127.0.0.1']) })).rejects.toBeInstanceOf(AppError);
  });

  it('allowPrivate lets internal addresses through but still enforces scheme and credentials', async () => {
    const dev = { allowPrivate: true };
    await expect(assertPublicHttpUrl('http://127.0.0.1:4000/', dev)).resolves.toBeUndefined();
    await expect(assertPublicHttpUrl('http://[::1]/', dev)).resolves.toBeUndefined();
    await expect(assertPublicHttpUrl('ftp://127.0.0.1/', dev)).rejects.toBeInstanceOf(AppError);
    await expect(assertPublicHttpUrl('http://u:p@127.0.0.1/', dev)).rejects.toBeInstanceOf(AppError);
  });

  it('rejects non-http schemes, credentials and garbage', async () => {
    for (const u of ['ftp://8.8.8.8/', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://8.8.8.8/', 'not a url', '']) {
      await expect(assertPublicHttpUrl(u, strict)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    await expect(assertPublicHttpUrl('https://user@8.8.8.8/', strict)).rejects.toBeInstanceOf(AppError);
    await expect(assertPublicHttpUrl('https://user:pw@8.8.8.8/', strict)).rejects.toBeInstanceOf(AppError);
  });

  it('normalizes numeric host tricks (decimal/hex) via URL parsing', async () => {
    await expect(assertPublicHttpUrl('http://2130706433/', strict)).rejects.toBeInstanceOf(AppError);
    await expect(assertPublicHttpUrl('http://0x7f.0.0.1/', strict)).rejects.toBeInstanceOf(AppError);
  });
});
