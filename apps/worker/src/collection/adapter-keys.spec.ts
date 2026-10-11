import { ADAPTER_KEYS as COLLECTION_KEYS } from '@oto/collection';
import { ADAPTER_KEYS as SHARED_KEYS } from '@oto/shared';
import { expect, it } from 'vitest';

it('shared ADAPTER_KEYS matches the collection registry', () => {
  expect([...SHARED_KEYS].sort()).toEqual([...COLLECTION_KEYS].sort());
});
