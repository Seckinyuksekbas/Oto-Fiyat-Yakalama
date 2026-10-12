import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env';
import type { PrismaService } from '../infra/prisma.service';
import { TelegramStartupCheck } from './telegram-startup-check';

const token = () => ['123456789', 'TEST'.padEnd(35, 'x')].join(':');

function setup(env: Partial<Env>, create = vi.fn().mockResolvedValue({ id: 1 })) {
  const prisma = { systemLog: { create } } as unknown as PrismaService;
  const check = new TelegramStartupCheck(prisma, { NODE_ENV: 'production', ROLE: 'worker', ...env } as Env);
  const warn = vi.spyOn((check as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);
  return { check, create, warn };
}

describe('TelegramStartupCheck', () => {
  it('production + token yok: bir warn log ve tek SystemLog WARN satırı (component telegram)', async () => {
    const { check, create, warn } = setup({ TELEGRAM_BOT_TOKEN: undefined });
    await check.onApplicationBootstrap();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('TELEGRAM_BOT_TOKEN');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ level: 'WARN', component: 'telegram', message: expect.stringContaining('TELEGRAM_BOT_TOKEN') }) });
  });

  it('production + token var: sessiz', async () => {
    const { check, create, warn } = setup({ TELEGRAM_BOT_TOKEN: token() });
    await check.onApplicationBootstrap();
    expect(warn).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('development + token yok: sessiz', async () => {
    const { check, create, warn } = setup({ NODE_ENV: 'development', TELEGRAM_BOT_TOKEN: undefined });
    await check.onApplicationBootstrap();
    expect(warn).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('production scheduler + token yok: sessiz (token yalnız worker ve api için gerekir)', async () => {
    const { check, create, warn } = setup({ ROLE: 'scheduler', TELEGRAM_BOT_TOKEN: undefined });
    await check.onApplicationBootstrap();
    expect(warn).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('SystemLog yazılamazsa açılışı düşürmez, ikinci bir warn yazar', async () => {
    const { check, warn } = setup({ TELEGRAM_BOT_TOKEN: undefined }, vi.fn().mockRejectedValue(new Error('db down')));
    await expect(check.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
