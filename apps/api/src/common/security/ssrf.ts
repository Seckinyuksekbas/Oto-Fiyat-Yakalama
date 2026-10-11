import { assertPublicHttpUrl as assertPublic, isPrivateAddress, UnsafeUrlError, type SsrfOptions } from '@oto/server-common';
import { ErrorCode } from '@oto/shared';
import { AppError } from '../errors/app-error';

export { isPrivateAddress };
export type { SsrfOptions };

/** Paylaşılan SSRF denetimi; ihlalde AppError(VALIDATION_FAILED, 400). */
export async function assertPublicHttpUrl(url: string, opts: SsrfOptions): Promise<void> {
  try {
    await assertPublic(url, opts);
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw new AppError(ErrorCode.VALIDATION_FAILED, 400, err.message);
    throw err;
  }
}
