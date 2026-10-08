import { pino } from 'pino';
import { env } from '../../config/env.js';
import { requestSerializer } from './log-serializers.js';

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  // S6: a logged request never carries a credential-like query parameter.
  serializers: { req: requestSerializer },
  ...(env.NODE_ENV !== 'production'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
  redact: {
    // Never log sensitive fields
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'body.privateKey',
      'body.apiKey',
      '*.privateKey',
      '*.apiKey',
      '*.apiKeyHash',
    ],
    remove: true,
  },
});
