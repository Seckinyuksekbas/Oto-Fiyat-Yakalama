import { Global, Module } from '@nestjs/common';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { Encryptor } from './encryptor';

@Global()
@Module({
  providers: [{ provide: Encryptor, inject: [ENV], useFactory: (env: Env) => new Encryptor(env.DATA_ENCRYPTION_KEY) }],
  exports: [Encryptor],
})
export class CryptoModule {}
