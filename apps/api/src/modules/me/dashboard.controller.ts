import { Controller, Get } from '@nestjs/common';
import { startOfIstanbulDay, type Dashboard } from '@oto/shared';
import { CurrentUser } from '../../common/decorators/current-user';
import type { AuthUser } from '../auth/auth-user';
import { DashboardRepository } from './dashboard.repository';
import { LimitsService } from './limits.service';
import { toListingCard } from './listing-card.view';
import { MeRepository } from './me.repository';

const DAY_MS = 86_400_000;
const istanbulDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' });

@Controller('me/dashboard')
export class DashboardController {
  constructor(
    private readonly repo: DashboardRepository,
    private readonly me: MeRepository,
    private readonly limits: LimitsService,
  ) {}

  @Get()
  async get(@CurrentUser() user: AuthUser): Promise<Dashboard> {
    const now = new Date();
    const todayStart = startOfIstanbulDay(now);
    const seriesStart = new Date(todayStart.getTime() - 6 * DAY_MS);
    const [lim, recent, counts, perDay, notificationsToday] = await Promise.all([
      this.limits.forUser(user.id, now),
      this.repo.recentMatches(user.id, 8),
      this.repo.profileCounts(user.id),
      this.repo.matchesPerDay(user.id, seriesStart),
      this.me.countExternalNotificationsSince(user.id, todayStart),
    ]);
    const byDay = new Map(perDay.map((r) => [r.day, r.matches]));
    // İstanbul sabit UTC+3: gün başlangıcına 12 saat eklemek gün anahtarını güvenle verir
    const series = Array.from({ length: 7 }, (_, i) => {
      const day = istanbulDay.format(new Date(seriesStart.getTime() + i * DAY_MS + 12 * 3_600_000));
      return { day, matches: byDay.get(day) ?? 0 };
    });
    return {
      recentMatches: recent.map((m) => {
        const { latestAnalysis, favorites, ...listing } = m.listing;
        return {
          id: m.id,
          reason: m.reason,
          createdAt: m.createdAt.toISOString(),
          profile: m.searchProfile,
          listing: toListingCard(listing, latestAnalysis, favorites.length > 0),
        };
      }),
      profiles: { ...counts, max: lim.maxSearchProfiles },
      notifications: { today: notificationsToday, limit: lim.limits.maxNotificationsPerDay },
      series,
    };
  }
}
