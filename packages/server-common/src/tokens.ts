import { createHash, randomBytes } from 'node:crypto';

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Yüksek entropili tokenlar için SHA-256 yeterlidir (şifre değildir). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
