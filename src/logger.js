import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'privateKey',
      '*.privateKey',
      'token',
      '*.token',
      'headers.x-zenko-session',
      'signature',
      '*.signature',
      'secretKey',
      '*.secretKey',
      'apiKey',
      '*.apiKey',
    ],
    censor: '[redacted]',
  },
  transport: process.stdout.isTTY
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});
