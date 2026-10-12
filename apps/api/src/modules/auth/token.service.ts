import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Role } from '@oto/db';
import { importPKCS8, importSPKI, jwtVerify, SignJWT, type KeyLike } from 'jose';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { ACCESS_TTL_SEC, JWT_AUDIENCE, JWT_ISSUER } from './auth.constants';

export interface AccessClaims {
  userId: string;
  role: Role;
  sessionId: string;
}

const ROLES: readonly string[] = ['USER', 'ADMIN', 'SUPER_ADMIN'];

@Injectable()
export class TokenService implements OnModuleInit {
  private privateKey!: KeyLike;
  private publicKey!: KeyLike;

  constructor(@Inject(ENV) private readonly env: Env) {}

  async onModuleInit(): Promise<void> {
    this.privateKey = await importPKCS8(this.env.JWT_PRIVATE_KEY, 'EdDSA');
    this.publicKey = await importSPKI(this.env.JWT_PUBLIC_KEY, 'EdDSA');
    await this.selfTest();
  }

  /** Açılışta imzala/doğrula gidiş-dönüşü: anahtarlar aynı çiftten değilse süreç başlamaz. */
  private async selfTest(): Promise<void> {
    const probe = await new SignJWT({ probe: true })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setExpirationTime('1m')
      .sign(this.privateKey);
    try {
      await jwtVerify(probe, this.publicKey, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, algorithms: ['EdDSA'] });
    } catch {
      throw new Error('JWT anahtar self-test başarısız: JWT_PRIVATE_KEY ile JWT_PUBLIC_KEY aynı anahtar çiftine ait değil');
    }
  }

  signAccess(c: AccessClaims): Promise<string> {
    return new SignJWT({ role: c.role, sid: c.sessionId })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(c.userId)
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SEC}s`)
      .sign(this.privateKey);
  }

  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithms: ['EdDSA'],
      });
      const { sub, sid, role } = payload;
      if (typeof sub !== 'string' || typeof sid !== 'string' || typeof role !== 'string' || !ROLES.includes(role)) {
        return null;
      }
      return { userId: sub, role: role as Role, sessionId: sid };
    } catch {
      return null;
    }
  }
}
