/**
 * Kaynak `config` gizli anahtar maskesi (Plan 08 kararı). Gizli adlı (`isSecretConfigKey`) bir anahtarın altındaki
 * string/sayı değerler, iç içe nesne ve dizilerde de, yanıtlarda ve denetim kaydında (before/after) `"***"` olarak döner.
 * Gizli adlı bir anahtarın TÜM torunları gizlidir (ör. `auth: { user, pass }` → ikisi de maskeli). Boolean ve null gizli
 * bilgi taşımaz.
 *
 * PATCH'te `"***"` gelen gizli yaprak saklı değeri korur (`mergeMaskedConfig`); böylece istemci maskeli görünümü
 * olduğu gibi geri gönderebilir. Dizilerde eşleme sıra (indeks) ile yapıldığından, maske içeren bir dizinin uzunluğu ya
 * da maske içeren nesne öğelerinin gizli olmayan alanları değişmişse `"***"` güvenle eşlenemez ve reddedilir.
 */
export const CONFIG_SECRET_MASK = '***';

/** Tek başına gizli sayılan ad parçaları (camelCase / `_` / `-` / `.` ile bölünmüş, küçük harf). */
const SECRET_SEGMENTS = new Set([
  'apikey', 'apikeys', 'token', 'tokens', 'secret', 'secrets', 'pass', 'password', 'passwords', 'passwd', 'auth', 'authorization',
  'credential', 'credentials',
]);
/** `key` parçası ancak tek başına ya da bu niteleyicilerden sonra gelirse gizlidir (`sortKey`, `searchKey` değil). */
const KEY_QUALIFIERS = new Set(['api', 'private', 'secret', 'access']);

export function configKeySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

/**
 * Anahtar adı gizli mi? Kural (docs/admin.md): adın bir parçası `SECRET_SEGMENTS` içindeyse; ya da ad yalnızca `key`
 * ise ya da `apiKey` / `privateKey` / `secretKey` / `accessKey` ile bitiyorsa. Alt dize eşleşmesi yapılmaz
 * (`keywords`, `authorName`, `bypassCache`, `passengers`, `sortKey`, `maxKeys` gizli değildir).
 */
export function isSecretConfigKey(key: string): boolean {
  const seg = configKeySegments(key);
  if (seg.some((s) => SECRET_SEGMENTS.has(s))) return true;
  const last = seg.at(-1);
  if (last !== 'key') return false;
  return seg.length === 1 || KEY_QUALIFIERS.has(seg.at(-2)!);
}

/** `"***"` güvenle saklı değere eşlenemiyor (karşılığı yok ya da dizi değişmiş). Servis 400'e çevirir. */
export class MaskedSecretMissingError extends Error {
  constructor(
    readonly path: string,
    message = `Gizli alan "${path}" için saklı değer yok; yeni değeri yazın`,
  ) {
    super(message);
    this.name = 'MaskedSecretMissingError';
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isMaskableLeaf = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint';
const childSecret = (parentSecret: boolean, key: string) => parentSecret || isSecretConfigKey(key);

function maskValue(value: unknown, secret: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => maskValue(v, secret));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskValue(v, childSecret(secret, k))]));
  }
  return secret && isMaskableLeaf(value) ? CONFIG_SECRET_MASK : value;
}

export function maskConfigSecrets(config: Record<string, unknown>): Record<string, unknown> {
  return maskValue(config, false) as Record<string, unknown>;
}

function hasMask(value: unknown, secret: boolean): boolean {
  if (secret && value === CONFIG_SECRET_MASK) return true;
  if (Array.isArray(value)) return value.some((v) => hasMask(v, secret));
  if (isPlainObject(value)) return Object.entries(value).some(([k, v]) => hasMask(v, childSecret(secret, k)));
  return false;
}

/** Config gizli bir yerde `"***"` taşıyor mu (ör. oluşturmada saklı değer olmadığından reddedilir). */
export function containsMaskedSecret(config: unknown): boolean {
  return hasMask(config, false);
}

/** Gizli olmayan kısım (gizli alt ağaçlar atılır), anahtar sırasından bağımsız karşılaştırma için kanonik JSON. */
function publicPart(value: unknown, secret: boolean): unknown {
  if (secret) return undefined;
  if (Array.isArray(value)) return value.map((v) => publicPart(v, false) ?? null);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => !isSecretConfigKey(k))
        .map((k) => [k, publicPart(value[k], false)]),
    );
  }
  return value;
}
const samePublic = (a: unknown, b: unknown, secret: boolean) => JSON.stringify(publicPart(a, secret)) === JSON.stringify(publicPart(b, secret));

const ARRAY_CHANGED = (path: string) =>
  new MaskedSecretMissingError(
    path,
    `"${path}" dizisi değiştiği (öğe eklendi, silindi ya da sırası değişti) için *** değerleri eşlenemiyor; bu dizideki gizli değerleri yeniden yazın`,
  );

function mergeValue(stored: unknown, patch: unknown, secret: boolean, path: string): unknown {
  if (secret && patch === CONFIG_SECRET_MASK) {
    if (stored === undefined || stored === null || !isMaskableLeaf(stored)) throw new MaskedSecretMissingError(path);
    return stored;
  }
  if (Array.isArray(patch)) {
    const s = Array.isArray(stored) ? stored : [];
    if (hasMask(patch, secret)) {
      // İndeksle eşleme yalnızca dizi aynı kaldıysa güvenli: uzunluk aynı ve maske içeren nesne öğelerinin gizli olmayan alanları aynı.
      if (s.length !== patch.length) throw ARRAY_CHANGED(path);
      patch.forEach((el, i) => {
        if (isPlainObject(el) && hasMask(el, secret) && !samePublic(el, s[i], secret)) throw ARRAY_CHANGED(path);
      });
    }
    return patch.map((v, i) => mergeValue(s[i], v, secret, `${path}[${i}]`));
  }
  if (isPlainObject(patch)) {
    const s = isPlainObject(stored) ? stored : {};
    return Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, mergeValue(s[k], v, childSecret(secret, k), path ? `${path}.${k}` : k)]));
  }
  return patch;
}

/**
 * PATCH config'i saklı config ile birleştirir: gizli alanda `"***"` → aynı yoldaki saklı değer. Diğer her şey patch'ten
 * gelir (config bütün olarak değiştirilir; patch'te olmayan anahtarlar düşer).
 * @throws MaskedSecretMissingError `"***"` için saklı değer yoksa ya da maske içeren dizi değişmişse
 */
export function mergeMaskedConfig(stored: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  return mergeValue(stored, patch, false, '') as Record<string, unknown>;
}
