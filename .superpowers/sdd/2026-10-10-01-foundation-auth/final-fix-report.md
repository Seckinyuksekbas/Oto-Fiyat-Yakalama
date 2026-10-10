# Final fix report (Plan 01)

RED (before fixes, `pnpm --filter @oto/api test:e2e`): 5 failed / 55 passed (60) -- new tests: last-super-admin delete, PATCH after delete, PII cleanup, change-password invalidates reset tokens, second reset invalidates first (+ emailVerifiedAt).
GREEN (after): `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e` all pass: unit api 36, shared 11; e2e api 60, db 5.

1. Last SUPER_ADMIN: MeRepository.findRole/hasOtherActiveSuperAdmin; MeService.deleteAccount throws AppError(INVALID_OPERATION,409). Test in me.e2e.
2. updateName: updateMany with status != DELETED, null -> 401, then re-read. Test in me.e2e.
3. anonymizeAndDelete deletes Session/EmailVerificationToken/PasswordResetToken/TelegramLinkToken; login_locked audit no longer has `after` (existing test did not assert on it).
4. Reset + change-password mark unused reset tokens used; reset sets emailVerifiedAt if null. Tests in email-flows and me e2e.
5. src/modules/auth/links.ts buildLink (URL-based) + links.spec.ts; used by both mail services.
6/7. docs/architecture.md and roadmap updated.
