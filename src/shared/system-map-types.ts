/**
 * System Map types — shared between main process and renderer.
 * Defines the structured zone data produced by AI synthesis
 * of architecture memories.
 */

export interface SystemZoneConnection {
  targetZoneId: string
  protocol: string      // "tRPC", "OAuth", "SDK", "Drizzle", "IPC", "REST", etc.
  direction: "outgoing" | "bidirectional"
}

export type PositionHint =
  | "top"
  | "top-left"
  | "top-right"
  | "center"
  | "left"
  | "right"
  | "bottom-left"
  | "bottom-right"
  | "bottom"

export interface SystemZone {
  id: string
  name: string               // "Frontend", "Backend API", etc.
  icon: string               // lucide icon name: "monitor", "server", etc.
  description: string        // 1-2 line tech stack summary
  linkedFiles: string[]      // file paths associated with this zone
  connections: SystemZoneConnection[]
  positionHint: PositionHint
}

/** Valid lucide icon names for zones (constrained set for the synthesis prompt) */
export const ZONE_ICON_NAMES = [
  "monitor",        // Frontend / UI
  "server",         // Backend / API
  "database",       // Database
  "shield",         // Auth / Security
  "brain",          // AI / ML
  "package",        // Build / Packaging
  "globe",          // Web / Networking
  "key",            // Credentials / Keys
  "cpu",            // Processing / Workers
  "hard-drive",     // Storage
  "cloud",          // Cloud / Infrastructure
  "code",           // Smart Contracts / Code
  "git-branch",     // Version Control
  "layout",         // Layout / Design System
  "terminal",       // CLI / Scripts
  "file-code",      // Config / Files
  "workflow",       // Orchestration / Pipeline
  "zap",            // Events / Real-time
  "settings",       // Configuration
  "layers",         // Middleware / Stack
] as const

export const POSITION_HINTS: PositionHint[] = [
  "top", "top-left", "top-right",
  "center", "left", "right",
  "bottom-left", "bottom-right", "bottom",
]
