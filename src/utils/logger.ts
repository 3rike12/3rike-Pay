import { config } from "@/config";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[config.logLevel as LogLevel];
}

function formatMsg(level: string, msg: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
  return `[${ts}] ${level.toUpperCase()} ${msg}${metaStr}`;
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => {
    if (shouldLog("debug")) console.log(formatMsg("debug", msg, meta));
  },
  info: (msg: string, meta?: Record<string, unknown>) => {
    if (shouldLog("info")) console.log(formatMsg("info", msg, meta));
  },
  warn: (msg: string, meta?: Record<string, unknown>) => {
    if (shouldLog("warn")) console.warn(formatMsg("warn", msg, meta));
  },
  error: (msg: string, meta?: Record<string, unknown>) => {
    if (shouldLog("error")) console.error(formatMsg("error", msg, meta));
  },
};
