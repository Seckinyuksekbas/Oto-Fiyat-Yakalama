import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { PRIVATE_ADDRESS_CODE } from '@oto/server-common';
import { ProxyAgent, request } from 'undici';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { proxyAgentOptions } from './proxies.service';

const resolvesTo = (...addrs: string[]) => vi.fn(async () => addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
const codeOf = (e: unknown) => (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;

let target: Server;
let fakeProxy: Server;
const port = (s: Server) => (s.address() as AddressInfo).port;

beforeAll(async () => {
  target = createServer((_q, res) => res.writeHead(204).end());
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  fakeProxy = createServer();
  fakeProxy.on('connect', (req, client: Socket, head: Buffer) => {
    const [host, p] = (req.url ?? '').split(':');
    const up = connect(Number(p), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => fakeProxy.listen(0, '127.0.0.1', r));
});
afterAll(async () => {
  fakeProxy.closeAllConnections();
  target.closeAllConnections();
  await Promise.all([fakeProxy, target].map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('proxyAgentOptions (real undici ProxyAgent)', () => {
  it('production mode: a proxy host resolving to a private address is rejected at connect time and the resolver is used', async () => {
    const resolver = resolvesTo('8.8.8.8', '10.0.0.5');
    const agent = new ProxyAgent(proxyAgentOptions('http://proxy.example:3128', false, resolver));
    const err = await request('http://target.example/', { dispatcher: agent }).catch((e: unknown) => e);
    await agent.close().catch(() => undefined);
    expect(codeOf(err)).toBe(PRIVATE_ADDRESS_CODE);
    expect(resolver).toHaveBeenCalledWith('proxy.example');
  });

  it('production mode: loopback resolution is rejected too', async () => {
    const agent = new ProxyAgent(proxyAgentOptions('http://rebind.example:3128', false, resolvesTo('127.0.0.1')));
    const err = await request('http://target.example/', { dispatcher: agent }).catch((e: unknown) => e);
    await agent.close().catch(() => undefined);
    expect(codeOf(err)).toBe(PRIVATE_ADDRESS_CODE);
  });

  it('allowPrivate (dev/test): connects to a local proxy and reaches the target through the tunnel', async () => {
    const agent = new ProxyAgent(proxyAgentOptions(`http://127.0.0.1:${port(fakeProxy)}`, true));
    const res = await request(`http://127.0.0.1:${port(target)}/`, { dispatcher: agent });
    await res.body.dump();
    await agent.close();
    expect(res.statusCode).toBe(204);
  });
});
