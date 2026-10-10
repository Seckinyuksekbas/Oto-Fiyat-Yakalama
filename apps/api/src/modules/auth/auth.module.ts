import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailVerificationService } from './email-verification.service';
import { LoginAttemptService } from './login-attempt.service';
import { PasswordConfirmationService } from './password-confirmation.service';
import { PasswordResetService } from './password-reset.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController],
  providers: [
    PasswordService,
    PasswordConfirmationService,
    TokenService,
    SessionService,
    LoginAttemptService,
    EmailVerificationService,
    PasswordResetService,
    AuthService,
  ],
  exports: [PasswordService, PasswordConfirmationService, TokenService, SessionService],
})
export class AuthModule {}
