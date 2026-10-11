/** Seed'in güvensiz bir yapılandırmayla çalışmasını engeller. */
export function assertSeedEnv(env: Record<string, string | undefined>): void {
  if (env.NODE_ENV === 'production' && env.SEED_DEMO_SOURCE === 'true') {
    throw new Error(
      'Invalid environment: SEED_DEMO_SOURCE: production ortamında true olamaz (demo kaynak yalnızca geliştirme içindir)',
    );
  }
}
