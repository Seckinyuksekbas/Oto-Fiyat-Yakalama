import { z } from 'zod';
import { anyPasswordSchema, newPasswordSchema } from './auth';

export const updateMeSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export type UpdateMeInput = z.infer<typeof updateMeSchema>;

export const changePasswordSchema = z
  .object({ currentPassword: anyPasswordSchema, newPassword: newPasswordSchema })
  .strict();
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const deleteMeSchema = z.object({ password: anyPasswordSchema }).strict();
export type DeleteMeInput = z.infer<typeof deleteMeSchema>;
