import log from "electron-log"

// File transport: 5MB max, rotates to main.old.log (~10MB on disk)
log.transports.file.maxSize = 5 * 1024 * 1024

// Override console methods so all existing log calls persist to disk
// Console transport stays enabled — logs still print to terminal in dev
Object.assign(console, {
  log: log.log,
  warn: log.warn,
  error: log.error,
  info: log.info,
  debug: log.debug,
})
