import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'KVKK aydınlatma metni' };

const sections: { title: string; body: string }[] = [
  {
    title: 'Hangi verileri işliyoruz',
    body: 'Hesabınız için e-posta adresiniz, adınız ve şifrenizin tek yönlü özeti; kullanımınız için arama profilleriniz, favorileriniz, bildirim tercihleriniz ve bildirim geçmişiniz; güvenlik için oturum kayıtlarınız (IP adresi, tarayıcı bilgisi, giriş zamanı).',
  },
  {
    title: 'Ne için kullanıyoruz',
    body: 'Hesabınızı yönetmek, arama profilinize uyan ilanları size bildirmek, hesabınızı yetkisiz erişime karşı korumak ve hizmeti yasal yükümlülüklere uygun işletmek.',
  },
  {
    title: 'Ne kadar saklıyoruz',
    body: 'Hesabınız açık olduğu sürece. Hesabınızı sildiğinizde kişisel bilgileriniz anonimleştirilir; arama profilleriniz, kanallarınız ve favorileriniz silinir. Bildirimler 90 gün, sistem kayıtları 30 gün, denetim kayıtları 1 yıl sonra temizlenir.',
  },
  {
    title: 'Paylaşım',
    body: 'Verilerinizi üçüncü taraflara satmayız. Bildirimleri iletmek için seçtiğiniz kanalın (e-posta ya da Telegram) hizmet sağlayıcısına yalnızca bildirimin içeriği ulaşır.',
  },
  {
    title: 'Haklarınız',
    body: '6698 sayılı Kanun’un 11. maddesi uyarınca verilerinize erişebilir, düzeltilmesini ya da silinmesini isteyebilir, işlemeye itiraz edebilirsiniz. Hesap ayarlarından hesabınızı silebilir ya da bize e-posta ile başvurabilirsiniz.',
  },
];

export default function KvkkPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-14">
      <Link href="/kayit" className="text-sm text-[var(--color-muted)] underline underline-offset-4">
        Kayıt sayfasına dön
      </Link>
      <h1 className="mt-6 text-3xl font-semibold">KVKK aydınlatma metni</h1>
      <p className="mt-3 max-w-[60ch] text-[var(--color-muted)]">
        Kişisel verilerinizin nasıl işlendiğinin kısa özeti. Kayıt olurken bu metni okuduğunuzu onaylarsınız.
      </p>
      <div className="mt-10 space-y-8">
        {sections.map((s) => (
          <section key={s.title}>
            <h2 className="text-lg font-semibold">{s.title}</h2>
            <p className="mt-2 max-w-[65ch] leading-relaxed">{s.body}</p>
          </section>
        ))}
      </div>
    </main>
  );
}
