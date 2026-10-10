import type { SourceAdapter } from './adapter';
import { DemoSiteAdapter } from './adapters/demo-site.adapter';

/**
 * adapterKey → adapter. Yeni kaynak eklerken yalnızca buraya bir satır eklenir.
 * İzin/lisans doğrulanmamış hiçbir site için adapter eklenmez (docs/adding-a-source.md).
 */
const FACTORIES: Record<string, () => SourceAdapter> = {
  'demo-site': () => new DemoSiteAdapter(),
};

export const ADAPTER_KEYS = Object.keys(FACTORIES);

export function getAdapter(key: string): SourceAdapter {
  const factory = FACTORIES[key];
  if (!factory) throw new Error(`Bilinmeyen adapter: ${key}`);
  return factory();
}
