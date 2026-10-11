import { describe, expect, it } from 'vitest';
import { bullConnection } from './bull-connection';

describe('bullConnection', () => {
  it('parses a redis URL, decoding username and password', () => {
    expect(bullConnection('redis://us%40er:s%40cret@redis.local:6380/2')).toEqual({
      host: 'redis.local',
      port: 6380,
      username: 'us@er',
      password: 's@cret',
      db: 2,
      maxRetriesPerRequest: null,
    });
    expect(bullConnection('redis://localhost')).toMatchObject({ port: 6379, db: 0, password: undefined });
  });

  it('enables TLS for rediss: and honours producer options', () => {
    const c = bullConnection('rediss://h:1', { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    expect(c).toMatchObject({ tls: {}, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    expect(bullConnection('redis://h:1')).not.toHaveProperty('tls');
  });
});
