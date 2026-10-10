const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'refreshToken',
  'accessToken',
  'chatId',
  'config',
  'proxyUrl',
  'urlEncrypted',
];

/** pino joker karakterleri tam bir seviyeyi eşler; üst seviye, 1 ve 2 seviye derinlik kapsanır. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]),
];
