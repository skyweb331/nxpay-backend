import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pug from 'pug';
import { Service } from 'typedi';

import { config, isProduction } from '#src/config.js';

const TEMPLATE_DIR = fileURLToPath(new URL('../templates/email/', import.meta.url));

/**
 * Mailgun sets the Content-ID of an `inline` attachment to its filename, so the
 * HTML `cid:` and the FileName must match.
 */
const LOGO_FILENAME = 'nxpay-logo.png';
let logoPng: Promise<Buffer> | undefined;
const loadLogo = () => (logoPng ??= fs.readFile(path.join(TEMPLATE_DIR, 'assets/logo.png')));

export type EmailTemplate =
  | 'verify-email'
  | 'customer-approved'
  | 'password-reset'
  | 'staff-invite'
  | 'otp'
  | 'wallet-alert'
  | 'security-alert'
  | 'wallet-key-exported'
  | 'kyc-approved'
  | 'kyc-rejected'
  | 'deposit-received'
  | 'payout-completed'
  | 'payout-failed'
  | 'fee-schedule-published'
  | 'support-reply'
  | 'ops-alert';

export interface SendEmailOptions {
  to: string;
  subject: string;
  template: EmailTemplate;
  locals?: Record<string, unknown>;
}

const htmlToText = (html: string) =>
  html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|li)>/gi, '\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

/**
 * Transactional email.
 * - `MAIL_TRANSPORT=mailgun`: Mailgun Messages API.
 * - `MAIL_TRANSPORT=log`: prints the email and writes the HTML to `tmp/mail/` (local only).
 */
@Service()
export class MailerService {
  private readonly templates = new Map<string, pug.compileTemplate>();

  assertConfigured() {
    if (!isProduction) return;
    if (config.MAIL_TRANSPORT !== 'mailgun') {
      throw new Error('MAIL_TRANSPORT=log is not allowed in production');
    }
    if (!config.MAILGUN_API_KEY || !config.MAILGUN_DOMAIN) {
      throw new Error('MAILGUN_API_KEY and MAILGUN_DOMAIN are required in production');
    }
  }

  private render(template: EmailTemplate, locals: Record<string, unknown>) {
    let fn = this.templates.get(template);
    if (!fn) {
      fn = pug.compileFile(path.join(TEMPLATE_DIR, `${template}.pug`), { basedir: TEMPLATE_DIR });
      if (isProduction) this.templates.set(template, fn);
    }
    return fn({
      appName: 'NxPay',
      frontendUrl: config.FRONTEND_URL,
      adminUrl: config.ADMIN_URL,
      logoCid: LOGO_FILENAME,
      year: new Date().getUTCFullYear(),
      ...locals,
    });
  }

  async send({ to, subject, template, locals = {} }: SendEmailOptions): Promise<void> {
    const html = this.render(template, { subject, ...locals });
    const text = htmlToText(html);
    const logo = await loadLogo();

    if (config.MAIL_TRANSPORT === 'log') {
      const dir = path.resolve(process.cwd(), 'tmp/mail');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-${template}.html`);
      await fs.writeFile(
        file,
        html.replaceAll(`cid:${LOGO_FILENAME}`, `data:image/png;base64,${logo.toString('base64')}`)
      );
      console.log(
        `[mail] to=${to} subject="${subject}" template=${template} file=${path.relative(process.cwd(), file)}\n${text}\n`
      );
      return;
    }

    const form = new FormData();
    form.set('from', config.MAIL_FROM);
    form.set('to', to);
    form.set('subject', subject);
    form.set('text', text);
    form.set('html', html);
    form.append('inline', new Blob([logo], { type: 'image/png' }), LOGO_FILENAME);

    const url = `${config.MAILGUN_API_URL.replace(/\/$/, '')}/v3/${config.MAILGUN_DOMAIN}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`api:${config.MAILGUN_API_KEY}`).toString('base64')}`,
      },
      body: form,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Mailgun ${response.status}: ${body.slice(0, 500) || response.statusText}`);
    }
  }

  /** Fire-and-forget variant: email failures never fail the caller. */
  sendSafe(options: SendEmailOptions) {
    this.send(options).catch((error) => {
      console.error(`[mail] failed to send ${options.template} to ${options.to}`, error);
    });
  }

  opsAlert(subject: string, lines: string[]) {
    this.sendSafe({
      to: config.OPS_ALERT_EMAIL,
      subject: `[NxPay ops] ${subject}`,
      template: 'ops-alert',
      locals: { lines },
    });
  }
}
