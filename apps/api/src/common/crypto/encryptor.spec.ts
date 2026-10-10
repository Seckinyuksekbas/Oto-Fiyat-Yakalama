import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Encryptor } from './encryptor';

const key = () => randomBytes(32).toString('base64');

describe('Encryptor', () => {
  it('round-trips unicode text in v1 format', () => {
    const enc = new Encryptor(key());
    const ct = enc.encrypt('İstanbul — şifreli ✓');
    expect(ct.startsWith('v1:')).toBe(true);
    expect(ct.split(':')).toHaveLength(4);
    expect(enc.decrypt(ct)).toBe('İstanbul — şifreli ✓');
  });

  it('round-trips the empty string and JSON', () => {
    const enc = new Encryptor(key());
    expect(enc.decrypt(enc.encrypt(''))).toBe('');
    expect(enc.decryptJson<{ chatId: number }>(enc.encryptJson({ chatId: 42 }))).toEqual({ chatId: 42 });
  });

  it('uses a fresh IV each time', () => {
    const enc = new Encryptor(key());
    expect(enc.encrypt('same')).not.toBe(enc.encrypt('same'));
  });

  it('detects tampering', () => {
    const enc = new Encryptor(key());
    const [v, iv, tag, ct] = enc.encrypt('secret').split(':');
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] ^= 0xff;
    expect(() => enc.decrypt([v, iv, tag, flipped.toString('base64url')].join(':'))).toThrow();
  });

  it('fails with a different key', () => {
    const ct = new Encryptor(key()).encrypt('secret');
    expect(() => new Encryptor(key()).decrypt(ct)).toThrow();
  });

  it('rejects unknown formats and wrong key sizes', () => {
    const enc = new Encryptor(key());
    expect(() => enc.decrypt('v2:a:b:c')).toThrow(/format/);
    expect(() => new Encryptor(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
