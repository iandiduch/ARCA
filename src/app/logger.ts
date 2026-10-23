import pino, { type LoggerOptions } from 'pino';
import { loadConfig } from './config.js';

const config = loadConfig();

const options: LoggerOptions = {
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      '*.token',
      '*.sign',
      '*.privateKey',
      '*.password',
      '*.claveFiscal',
      'body.token',
      'body.sign',
      'body.privateKey',
      'body.password'
    ],
    censor: '[REDACTED]'
  }
};

if (config.NODE_ENV === 'development') {
  options.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  };
}

export const logger = pino(options);
