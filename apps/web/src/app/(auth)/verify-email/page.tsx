import { Suspense } from 'react';
import type { Metadata } from 'next';
import { VerifyEmail } from './verify-email';

export const metadata: Metadata = { title: 'E-posta doğrulama' };

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}
