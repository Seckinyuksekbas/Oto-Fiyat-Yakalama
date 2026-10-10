import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

const rootEnv = resolve(__dirname, '../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

async function main(): Promise<void> {
  // AppModule env yüklendikten sonra import edilir (ConfigModule process.env'i okur)
  const { AppModule } = await import('./app.module');
  const { configureApp } = await import('./bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false });
  configureApp(app);
  await app.listen(Number(process.env.PORT ?? 3001));
}

void main();
