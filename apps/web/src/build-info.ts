import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Docker derlemesi (docker/web.Dockerfile) derleme anındaki API_ORIGIN'i buraya yazar. rewrites hedefi
 * derlemede sabitlendiğinden çalışma zamanı değeri bundan farklıysa yapılandırma yanlıştır.
 * Yerel derlemelerde dosya yoktur; denetim atlanır.
 */
export const BUILD_API_ORIGIN_FILE = join('.next', 'build-api-origin');

export function readBuildApiOrigin(cwd: string = process.cwd()): string | null {
  try {
    const value = readFileSync(join(cwd, BUILD_API_ORIGIN_FILE), 'utf8').trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}
