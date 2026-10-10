import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

const rootEnv = resolve(__dirname, '../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
if (process.argv.includes('--role=scheduler')) process.env.ROLE = 'scheduler';

async function main(): Promise<void> {
  const scheduler = process.env.ROLE === 'scheduler';
  const root = scheduler
    ? (await import('./scheduler-app.module')).SchedulerAppModule
    : (await import('./worker-app.module')).WorkerAppModule;
  const app = await NestFactory.createApplicationContext(root, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.get(Logger).log(`Oto Fırsat ${scheduler ? 'scheduler' : 'worker'} başladı`);
}

main().catch((err: unknown) => {
  console.error('Oto Fırsat worker başlatılamadı:', err);
  process.exit(1);
});
