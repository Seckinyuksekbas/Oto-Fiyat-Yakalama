import { SetMetadata } from '@nestjs/common';
import type { Role } from '@oto/db';

export const ROLES = 'auth:roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);
