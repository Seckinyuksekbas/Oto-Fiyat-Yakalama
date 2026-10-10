import { startTestInfra } from '@oto/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const infra = await startTestInfra();
  project.provide('databaseUrl', infra.databaseUrl);
  project.provide('redisUrl', infra.redisUrl);
  return infra.stop;
}
