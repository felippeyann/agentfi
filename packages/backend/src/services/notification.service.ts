import { logger } from '../api/middleware/logger.js';

export interface NotificationPayload {
  type: 'PENDING_APPROVAL' | 'TRANSACTION_CONFIRMED' | 'TRANSACTION_FAILED' | 'POLICY_VIOLATION';
  agentId: string;
  agentName: string;
  transactionId?: string;
  message: string;
  metadata?: any;
}

export class NotificationService {
  /**
   * Sends a notification to the operator.
   * Currently logs to console, but can be extended to Webhooks, Discord, Telegram, etc.
   */
  async notify(payload: NotificationPayload): Promise<void> {
    const { type, agentName, message, transactionId } = payload;
    
    // 1. Internal Log
    logger.info({ ...payload }, `[Notification] ${type}: ${message}`);

    // 2. Formatted Console Alert (for development/monitoring)
    if (type === 'PENDING_APPROVAL') {
      console.log('\n' + '='.repeat(50));
      console.log('🚨 ACTION REQUIRED: TRANSACTION AWAITING APPROVAL');
      console.log(`Agent:   ${agentName}`);
      console.log(`Tx ID:   ${transactionId}`);
      console.log(`Message: ${message}`);
      console.log(`URL:     http://localhost:3001/transactions/${transactionId}`);
      console.log('='.repeat(50) + '\n');
    }

    // Future: Add Webhook support here
    const webhookUrl = process.env['OPERATOR_NOTIFICATION_WEBHOOK'];
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        logger.warn({ err }, 'Failed to send notification webhook');
      }
    }
  }
}

export const notificationService = new NotificationService();
