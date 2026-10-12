export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Bir refresh ailesinin mutlak ömrü: rotasyonla uzatılamaz. */
export const REFRESH_FAMILY_MAX_MS = 90 * 24 * 60 * 60 * 1000;
export const ROTATION_GRACE_MS = 10_000;
export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 30 * 60 * 1000;
export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
export const REFRESH_PATH = '/api/v1/auth';
export const JWT_ISSUER = 'oto-api';
export const JWT_AUDIENCE = 'oto-web';
/** E-posta başına forgot-password bekleme süresi (sn). */
export const FORGOT_COOLDOWN_SEC = 60;
