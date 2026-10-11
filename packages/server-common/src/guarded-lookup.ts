import { lookup as dnsLookup } from 'node:dns';
import { isPrivateAddress } from './ssrf';

/** guardedLookup'ın işaretlediği hata kodu: iç ağ adresi, yeniden denenmez. */
export const PRIVATE_ADDRESS_CODE = 'OTO_PRIVATE_ADDRESS';

export type HostLookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

export const systemLookup: HostLookup = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));
  });

function privateAddressError(message: string): Error {
  return Object.assign(new Error(message), { code: PRIVATE_ADDRESS_CODE });
}

/** undici connect.lookup: tüm adresleri çözer, biri bile özelse bağlantıyı reddeder (DNS rebinding'e karşı bağlantı anında). */
export function guardedLookup(resolver: HostLookup = systemLookup) {
  return (hostname: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
    resolver(hostname).then(
      (addrs) => {
        if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
          cb(privateAddressError(`İç ağ adresine bağlanılamaz: ${hostname}`));
        } else if (options?.all) {
          cb(null, addrs);
        } else {
          cb(null, addrs[0].address, addrs[0].family);
        }
      },
      (err: unknown) => cb(err),
    );
  };
}
