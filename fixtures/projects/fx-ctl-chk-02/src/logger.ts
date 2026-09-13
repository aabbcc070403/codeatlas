export interface LogEntry {
  level: string
  message: string
}

export interface Logger {
  info(message: string): void
  error(message: string): void
}

export function createLogger(prefix: string): Logger {
  const buffer: LogEntry[] = []
  return {
    info: (message) => {
      buffer.push({ level: 'info', message: prefix + ' ' + message })
    },
    error: (message) => {
      buffer.push({ level: 'error', message: prefix + ' ' + message })
    },
  }
}

export function formatEntries(entries: LogEntry[]): string[] {
  return entries.map((entry) => '[' + entry.level + '] ' + entry.message)
}