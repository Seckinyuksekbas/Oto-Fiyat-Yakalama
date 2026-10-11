import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminListingsController } from './listings.controller';
import { AdminListingsService } from './listings.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminUsersController, AdminListingsController],
  providers: [AdminUsersService, AdminListingsService],
})
export class AdminModule {}
