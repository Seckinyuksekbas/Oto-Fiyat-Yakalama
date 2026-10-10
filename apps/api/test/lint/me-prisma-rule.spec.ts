import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd(), '../..');
const source = `export class X { constructor(private readonly prisma: { user: { findMany(): void } }) {} run() { return this.prisma.user.findMany(); } }\n`;

describe('me/ prisma lint rule', () => {
  it('forbids direct prisma access in /me services', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const [result] = await eslint.lintText(source, { filePath: resolve(repoRoot, 'apps/api/src/modules/me/bad.service.ts') });
    expect(result.messages.some((m) => m.ruleId === 'no-restricted-syntax')).toBe(true);
  });

  it('allows it inside *.repository.ts', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const [result] = await eslint.lintText(source, { filePath: resolve(repoRoot, 'apps/api/src/modules/me/ok.repository.ts') });
    expect(result.messages.filter((m) => m.ruleId === 'no-restricted-syntax')).toHaveLength(0);
  });

  it('forbids destructuring prisma and constructing PrismaClient in /me', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const bad = [
      `export class X { constructor(private readonly db: { prisma: unknown }) {} run() { const { prisma } = this.db; return prisma; } }
`,
      `import { PrismaClient } from '@oto/db';
export const c = new PrismaClient();
`,
    ];
    for (const src of bad) {
      const [result] = await eslint.lintText(src, { filePath: resolve(repoRoot, 'apps/api/src/modules/me/bad2.service.ts') });
      expect(result.messages.some((m) => m.ruleId === 'no-restricted-syntax')).toBe(true);
    }
  });
});
