export const Role = { USER: 'USER', ADMIN: 'ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' } as const;
export type Role = (typeof Role)[keyof typeof Role];

export const UserStatus = { ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED', DELETED: 'DELETED' } as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const ChannelType = { IN_APP: 'IN_APP', TELEGRAM: 'TELEGRAM', EMAIL: 'EMAIL' } as const;
export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType];
