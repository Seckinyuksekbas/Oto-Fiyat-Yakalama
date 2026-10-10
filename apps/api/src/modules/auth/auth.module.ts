import { Module } from '@nestjs/common';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

@Module({
  providers: [PasswordService, TokenService, SessionService],
  exports: [PasswordService, TokenService, SessionService],
})
export class AuthModule {}
