import type { Metadata } from 'next';
import { ForgotPasswordForm } from './forgot-password-form';

export const metadata: Metadata = { title: 'Şifremi unuttum' };

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
