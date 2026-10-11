'use client';
import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { applyPreference, readPreference, type ThemePreference } from '@/lib/theme';

const icons = { system: Monitor, dark: Moon, light: Sun } as const;

export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePreference>('system');

  useEffect(() => {
    setPref(readPreference());
  }, []);

  // Sistem teması değişikliği kökte (Providers → watchSystemTheme) izlenir.

  const Icon = icons[pref];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Tema" className="px-2">
          <Icon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={pref}
          onValueChange={(v) => {
            const next = v as ThemePreference;
            setPref(next);
            applyPreference(next);
          }}
        >
          <DropdownMenuRadioItem value="system">Sistem</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Koyu</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">Açık</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
