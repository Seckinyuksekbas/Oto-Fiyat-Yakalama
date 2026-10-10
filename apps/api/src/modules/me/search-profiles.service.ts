import { Injectable } from '@nestjs/common';
import {
  createSearchProfileSchema,
  ErrorCode,
  withProfileDefaults,
  type CreateSearchProfileInput,
  type NormalizedProfile,
  type UpdateSearchProfileInput,
} from '@oto/shared';
import type { SearchProfile } from '@oto/db';
import { AppError, Errors } from '../../common/errors/app-error';
import { LimitsService, type UserLimits } from './limits.service';
import { toSearchProfileView, type SearchProfileView } from './search-profile.view';
import { SearchProfilesRepository } from './search-profiles.repository';

function toInput(p: SearchProfile): CreateSearchProfileInput {
  return {
    name: p.name, make: p.make, model: p.model, yearMin: p.yearMin, yearMax: p.yearMax,
    priceMin: p.priceMin?.toString() ?? null, priceMax: p.priceMax?.toString() ?? null, kmMax: p.kmMax,
    fuels: p.fuels, transmissions: p.transmissions, cities: p.cities, minDiscountPct: Number(p.minDiscountPct),
    minConfidence: p.minConfidence === 'INSUFFICIENT' ? 'LOW' : p.minConfidence, excludeDamaged: p.excludeDamaged,
    notifyOnPriceDrop: p.notifyOnPriceDrop, priceDropPct: Number(p.priceDropPct), notifyOnRelist: p.notifyOnRelist,
    channels: p.channels.filter((c): c is 'IN_APP' | 'TELEGRAM' => c !== 'EMAIL'),
  };
}

@Injectable()
export class SearchProfilesService {
  constructor(
    private readonly repo: SearchProfilesRepository,
    private readonly limits: LimitsService,
  ) {}

  async list(userId: string): Promise<{ items: SearchProfileView[] }> {
    return { items: (await this.repo.list(userId)).map(toSearchProfileView) };
  }

  async get(userId: string, id: string): Promise<SearchProfileView> {
    const p = await this.repo.find(userId, id);
    if (!p) throw Errors.notFound();
    return toSearchProfileView(p);
  }

  async create(userId: string, input: CreateSearchProfileInput): Promise<SearchProfileView> {
    const lim = await this.limits.forUser(userId);
    const p = withProfileDefaults(input);
    this.assertChannels(p, lim);
    const created = await this.repo.createWithinLimit(userId, p, lim.maxSearchProfiles);
    if (!created) throw this.limitError(lim);
    return toSearchProfileView(created);
  }

  async update(userId: string, id: string, patch: UpdateSearchProfileInput): Promise<SearchProfileView> {
    const existing = await this.repo.find(userId, id);
    if (!existing) throw Errors.notFound();
    const merged = createSearchProfileSchema.safeParse({ ...toInput(existing), ...patch });
    if (!merged.success) {
      throw Errors.validation(merged.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    const p = withProfileDefaults(merged.data);
    this.assertChannels(p, await this.limits.forUser(userId));
    const updated = await this.repo.update(userId, id, p);
    if (!updated) throw Errors.notFound();
    return toSearchProfileView(updated);
  }

  async pause(userId: string, id: string): Promise<SearchProfileView> {
    const p = await this.repo.setStatus(userId, id, 'PAUSED');
    if (!p) throw Errors.notFound();
    return toSearchProfileView(p);
  }

  async resume(userId: string, id: string): Promise<SearchProfileView> {
    const lim = await this.limits.forUser(userId);
    const r = await this.repo.resumeWithinLimit(userId, id, lim.maxSearchProfiles);
    if (r === null) throw Errors.notFound();
    if (r === 'LIMIT') throw this.limitError(lim);
    return toSearchProfileView(r);
  }

  async remove(userId: string, id: string): Promise<void> {
    if (!(await this.repo.delete(userId, id))) throw Errors.notFound();
  }

  private assertChannels(p: NormalizedProfile, lim: UserLimits): void {
    const missing = p.channels.find((c) => !lim.limits.channels.includes(c));
    if (missing) throw new AppError(ErrorCode.LIMIT_REACHED, 403, 'Planınız bu bildirim kanalını içermiyor', { channel: missing });
  }

  private limitError(lim: UserLimits): AppError {
    return new AppError(
      ErrorCode.LIMIT_REACHED,
      403,
      lim.emailVerified ? 'Planınızın arama profili sınırına ulaştınız' : 'E-postanızı doğrulayana kadar yalnızca 1 arama profili oluşturabilirsiniz',
      { limit: lim.maxSearchProfiles, reason: lim.emailVerified ? 'PLAN' : 'EMAIL_NOT_VERIFIED' },
    );
  }
}
