import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { channelTypeParamSchema, patchChannelSchema, type PatchChannelInput } from '@oto/shared';
import { CurrentUser } from '../../common/decorators/current-user';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth-user';
import { ChannelsService } from './channels.service';

@Controller('me/channels')
export class ChannelsController {
  constructor(private readonly service: ChannelsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user.id);
  }

  @Post('telegram/link')
  @HttpCode(201)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  link(@CurrentUser() user: AuthUser) {
    return this.service.createLink(user.id);
  }

  @Patch(':type')
  patch(
    @CurrentUser() user: AuthUser,
    @Param('type', new ZodPipe(channelTypeParamSchema)) type: 'IN_APP' | 'TELEGRAM',
    @Body(new ZodPipe(patchChannelSchema)) body: PatchChannelInput,
  ) {
    return this.service.patch(user.id, type, body.isEnabled);
  }

  @Delete('telegram')
  @HttpCode(204)
  async unlink(@CurrentUser() user: AuthUser): Promise<void> {
    await this.service.unlink(user.id);
  }
}
