import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { renderWithClient } from '@/test/render';

const push = vi.fn();
const replace = vi.fn();
let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => search,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { LoginForm } from './giris/login-form';
import { RegisterForm } from './kayit/register-form';
import { ForgotPasswordForm } from './sifremi-unuttum/forgot-password-form';
import { ResetPasswordForm } from './reset-password/reset-password-form';
import { VerifyEmail } from './verify-email/verify-email';

const apiError = (code: string, status: number) =>
  HttpResponse.json({ error: { code, message: 'x' } }, { status });

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
  search = new URLSearchParams();
});

describe('LoginForm', () => {
  it('shows field errors on empty submit and does not call the API', async () => {
    let called = false;
    server.use(
      http.post('/api/v1/auth/login', () => {
        called = true;
        return HttpResponse.json({});
      }),
    );
    renderWithClient(<LoginForm />);
    await userEvent.click(screen.getByRole('button', { name: 'Giriş yap' }));
    expect(await screen.findByText('Geçerli bir e-posta adresi girin')).toBeInTheDocument();
    expect(screen.getByText('Bu alan zorunlu')).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it('shows Turkish message on INVALID_CREDENTIALS', async () => {
    server.use(http.post('/api/v1/auth/login', () => apiError('INVALID_CREDENTIALS', 401)));
    renderWithClient(<LoginForm />);
    await userEvent.type(screen.getByLabelText('E-posta'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Şifre'), 'yanlis-sifre');
    await userEvent.click(screen.getByRole('button', { name: 'Giriş yap' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('E-posta veya şifre hatalı');
  });

  it('shows lock message on LOGIN_LOCKED', async () => {
    server.use(http.post('/api/v1/auth/login', () => apiError('LOGIN_LOCKED', 429)));
    renderWithClient(<LoginForm />);
    await userEvent.type(screen.getByLabelText('E-posta'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Şifre'), 'yanlis-sifre');
    await userEvent.click(screen.getByRole('button', { name: 'Giriş yap' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/geçici olarak kilitlendi/i);
  });

  it.each([
    ['/app/firsatlar', '/app/firsatlar'],
    ['https://kotu.com', '/app'],
    ['//kotu.com', '/app'],
  ])('after login with next=%s navigates to %s', async (next, target) => {
    search = new URLSearchParams({ next });
    server.use(http.post('/api/v1/auth/login', () => HttpResponse.json({ user: { id: 'u1' } })));
    renderWithClient(<LoginForm />);
    await userEvent.type(screen.getByLabelText('E-posta'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Şifre'), 'dogru-sifre');
    await userEvent.click(screen.getByRole('button', { name: 'Giriş yap' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(target));
  });

  it('with try_refresh=1 refreshes the session first and returns to next', async () => {
    search = new URLSearchParams({ next: '/app/favoriler', try_refresh: '1' });
    server.use(http.post('/api/v1/auth/refresh', () => new HttpResponse(null, { status: 204 })));
    renderWithClient(<LoginForm />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/app/favoriler'));
  });

  it('with try_refresh=1 falls back to the form when refresh fails', async () => {
    search = new URLSearchParams({ next: '/app', try_refresh: '1' });
    server.use(http.post('/api/v1/auth/refresh', () => apiError('TOKEN_INVALID', 401)));
    renderWithClient(<LoginForm />);
    expect(await screen.findByLabelText('E-posta')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('RegisterForm', () => {
  async function fill() {
    await userEvent.type(screen.getByLabelText('Ad'), 'Ayşe');
    await userEvent.type(screen.getByLabelText('E-posta'), 'ayse@example.com');
    await userEvent.type(screen.getByLabelText('Şifre'), 'uzun-bir-sifre-1');
  }

  it('does not submit without KVKK consent', async () => {
    let called = false;
    server.use(
      http.post('/api/v1/auth/register', () => {
        called = true;
        return HttpResponse.json({ user: {} }, { status: 201 });
      }),
    );
    renderWithClient(<RegisterForm />);
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Hesap oluştur' }));
    expect(await screen.findByText('Devam etmek için onay vermeniz gerekir')).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it('requires a password of at least 10 characters', async () => {
    renderWithClient(<RegisterForm />);
    await userEvent.type(screen.getByLabelText('Ad'), 'Ayşe');
    await userEvent.type(screen.getByLabelText('E-posta'), 'ayse@example.com');
    await userEvent.type(screen.getByLabelText('Şifre'), 'kisa');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Hesap oluştur' }));
    expect(await screen.findByText('En az 10 karakter olmalı')).toBeInTheDocument();
  });

  it('maps EMAIL_TAKEN', async () => {
    server.use(http.post('/api/v1/auth/register', () => apiError('EMAIL_TAKEN', 409)));
    renderWithClient(<RegisterForm />);
    await fill();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Hesap oluştur' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bu e-posta adresiyle bir hesap zaten var');
  });

  it('maps WEAK_PASSWORD', async () => {
    server.use(http.post('/api/v1/auth/register', () => apiError('WEAK_PASSWORD', 422)));
    renderWithClient(<RegisterForm />);
    await fill();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Hesap oluştur' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/çok kolay tahmin/i);
  });

  it('sends the payload and goes to next on success', async () => {
    search = new URLSearchParams({ next: '/app/profiller' });
    let body: unknown;
    server.use(
      http.post('/api/v1/auth/register', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ user: { id: 'u1' } }, { status: 201 });
      }),
    );
    renderWithClient(<RegisterForm />);
    await fill();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Hesap oluştur' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/profiller'));
    expect(body).toEqual({ name: 'Ayşe', email: 'ayse@example.com', password: 'uzun-bir-sifre-1', kvkkAccepted: true });
  });
});

describe('ForgotPasswordForm', () => {
  const MESSAGE = /bağlantısı gönderdik/i;

  it('shows the same message when the request succeeds', async () => {
    server.use(http.post('/api/v1/auth/forgot-password', () => new HttpResponse(null, { status: 204 })));
    renderWithClient(<ForgotPasswordForm />);
    await userEvent.type(screen.getByLabelText('E-posta'), 'var@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Bağlantı gönder' }));
    expect(await screen.findByRole('status')).toHaveTextContent(MESSAGE);
  });

  it('shows the same message even when the API fails', async () => {
    server.use(http.post('/api/v1/auth/forgot-password', () => apiError('RATE_LIMITED', 429)));
    renderWithClient(<ForgotPasswordForm />);
    await userEvent.type(screen.getByLabelText('E-posta'), 'yok@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Bağlantı gönder' }));
    expect(await screen.findByRole('status')).toHaveTextContent(MESSAGE);
  });
});

describe('ResetPasswordForm', () => {
  const token = 't'.repeat(32);

  it('shows an invalid-link state without a token', () => {
    renderWithClient(<ResetPasswordForm />);
    expect(screen.getByText(/bağlantı geçersiz/i)).toBeInTheDocument();
  });

  it('submits token and new password, then shows success', async () => {
    search = new URLSearchParams({ token });
    let body: unknown;
    server.use(
      http.post('/api/v1/auth/reset-password', async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithClient(<ResetPasswordForm />);
    await userEvent.type(screen.getByLabelText('Yeni şifre'), 'yepyeni-sifre-1');
    await userEvent.click(screen.getByRole('button', { name: 'Şifreyi güncelle' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/şifreniz güncellendi/i);
    expect(body).toEqual({ token, newPassword: 'yepyeni-sifre-1' });
  });

  it('maps TOKEN_INVALID', async () => {
    search = new URLSearchParams({ token });
    server.use(http.post('/api/v1/auth/reset-password', () => apiError('TOKEN_INVALID', 400)));
    renderWithClient(<ResetPasswordForm />);
    await userEvent.type(screen.getByLabelText('Yeni şifre'), 'yepyeni-sifre-1');
    await userEvent.click(screen.getByRole('button', { name: 'Şifreyi güncelle' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/geçersiz veya süresi dolmuş/i);
  });
});

describe('VerifyEmail', () => {
  const token = 'v'.repeat(32);

  it('posts the token once and shows success', async () => {
    search = new URLSearchParams({ token });
    let calls = 0;
    server.use(
      http.post('/api/v1/auth/verify-email', () => {
        calls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithClient(<VerifyEmail />);
    expect(await screen.findByText(/e-posta adresiniz doğrulandı/i)).toBeInTheDocument();
    expect(calls).toBe(1);
  });

  it('shows the failure state and a resend form for an invalid token', async () => {
    search = new URLSearchParams({ token });
    server.use(
      http.post('/api/v1/auth/verify-email', () => apiError('TOKEN_INVALID', 400)),
      http.post('/api/v1/auth/resend-verification', () => new HttpResponse(null, { status: 204 })),
    );
    renderWithClient(<VerifyEmail />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/geçersiz veya süresi dolmuş/i);
    await userEvent.type(screen.getByLabelText('E-posta'), 'a@b.co');
    await userEvent.click(screen.getByRole('button', { name: 'Yeniden gönder' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/gönderdik/i);
  });
});
