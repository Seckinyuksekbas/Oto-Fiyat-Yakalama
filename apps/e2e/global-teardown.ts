import { killAll } from './support/stack';

export default async function globalTeardown(): Promise<void> {
  killAll();
  await globalThis.__otoFakeTelegram?.close();
  globalThis.__otoFakeTelegram = undefined;
}
