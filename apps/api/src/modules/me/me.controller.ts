import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user';
import type { AuthUser } from '../auth/auth-user';
import { MeService } from './me.service';

@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.me.getProfile(user.id);
  }
}
