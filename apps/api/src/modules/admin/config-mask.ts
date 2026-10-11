/**
 * Kaynak `config` gizli anahtar maskesi (Plan 08 kararı). Anahtar adı `SECRET_CONFIG_KEY` ile eşleşen string/sayı
 * değerler yanıtlarda ve denetim kaydında (before/after) `"***"` olarak döner. İç içe nesne ve diziler özyinelemeli
 * gezilir; gizli adlı bir nesne de gezilir (yalnızca gizli yaprakları maskelenir). Boolean ve null gizli bilgi taşımaz.
 *
 * PATCH'te `"***"` gelen gizli yaprak saklı değeri korur (`mergeMaskedConfig`); böylece istemci maskeli görünümü
 * olduğu gibi geri gönderebilir.
 */
export const SECRET_CONFIG_KEY = /(key|token|secret|pass(word)?|auth)/i;
export const CONFIG_SECRET_MASK = '***';

export const isSecretConfigKey = (key: string): boolean => SECRET_CONFIG_KEY.test(key);

/** `"***"` gönderilen gizli alanın saklı bir karşılığı yok (ör. yeni anahtar). Servis 400'e çevirir. */
export class MaskedSecretMissingError extends Error {
  constructor(readonly path: string) {
    super(`Gizli alan "${path}" için saklı değer yok; yeni değeri yazın`);
    this.name = 'MaskedSecretMissingError';
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isMaskableLeaf = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint';

function maskValue(value: unknown, secretKey: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => maskValue(v, secretKey));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskValue(v, isSecretConfigKey(k))]));
  }
  return secretKey && isMaskableLeaf(value) ? CONFIG_SECRET_MASK : value;
}

export function maskConfigSecrets(config: Record<string, unknown>): Record<string, unknown> {
  return maskValue(config, false) as Record<string, unknown>;
}

function mergeValue(stored: unknown, patch: unknown, secretKey: boolean, path: string): unknown {
  if (secretKey && patch === CONFIG_SECRET_MASK) {
    if (stored === undefined || stored === null || !isMaskableLeaf(stored)) throw new MaskedSecretMissingError(path);
    return stored;
  }
  if (Array.isArray(patch)) {
    const s = Array.isArray(stored) ? stored : [];
    return patch.map((v, i) => mergeValue(s[i], v, secretKey, `${path}[${i}]`));
  }
  if (isPlainObject(patch)) {
    const s = isPlainObject(stored) ? stored : {};
    return Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, mergeValue(s[k], v, isSecretConfigKey(k), path ? `${path}.${k}` : k)]));
  }
  return patch;
}

/**
 * PATCH config'i saklı config ile birleştirir: gizli adlı alanda `"***"` → aynı yoldaki saklı değer. Diğer her şey
 * patch'ten gelir (config bütün olarak değiştirilir; patch'te olmayan anahtarlar düşer).
 * @throws MaskedSecretMissingError `"***"` için saklı değer yoksa
 */
export function mergeMaskedConfig(stored: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  return mergeValue(stored, patch, false, '') as Record<string, unknown>;
}
