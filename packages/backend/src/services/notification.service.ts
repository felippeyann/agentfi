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

function formatText(payload: NotificationPayload): string {
  const { type, agentName, message, transactionId } = payload;
  const emoji = TYPE_EMOJI[type];
  const lines = [
    `${emoji} *${type}*`,
    `Agent: ${agentName}`,
    message,
  ];
  if (transactionId) lines.push(`Tx: \`${transactionId}\``);
  return lines.join('\n');
}

// ─── Adapters ─────────────────────────────────────────────────────────────────

async function sendGenericWebhook(url: string, payload: NotificationPayload): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function sendDiscord(webhookUrl: string, payload: NotificationPayload): Promise<void> {
  const { type, agentName, message, transactionId } = payload;
  const emoji = TYPE_EMOJI[type];
  const fields = [
    { name: 'Agent', value: agentName, inline: true },
    { name: 'Event', value: type, inline: true },
  ];
  if (transactionId) fields.push({ name: 'Transaction', value: transactionId, inline: false });

  await fetch(webhookUrl, {
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
  });
}

async function sendTelegram(
  botToken: string,
  chatId: string,
  payload: NotificationPayload,
): Promise<void> {
  const text = formatText(payload);
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    }),
  });
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

    // 3. External channels — all fire in parallel, failures are non-fatal
    const dispatches: Promise<void>[] = [];

    const webhookUrl = process.env['OPERATOR_NOTIFICATION_WEBHOOK'];
    if (webhookUrl) {
      dispatches.push(
        sendGenericWebhook(webhookUrl, payload).catch((err) =>
          logger.warn({ err }, 'Failed to send generic webhook notification'),
        ),
      );
    }

    const discordUrl = process.env['OPERATOR_DISCORD_WEBHOOK'];
    if (discordUrl) {
      dispatches.push(
        sendDiscord(discordUrl, payload).catch((err) =>
          logger.warn({ err }, 'Failed to send Discord notification'),
        ),
      );
    }

    const telegramToken = process.env['OPERATOR_TELEGRAM_BOT_TOKEN'];
    const telegramChatId = process.env['OPERATOR_TELEGRAM_CHAT_ID'];
    if (telegramToken && telegramChatId) {
      dispatches.push(
        sendTelegram(telegramToken, telegramChatId, payload).catch((err) =>
          logger.warn({ err }, 'Failed to send Telegram notification'),
        ),
      );
    }

    await Promise.all(dispatches);
  }
}

export const notificationService = new NotificationService();
