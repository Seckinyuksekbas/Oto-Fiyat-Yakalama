import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const newPasswordSchema = z.string().min(10).max(128);
const anyPasswordSchema = z.string().min(1).max(128);
const tokenSchema = z.string().min(20).max(200);

export const registerSchema = z
  .object({
    email: emailSchema,
    password: newPasswordSchema,
    name: z.string().trim().min(1).max(80),
    kvkkAccepted: z.literal(true),
  })
  .strict();
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({ email: emailSchema, password: anyPasswordSchema }).strict();
export type LoginInput = z.infer<typeof loginSchema>;

export const verifyEmailSchema = z.object({ token: tokenSchema }).strict();
export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();
export const resetPasswordSchema = z.object({ token: tokenSchema, newPassword: newPasswordSchema }).strict();
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export { anyPasswordSchema };
