import type { Role } from '@oto/db';

export interface AuthUser {
  id: string;
  role: Role;
  /** Oturum ailesinin kimliği (Session.familyId) */
  sessionId: string;
}
