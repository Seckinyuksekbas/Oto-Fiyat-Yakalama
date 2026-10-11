import { z } from 'zod';

export const listNotificationsQuerySchema = z
  .object({
    status: z.enum(['PENDING', 'SENT', 'FAILED', 'SKIPPED_LIMIT']).optional(),
    channel: z.enum(['IN_APP', 'TELEGRAM', 'EMAIL']).optional(),
    unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    cursor: z.coerce.number().int().positive().max(2_147_483_647).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const markNotificationsReadSchema = z.union([
  z.object({ ids: z.array(z.number().int().positive().max(2_147_483_647)).min(1).max(100) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema>;

export const patchChannelSchema = z.object({ isEnabled: z.boolean() }).strict();
export type PatchChannelInput = z.infer<typeof patchChannelSchema>;

export const channelTypeParamSchema = z.enum(['IN_APP', 'TELEGRAM']);
