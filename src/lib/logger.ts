export type Logger = {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
};

function format(level: string, message: string, extra?: Record<string, unknown>): string {
  const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";
  return `[${new Date().toISOString()}] ${level} ${message}${suffix}`;
}

export function createLogger(sink: Pick<Console, "log" | "warn" | "error"> = console): Logger {
  return {
    info(message, extra) {
      sink.log(format("info", message, extra));
    },
    warn(message, extra) {
      sink.warn(format("warn", message, extra));
    },
    error(message, extra) {
      sink.error(format("error", message, extra));
    },
  };
}
