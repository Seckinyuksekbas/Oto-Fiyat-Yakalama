import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ErrorCode,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  type LoginInput,
  type RegisterInput,
  type ResetPasswordInput,
} from '@oto/shared';
import type { Request, Response } from 'express';
import { Meta, type ClientMeta } from '../../common/client-meta';
import { Public } from '../../common/decorators/public';
import { AppError } from '../../common/errors/app-error';
import { ZodPipe } from '../../common/zod.pipe';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { REFRESH_COOKIE } from './auth.constants';
import { AuthService } from './auth.service';
import { clearAuthCookies, setAuthCookies } from './cookies';
import { EmailVerificationService } from './email-verification.service';
import { PasswordResetService } from './password-reset.service';

function refreshCookie(req: Request): string | undefined {
  const v: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

@Public()
@Throttle({ default: { limit: 10, ttl: 60_000 } })
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly verification: EmailVerificationService,
    private readonly resets: PasswordResetService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('register')
  async register(
    @Body(new ZodPipe(registerSchema)) body: RegisterInput,
    @Meta() meta: ClientMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.auth.register(body, meta);
    setAuthCookies(res, this.env, r.accessToken, r.refreshToken);
    return { user: r.user };
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(loginSchema)) body: LoginInput,
    @Meta() meta: ClientMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.auth.login(body, meta);
    setAuthCookies(res, this.env, r.accessToken, r.refreshToken);
    return { user: r.user };
  }

  @Post('refresh')
  @HttpCode(204)
  async refresh(@Req() req: Request, @Meta() meta: ClientMeta, @Res({ passthrough: true }) res: Response) {
    const out = await this.auth.refresh(refreshCookie(req), meta);
    if (out.kind === 'ok') {
      setAuthCookies(res, this.env, out.accessToken, out.refreshToken);
      return;
    }
    if (out.kind === 'race') {
      throw new AppError(ErrorCode.REFRESH_RACE, 401, 'Oturum yenileniyor, lütfen tekrar deneyin');
    }
    clearAuthCookies(res, this.env);
    if (out.kind === 'reused') {
      throw new AppError(ErrorCode.REFRESH_REUSED, 401, 'Oturumunuz güvenlik nedeniyle sonlandırıldı');
    }
    throw new AppError(ErrorCode.TOKEN_INVALID, 401, 'Oturum süresi doldu, lütfen tekrar giriş yapın');
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(refreshCookie(req));
    clearAuthCookies(res, this.env);
  }

  @Post('verify-email')
  @HttpCode(204)
  async verifyEmail(@Body(new ZodPipe(verifyEmailSchema)) body: { token: string }) {
    if (!(await this.verification.verify(body.token))) {
      throw new AppError(ErrorCode.TOKEN_INVALID, 400, 'Bağlantı geçersiz veya süresi dolmuş');
    }
  }

  @Post('resend-verification')
  @HttpCode(204)
  async resendVerification(@Body(new ZodPipe(resendVerificationSchema)) body: { email: string }) {
    await this.verification.resend(body.email);
  }

  @Post('forgot-password')
  @HttpCode(204)
  async forgotPassword(@Body(new ZodPipe(forgotPasswordSchema)) body: { email: string }) {
    await this.resets.request(body.email);
  }

  @Post('reset-password')
  @HttpCode(204)
  async resetPassword(@Body(new ZodPipe(resetPasswordSchema)) body: ResetPasswordInput, @Meta() meta: ClientMeta) {
    if (!(await this.resets.reset(body, meta))) {
      throw new AppError(ErrorCode.TOKEN_INVALID, 400, 'Bağlantı geçersiz veya süresi dolmuş');
    }
  }
}
