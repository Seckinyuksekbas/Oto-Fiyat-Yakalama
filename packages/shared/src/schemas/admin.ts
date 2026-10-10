import { z } from 'zod';

export const adminUsersQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']).optional(),
    role: z.enum(['USER', 'ADMIN', 'SUPER_ADMIN']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;
