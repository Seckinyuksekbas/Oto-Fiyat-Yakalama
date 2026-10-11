import { Body, Controller, Delete, Get, HttpCode, Param, Put, Query } from '@nestjs/common';
import {
  favoritesQuerySchema,
  putFavoriteSchema,
  type FavoriteItem,
  type FavoritesQuery,
  type PutFavorite,
} from '@oto/shared';
import { CurrentUser } from '../../common/decorators/current-user';
import { Errors } from '../../common/errors/app-error';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth-user';
import { FavoritesRepository, type FavoriteRow } from './favorites.repository';
import { toListingCard } from './listing-card.view';

function parseListingId(raw: string): number {
  if (!/^\d{1,10}$/.test(raw)) throw Errors.notFound();
  const id = Number(raw);
  if (id < 1 || id > 2147483647) throw Errors.notFound();
  return id;
}

function toItem(f: FavoriteRow): FavoriteItem {
  const { latestAnalysis, ...listing } = f.listing;
  return { listing: toListingCard(listing, latestAnalysis, true), note: f.note, createdAt: f.createdAt.toISOString() };
}

@Controller('me/favorites')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesRepository) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query(new ZodPipe(favoritesQuerySchema)) q: FavoritesQuery) {
    const rows = await this.favorites.list(user.id, { cursor: q.cursor, limit: q.limit });
    const page = rows.slice(0, q.limit);
    return {
      items: page.map(toItem),
      nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
    };
  }

  @Put(':listingId')
  @HttpCode(200)
  async put(
    @CurrentUser() user: AuthUser,
    @Param('listingId') raw: string,
    @Body(new ZodPipe(putFavoriteSchema)) body: PutFavorite,
  ): Promise<FavoriteItem> {
    const listingId = parseListingId(raw);
    if (!(await this.favorites.listingExists(listingId))) throw Errors.notFound();
    const row = await this.favorites.upsert(user.id, listingId, body.note);
    if (!row) throw Errors.notFound();
    return toItem(row);
  }

  @Delete(':listingId')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('listingId') raw: string): Promise<void> {
    if (!(await this.favorites.remove(user.id, parseListingId(raw)))) throw Errors.notFound();
  }
}
