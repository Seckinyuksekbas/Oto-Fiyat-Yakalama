'use client';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { adminErrorMessage } from '@/lib/admin-api';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: ReactNode;
  /** Açıklama ile düğmeler arasında ek içerik (ör. etkilenecek kayıt özeti). */
  children?: ReactNode;
  /** Eylemin adı; başarı toast'ı da aynı fiili kullanmalı ("Askıya al" → "Askıya alındı"). */
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  /** Yazarak onay: kullanıcı bu metni birebir yazmadan onay düğmesi etkinleşmez. */
  confirmText?: string;
  /** Yazarak onay alanının etiketi (varsayılan: "Onaylamak için <metin> yazın"). */
  confirmTextLabel?: ReactNode;
  /** Promise reddedilirse diyalog açık kalır ve hata `role="alert"` ile gösterilir; çözülürse diyalog kapanır. */
  onConfirm(): unknown;
  /** Hata → mesaj (varsayılan `adminErrorMessage`). */
  errorMessage?(err: unknown): string;
  /**
   * Kapanınca odaklanacak öğe. Tetikleyici eylem sonrası başka bir düğmeyle değişiyorsa (Askıya al → Etkinleştir)
   * kararlı bir öğeye ref verin; verilmezse Radix odağı açılıştaki öğeye döndürür.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Onay diyaloğu (Radix Dialog: odak tuzağı, Esc ile kapanma, kapanınca odak tetikleyiciye döner).
 * Varsayılan odak: yazarak onayda giriş alanı, aksi halde "Vazgeç" (yıkıcı eylem kazara onaylanmasın).
 * İşlem sürerken diyalog kapatılamaz ve düğme ikinci kez tetiklenemez (çift gönderim koruması).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = 'Vazgeç',
  tone = 'primary',
  confirmText,
  confirmTextLabel,
  onConfirm,
  errorMessage = adminErrorMessage,
  returnFocusRef,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const inputId = useId();

  useEffect(() => {
    if (open) {
      setTyped('');
      setError(null);
    }
  }, [open]);

  const typedOk = confirmText === undefined || typed.trim() === confirmText;

  const run = async () => {
    if (busy.current || !typedOk) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent
        onEscapeKeyDown={(e) => pending && e.preventDefault()}
        onInteractOutside={(e) => pending && e.preventDefault()}
        onCloseAutoFocus={(e) => {
          const el = returnFocusRef?.current;
          if (!el) return;
          e.preventDefault();
          el.focus();
        }}
        {...(description ? {} : { 'aria-describedby': undefined })}
      >
        <DialogHeader className="pr-6">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          {confirmText !== undefined ? (
            <div className="flex flex-col gap-2">
              <label htmlFor={inputId} className="text-sm text-muted">
                {confirmTextLabel ?? (
                  <>
                    Onaylamak için <span className="font-medium text-text">{confirmText}</span> yazın
                  </>
                )}
              </label>
              <Input
                id={inputId}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={pending}
              />
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-text">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
              {cancelLabel}
            </Button>
            <Button type="submit" variant={tone === 'danger' ? 'danger' : 'primary'} disabled={!typedOk || pending} aria-busy={pending || undefined}>
              {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
