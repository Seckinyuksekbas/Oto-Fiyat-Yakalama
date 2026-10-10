import { describe, expect, it } from 'vitest';
import { bullConnection } from './bull';

describe('bullConnection', () => {
  it('parses a redis URL into BullMQ connection options', () => {
    expect(bullConnection('redis://:s%40cret@redis.local:6380/2')).toEqual({
      host: 'redis.local',
      port: 6380,
      username: undefined,
      password: 's@cret',
      db: 2,
      maxRetriesPerRequest: null,
    });
    expect(bullConnection('redis://localhost')).toMatchObject({ port: 6379, db: 0, password: undefined });
  });
});
