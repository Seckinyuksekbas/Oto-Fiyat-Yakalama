'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { SearchX } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { ProfileWizard } from '@/components/profile-wizard';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { apiErrorMessage } from '@/lib/messages';
import { useProfile } from '@/lib/profile-queries';

export default function EditProfilePage() {
  const params = useParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const q = useProfile(id ?? '');

  if (q.isPending) return <Skeleton aria-busy="true" aria-label="Profil yükleniyor" className="mx-auto h-[420px] w-full max-w-[1180px] rounded-lg" />;
  if (q.isError) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <EmptyState
        icon={<SearchX className="size-5" />}
        title={missing ? 'Profil bulunamadı' : 'Profil yüklenemedi'}
        description={missing ? 'Bu profil silinmiş olabilir.' : apiErrorMessage(q.error)}
        action={
          <Button asChild variant="secondary">
            <Link href="/app/profiller">Profillere dön</Link>
          </Button>
        }
      />
    );
  }
  return <ProfileWizard profile={q.data} />;
}
