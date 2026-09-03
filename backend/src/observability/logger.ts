import type { RequestContext } from '../types.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug: (message: string, data?: Record<string, unknown>) => void;
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
}

export function createLogger(minLevel: LogLevel, context: RequestContext): Logger {
  const shouldLog = (level: LogLevel) => LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];

  const write = (level: LogLevel, message: string, data?: Record<string, unknown>) => {
    if (!shouldLog(level)) return;
    const payload = {
      level,
      message,
      requestId: context.requestId,
      ts: new Date().toISOString(),
      ...data,
    };
    // Worker runtime handles JSON logs nicely in observability pipelines.
    console[level](JSON.stringify(payload));
  };

  return {
    debug: (message, data) => write('debug', message, data),
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
  };
}
