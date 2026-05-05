import { logger } from '../api/middleware/logger.js';

export interface NotificationPayload {
  type: 'PENDING_APPROVAL' | 'TRANSACTION_CONFIRMED' | 'TRANSACTION_FAILED' | 'POLICY_VIOLATION';
  agentId: string;
  agentName: string;
  transactionId?: string;
  message: string;
  metadata?: any;
}

// ─── Emoji + label helpers ────────────────────────────────────────────────────

const TYPE_EMOJI: Record<NotificationPayload['type'], string> = {
  PENDING_APPROVAL:      '🚨',
  TRANSACTION_CONFIRMED: '✅',
  TRANSACTION_FAILED:    '❌',
  POLICY_VIOLATION:      '⛔',
};

/**
 * Escape user-controlled text for Telegram HTML parse mode.
 *
 * We use HTML rather than legacy Markdown because Markdown silently corrupts on
 * any unmatched `_`, `*`, or `` ` `` in dynamic content (e.g. an error message
 * containing `eth_estimateGas` or contract addresses). HTML mode only requires
 * escaping three characters and never silently swallows formatting.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTelegramHtml(payload: NotificationPayload): string {
  const { type, agentName, message, transactionId } = payload;
  const emoji = TYPE_EMOJI[type];
  const lines = [
    `${emoji} <b>${escapeHtml(type)}</b>`,
    `Agent: ${escapeHtml(agentName)}`,
    escapeHtml(message),
  ];
  if (transactionId) lines.push(`Tx: <code>${escapeHtml(transactionId)}</code>`);
  return lines.join('\n');
}

// ─── Adapters ─────────────────────────────────────────────────────────────────

/**
 * Throws on non-2xx responses so the caller's `.catch` fires and produces a
 * loud `Failed to send …` log line. Without this guard, a 4xx silently
 * resolves the fetch and the operator never learns delivery broke — which is
 * exactly how the empty-env-var Telegram outage in #84 follow-up went
 * undetected for hours.
 */
async function fetchAndAssertOk(
  url: string,
  init: RequestInit,
  channel: string,
): Promise<void> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let body = '';
    try {
      body = (await res.text()).slice(0, 500);
    } catch {
      // If we can't even read the body, the status alone is enough signal.
    }
    throw new Error(
      `${channel} delivery failed: HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`,
    );
  }
}

async function sendGenericWebhook(url: string, payload: NotificationPayload): Promise<void> {
  await fetchAndAssertOk(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    'generic webhook',
  );
}

async function sendDiscord(webhookUrl: string, payload: NotificationPayload): Promise<void> {
  const { type, agentName, message, transactionId } = payload;
  const emoji = TYPE_EMOJI[type];
  const fields = [
    { name: 'Agent', value: agentName, inline: true },
    { name: 'Event', value: type, inline: true },
  ];
  if (transactionId) fields.push({ name: 'Transaction', value: transactionId, inline: false });

  await fetchAndAssertOk(
    webhookUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: `${emoji} ${type}`,
          description: message,
          color: type === 'PENDING_APPROVAL' ? 0xF59E0B
            : type === 'TRANSACTION_CONFIRMED' ? 0x22C55E
            : type === 'POLICY_VIOLATION' ? 0xEF4444
            : 0x6B7280,
          fields,
          timestamp: new Date().toISOString(),
        }],
      }),
    },
    'Discord',
  );
}

async function sendTelegram(
  botToken: string,
  chatId: string,
  payload: NotificationPayload,
): Promise<void> {
  const text = formatTelegramHtml(payload);
  await fetchAndAssertOk(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      }),
    },
    'Telegram',
  );
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class NotificationService {
  async notify(payload: NotificationPayload): Promise<void> {
    const { type, agentName, message, transactionId } = payload;

    // 1. Internal log
    logger.info({ ...payload }, `[Notification] ${type}: ${message}`);

    // 2. Console alert for PENDING_APPROVAL (dev convenience)
    if (type === 'PENDING_APPROVAL') {
      console.log('\n' + '='.repeat(50));
      console.log('🚨 ACTION REQUIRED: TRANSACTION AWAITING APPROVAL');
      console.log(`Agent:   ${agentName}`);
      console.log(`Tx ID:   ${transactionId}`);
      console.log(`Message: ${message}`);
      console.log(`URL:     http://localhost:3001/transactions/${transactionId}`);
      console.log('='.repeat(50) + '\n');
    }

    // 3. External channels — all fire in parallel, failures are non-fatal but
    // ALWAYS logged. Channels with no config (env var unset) are visibly
    // skipped at debug level so an operator can spot a misconfigured machine
    // (env var dropped during a rolling restart, secret never propagated, etc.)
    // by the absence of dispatch logs after a `[Notification]` event.
    const dispatches: Promise<void>[] = [];
    const enabledChannels: string[] = [];
    const skippedChannels: string[] = [];

    const webhookUrl = process.env['OPERATOR_NOTIFICATION_WEBHOOK'];
    if (webhookUrl) {
      enabledChannels.push('webhook');
      dispatches.push(
        sendGenericWebhook(webhookUrl, payload).catch((err) =>
          logger.warn(
            { err: (err as Error)?.message ?? String(err), channel: 'webhook', type },
            'Failed to send generic webhook notification',
          ),
        ),
      );
    } else {
      skippedChannels.push('webhook');
    }

    const discordUrl = process.env['OPERATOR_DISCORD_WEBHOOK'];
    if (discordUrl) {
      enabledChannels.push('discord');
      dispatches.push(
        sendDiscord(discordUrl, payload).catch((err) =>
          logger.warn(
            { err: (err as Error)?.message ?? String(err), channel: 'discord', type },
            'Failed to send Discord notification',
          ),
        ),
      );
    } else {
      skippedChannels.push('discord');
    }

    const telegramToken = process.env['OPERATOR_TELEGRAM_BOT_TOKEN'];
    const telegramChatId = process.env['OPERATOR_TELEGRAM_CHAT_ID'];
    if (telegramToken && telegramChatId) {
      enabledChannels.push('telegram');
      dispatches.push(
        sendTelegram(telegramToken, telegramChatId, payload).catch((err) =>
          logger.warn(
            { err: (err as Error)?.message ?? String(err), channel: 'telegram', type },
            'Failed to send Telegram notification',
          ),
        ),
      );
    } else {
      skippedChannels.push('telegram');
    }

    logger.debug(
      { type, enabled: enabledChannels, skipped: skippedChannels },
      'Notification channels resolved',
    );

    await Promise.all(dispatches);
  }
}

export const notificationService = new NotificationService();
