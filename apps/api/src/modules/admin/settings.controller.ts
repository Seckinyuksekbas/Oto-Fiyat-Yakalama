import { Body, Controller, Get, Patch } from '@nestjs/common';
import { adminSettingsPatchSchema, type AdminSettingsPatch } from '@oto/shared';
import { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { Audited } from '../../common/audit/audited.decorator';
import { Roles } from '../../common/decorators/roles';
import { ZodPipe } from '../../common/zod.pipe';
import { AdminSettingsService } from './settings.service';

@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(private readonly settings: AdminSettingsService) {}

  @Get()
  list() {
    return this.settings.list();
  }

  @Roles('SUPER_ADMIN')
  @Patch()
  @Audited('settings.update')
  update(@AuditCtx() ctx: AuditCtx, @Body(new ZodPipe(adminSettingsPatchSchema)) body: AdminSettingsPatch) {
    return this.settings.update(ctx, body.key, body.value);
  }
}
