import { PRIVATE_ADDRESS_CODE } from '@oto/server-common';
import { describe, expect, it } from 'vitest';
import { proxyAgentOptions } from './proxies.service';

type Lookup = (host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => void;
const run = (lookup: Lookup, host = 'proxy.example') =>
  new Promise<unknown[]>((resolve) => lookup(host, { all: true }, (...args) => resolve(args)));
const lookupOf = (o: { connect: object }) => (o.connect as { lookup: Lookup }).lookup;

describe('proxyAgentOptions', () => {
  const resolvesTo = (...addrs: string[]) => async () => addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

  it('in production mode rejects, at connect time, a proxy host that resolves to a private address (DNS rebinding)', async () => {
    const [err] = await run(lookupOf(proxyAgentOptions('http://proxy.example:3128', false, resolvesTo('10.0.0.5'))));
    expect((err as { code?: string }).code).toBe(PRIVATE_ADDRESS_CODE);
    const [mixed] = await run(lookupOf(proxyAgentOptions('http://proxy.example:3128', false, resolvesTo('8.8.8.8', '169.254.169.254'))));
    expect((mixed as { code?: string }).code).toBe(PRIVATE_ADDRESS_CODE);
  });

  it('allows public addresses and installs no guard when private addresses are allowed', async () => {
    const ok = proxyAgentOptions('http://proxy.example:3128', false, resolvesTo('8.8.8.8'));
    expect(await run(lookupOf(ok))).toEqual([null, [{ address: '8.8.8.8', family: 4 }]]);
    expect('lookup' in proxyAgentOptions('http://127.0.0.1:3128', true).connect).toBe(false);
  });
});
