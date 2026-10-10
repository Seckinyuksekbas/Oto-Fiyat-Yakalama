import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  createSearchProfileSchema,
  updateSearchProfileSchema,
  type CreateSearchProfileInput,
  type UpdateSearchProfileInput,
} from '@oto/shared';
import { CurrentUser } from '../../common/decorators/current-user';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth-user';
import { SearchProfilesService } from './search-profiles.service';

@Controller('me/search-profiles')
export class SearchProfilesController {
  constructor(private readonly profiles: SearchProfilesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.profiles.list(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(createSearchProfileSchema)) body: CreateSearchProfileInput) {
    return this.profiles.create(user.id, body);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.profiles.get(user.id, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodPipe(updateSearchProfileSchema)) body: UpdateSearchProfileInput) {
    return this.profiles.update(user.id, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.profiles.remove(user.id, id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  pause(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.profiles.pause(user.id, id);
  }

  @Post(':id/resume')
  @HttpCode(200)
  resume(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.profiles.resume(user.id, id);
  }
}
