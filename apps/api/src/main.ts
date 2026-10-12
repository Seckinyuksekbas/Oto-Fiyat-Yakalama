import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Env } from './config/env';

const rootEnv = resolve(__dirname, '../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

async function main(): Promise<void> {
  // AppModule env yüklendikten sonra import edilir (ConfigModule process.env'i okur)
  const { AppModule } = await import('./app.module');
  const { APP_OPTIONS, configureApp } = await import('./bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { ...APP_OPTIONS, bufferLogs: true });
  configureApp(app);
  const { ENV } = await import('./config/config.module');
  await app.listen(app.get<Env>(ENV).PORT);
}

main().catch((err: unknown) => {
  // Env/anahtar hataları değişken adını ve nedeni içerir, değeri içermez
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
