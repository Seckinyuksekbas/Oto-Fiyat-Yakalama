/** /me/channels sözleşmesi ve önbellek anahtarı: profiller ve ayarlar aynı modülü kullanır. */
export interface ChannelItem {
  type: 'IN_APP' | 'TELEGRAM';
  linked?: boolean;
  isVerified: boolean;
  isEnabled: boolean;
}

export interface ChannelsResponse {
  items: ChannelItem[];
  telegramAvailable: boolean;
}

export const CHANNELS_KEY = ['channels'] as const;
