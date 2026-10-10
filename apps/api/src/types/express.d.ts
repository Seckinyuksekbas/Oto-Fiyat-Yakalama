import type { AuthUser } from '../modules/auth/auth-user';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
