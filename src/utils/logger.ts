// ---------------------------------------------------------------------------
// Structured Logger
// ---------------------------------------------------------------------------
// Replaces silent catch blocks with leveled, tagged logging.
// Writes to stderr so it doesn't interfere with REPL stdout.

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: LogLevel = (process.env.JARVIS_LOG_LEVEL as LogLevel) || 'warn';

const LEVEL_PREFIX: Record<LogLevel, string> = {
  debug: '\x1b[90m[DEBUG]\x1b[0m',
  info: '\x1b[36m[INFO]\x1b[0m',
  warn: '\x1b[33m[WARN]\x1b[0m',
  error: '\x1b[31m[ERROR]\x1b[0m',
};

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function formatMessage(level: LogLevel, tag: string, msg: string, err?: unknown): string {
  const prefix = LEVEL_PREFIX[level];
  const errStr = err instanceof Error ? ` — ${err.message}` : err ? ` — ${String(err)}` : '';
  return `${prefix} [${tag}] ${msg}${errStr}`;
}

/**
 * Create a tagged logger for a specific module/subsystem.
 */
export function createLogger(tag: string) {
  return {
    debug(msg: string, err?: unknown): void {
      if (shouldLog('debug')) console.error(formatMessage('debug', tag, msg, err));
    },
    info(msg: string, err?: unknown): void {
      if (shouldLog('info')) console.error(formatMessage('info', tag, msg, err));
    },
    warn(msg: string, err?: unknown): void {
      if (shouldLog('warn')) console.error(formatMessage('warn', tag, msg, err));
    },
    error(msg: string, err?: unknown): void {
      if (shouldLog('error')) console.error(formatMessage('error', tag, msg, err));
    },
  };
}

/**
 * Set the global minimum log level at runtime.
 */
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/**
 * Get the current log level.
 */
export function getLogLevel(): LogLevel {
  return minLevel;
}
