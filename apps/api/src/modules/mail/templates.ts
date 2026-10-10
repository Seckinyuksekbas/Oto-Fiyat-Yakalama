export function verifyEmailMail(name: string, link: string) {
  return {
    subject: 'E-posta adresinizi doğrulayın',
    text: `Merhaba ${name},\n\nHesabınızı etkinleştirmek için bağlantıya tıklayın (24 saat geçerli):\n${link}\n\nBu işlemi siz yapmadıysanız bu e-postayı yok sayabilirsiniz.\n\nOto Fırsat`,
  };
}

export function resetPasswordMail(name: string, link: string) {
  return {
    subject: 'Şifre sıfırlama isteği',
    text: `Merhaba ${name},\n\nŞifrenizi sıfırlamak için bağlantıya tıklayın (30 dakika geçerli):\n${link}\n\nBu isteği siz yapmadıysanız şifreniz değişmez; bu e-postayı yok sayabilirsiniz.\n\nOto Fırsat`,
  };
}
