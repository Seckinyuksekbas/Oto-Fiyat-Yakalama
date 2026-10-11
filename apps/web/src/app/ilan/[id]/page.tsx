import { notFound, redirect } from 'next/navigation';

/** Telegram "Analizi gör" bağlantıları /ilan/:id kullanır; panel sayfasına yönlendirilir. */
export default async function ListingRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{1,10}$/.test(id)) notFound();
  redirect(`/app/ilan/${id}`);
}
