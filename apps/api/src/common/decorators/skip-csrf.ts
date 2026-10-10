import { SetMetadata } from '@nestjs/common';

export const SKIP_CSRF = 'auth:skip-csrf';
/** Yalnızca kendi imza doğrulaması olan uç noktalar için (ör. Telegram webhook). */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);
