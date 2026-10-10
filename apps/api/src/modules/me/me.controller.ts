import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import {
  changePasswordSchema,
  deleteMeSchema,
  updateMeSchema,
  type ChangePasswordInput,
  type DeleteMeInput,
  type UpdateMeInput,
} from '@oto/shared';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user';
import { ZodPipe } from '../../common/zod.pipe';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import type { AuthUser } from '../auth/auth-user';
import { clearAuthCookies } from '../auth/cookies';
import { MeService } from './me.service';

@Controller('me')
export class MeController {
  constructor(
    private readonly me: MeService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.me.getProfile(user.id);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body(new ZodPipe(updateMeSchema)) body: UpdateMeInput) {
    return this.me.updateName(user.id, body);
  }

  @Post('change-password')
  @HttpCode(204)
  async changePassword(@CurrentUser() user: AuthUser, @Body(new ZodPipe(changePasswordSchema)) body: ChangePasswordInput) {
    await this.me.changePassword(user, body);
  }

  @Get('sessions')
  sessions(@CurrentUser() user: AuthUser) {
    return this.me.listSessions(user);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.me.revokeSession(user.id, id);
  }

  @Delete()
  @HttpCode(204)
  async deleteAccount(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(deleteMeSchema)) body: DeleteMeInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.me.deleteAccount(user.id, body);
    clearAuthCookies(res, this.env);
  }
}
