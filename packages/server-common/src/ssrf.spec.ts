import { describe, expect, it } from 'vitest';
import { assertPublicHttpUrl, isPrivateAddress, UnsafeUrlError } from './ssrf';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.1.1.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    // ayrılmış / dokümantasyon / kıyaslama
    '192.0.0.1', '192.0.0.255', '198.18.0.1', '198.19.255.255', '192.0.2.5', '198.51.100.5', '203.0.113.5',
    // IPv6
    '::', '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:7f00:1',
    '2001:db8::1', '2001:db8:ffff::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    '64:ff9b::7f00:1', '64:ff9b::a00:1', '64:ff9b::169.254.169.254', // NAT64 gömülü özel
    '64:ff9b:1:a00::1', // NAT64 yerel: 10.x
    '2002:7f00:1::', '2002:a00:1::1', '2002:c0a8:101::', // 6to4 gömülü özel
  ])('private: %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8', '1.1.1.1', '192.0.1.1', '198.17.0.1', '198.20.0.1', '198.51.101.1', '203.0.114.1', '172.32.0.1',
    '2606:4700::1111', '2001:4860:4860::8888', '2001:1::1',
    '64:ff9b::808:808', // NAT64 gömülü genel (8.8.8.8)
    '2002:808:808::1', // 6to4 gömülü genel
    '::ffff:8.8.8.8',
  ])('public: %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it('treats garbage as private', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('assertPublicHttpUrl', () => {
  it('rejects bad schemes, credentials and internal DNS results', async () => {
    await expect(assertPublicHttpUrl('ftp://8.8.8.8/', { allowPrivate: false })).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpUrl('http://u:p@8.8.8.8/', { allowPrivate: true })).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpUrl('http://x.example/', { allowPrivate: false, lookup: async () => ['8.8.8.8', '10.0.0.1'] })).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpUrl('http://x.example/', { allowPrivate: false, lookup: async () => ['8.8.8.8'] })).resolves.toBeUndefined();
    await expect(assertPublicHttpUrl('http://127.0.0.1/', { allowPrivate: true })).resolves.toBeUndefined();
  });
});
