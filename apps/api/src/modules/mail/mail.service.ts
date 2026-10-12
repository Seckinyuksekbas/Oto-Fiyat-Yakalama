import { Inject, Injectable } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

@Injectable()
export class MailService {
  /** Yalnızca MAIL_TRANSPORT=json (test) modunda doldurulur. */
  readonly outbox: OutgoingMail[] = [];
  private readonly transporter: Transporter;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.transporter =
      env.MAIL_TRANSPORT === 'json'
        ? createTransport({ jsonTransport: true })
        : createTransport({
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            secure: env.SMTP_SECURE,
            requireTLS: env.SMTP_REQUIRE_TLS,
            auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
          });
  }

  async send(mail: OutgoingMail): Promise<void> {
    if (this.env.MAIL_TRANSPORT === 'json') this.outbox.push(mail);
    await this.transporter.sendMail({ from: this.env.SMTP_FROM, ...mail });
  }
}
