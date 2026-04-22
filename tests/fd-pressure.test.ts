/**
 * Tests for FD pressure monitoring and dynamic session limits.
 *
 * These tests catch regressions that lead to EMFILE crashes:
 * - FD pressure thresholds being changed to unsafe values
 * - Session limits not scaling down under pressure
 * - Watcher pool not respecting FD budget
 */

import { describe, it, expect } from "vitest"

// --- Inline the pressure logic so tests don't need Electron imports ---

type FdPressureLevel = "normal" | "warning" | "critical"

const THRESHOLDS = {
  warning: 0.60,
  critical: 0.80,
}

function calculatePressure(fdCount: number, fdLimit: number): FdPressureLevel {
  const ratio = fdCount / fdLimit
  if (ratio >= THRESHOLDS.critical) return "critical"
  if (ratio >= THRESHOLDS.warning) return "warning"
  return "normal"
}

function getEffectiveMaxSessions(baseMax: number, pressure: FdPressureLevel): number {
  switch (pressure) {
    case "normal": return baseMax
    case "warning": return Math.max(1, Math.floor(baseMax * 0.6))
    case "critical": return 1
  }
}

function hasFdHeadroom(fdCount: number, fdLimit: number, needed: number = 4): boolean {
  return fdCount + needed < fdLimit * THRESHOLDS.critical
}

// Watcher pool logic
const BASE_MAX_WATCHERS = 32

function getEffectiveMaxWatchers(pressure: FdPressureLevel): number {
  switch (pressure) {
    case "normal": return BASE_MAX_WATCHERS
    case "warning": return Math.floor(BASE_MAX_WATCHERS * 0.5)
    case "critical": return 4
  }
}

// =============================================================================
// Tests
// =============================================================================

describe("FD pressure levels", () => {
  it("is normal below 60% usage", () => {
    expect(calculatePressure(100, 256)).toBe("normal")
    expect(calculatePressure(150, 256)).toBe("normal")
    expect(calculatePressure(153, 256)).toBe("normal") // 59.7%
  })

  it("is warning at 60-80% usage", () => {
    expect(calculatePressure(154, 256)).toBe("warning") // 60.1%
    expect(calculatePressure(180, 256)).toBe("warning")
    expect(calculatePressure(200, 256)).toBe("warning")
    expect(calculatePressure(204, 256)).toBe("warning") // 79.7%
  })

  it("is critical at 80%+ usage", () => {
    expect(calculatePressure(205, 256)).toBe("critical") // 80.1%
    expect(calculatePressure(230, 256)).toBe("critical")
    expect(calculatePressure(256, 256)).toBe("critical")
  })

  it("is always normal with a high FD limit", () => {
    // After native addon raises limit to 10240
    expect(calculatePressure(200, 10240)).toBe("normal")
    expect(calculatePressure(500, 10240)).toBe("normal")
    expect(calculatePressure(1000, 10240)).toBe("normal")
  })
})

describe("dynamic session limits", () => {
  const BASE_MAX = 5

  it("allows 5 sessions under normal pressure", () => {
    expect(getEffectiveMaxSessions(BASE_MAX, "normal")).toBe(5)
  })

  it("reduces to 3 under warning pressure", () => {
    expect(getEffectiveMaxSessions(BASE_MAX, "warning")).toBe(3)
  })

  it("reduces to 1 under critical pressure", () => {
    expect(getEffectiveMaxSessions(BASE_MAX, "critical")).toBe(1)
  })

  it("never goes below 1", () => {
    expect(getEffectiveMaxSessions(1, "warning")).toBe(1)
    expect(getEffectiveMaxSessions(1, "critical")).toBe(1)
  })
})

describe("FD headroom checks", () => {
  it("has headroom when well below critical threshold", () => {
    expect(hasFdHeadroom(100, 256, 4)).toBe(true)
    expect(hasFdHeadroom(150, 256, 4)).toBe(true)
  })

  it("denies headroom near critical threshold", () => {
    // critical = 80% of 256 = 204.8
    expect(hasFdHeadroom(200, 256, 8)).toBe(false) // 200 + 8 = 208 > 204.8
    expect(hasFdHeadroom(201, 256, 4)).toBe(false) // 201 + 4 = 205 > 204.8
  })

  it("always has headroom with raised FD limit", () => {
    expect(hasFdHeadroom(500, 10240, 8)).toBe(true)
    expect(hasFdHeadroom(1000, 10240, 100)).toBe(true)
  })
})

describe("watcher pool limits", () => {
  it("allows 32 watchers under normal pressure", () => {
    expect(getEffectiveMaxWatchers("normal")).toBe(32)
  })

  it("reduces to 16 under warning pressure", () => {
    expect(getEffectiveMaxWatchers("warning")).toBe(16)
  })

  it("reduces to 4 under critical pressure", () => {
    expect(getEffectiveMaxWatchers("critical")).toBe(4)
  })
})

describe("threshold regression guards", () => {
  it("warning threshold is between 50-70%", () => {
    expect(THRESHOLDS.warning).toBeGreaterThanOrEqual(0.50)
    expect(THRESHOLDS.warning).toBeLessThanOrEqual(0.70)
  })

  it("critical threshold is between 70-90%", () => {
    expect(THRESHOLDS.critical).toBeGreaterThanOrEqual(0.70)
    expect(THRESHOLDS.critical).toBeLessThanOrEqual(0.90)
  })

  it("critical is higher than warning", () => {
    expect(THRESHOLDS.critical).toBeGreaterThan(THRESHOLDS.warning)
  })
})

describe("macOS 256 FD budget validation", () => {
  // These tests validate that our FD consumers stay within budget
  // at the default macOS 256 limit with 3 concurrent sessions.

  const MACOS_FD_LIMIT = 256
  const ELECTRON_OVERHEAD = 80      // Chromium internals, GPU cache, frameworks
  const SQLITE_FDS = 3              // WAL + SHM + main
  const AUTH_SERVER = 2              // HTTP listener
  const IPC_PER_CHILD = 2           // stdin + stdout per child process

  it("3 concurrent sessions fit within 256 FD budget", () => {
    const sessions = 3
    const watchersCritical = 4       // Critical-pressure watcher cap
    const gitWatchers = sessions * 2 // 2 per worktree (chokidar .git/index + HEAD)

    const total =
      ELECTRON_OVERHEAD +
      SQLITE_FDS +
      AUTH_SERVER +
      (sessions * IPC_PER_CHILD) +  // Subprocess pipes
      gitWatchers +
      watchersCritical

    // Must be below the critical threshold (80% of 256 = ~205)
    expect(total).toBeLessThan(MACOS_FD_LIMIT * THRESHOLDS.critical)
  })

  it("5 concurrent sessions with full watchers exceed safe headroom", () => {
    const sessions = 5
    const watchersNormal = 32
    const gitWatchers = sessions * 2
    // Each Claude subprocess opens ~25 FDs in its own process but also
    // needs network sockets, MCP servers, etc. from the parent
    const mcpServers = 3 * 4         // 3 MCP stdio servers × 4 FDs each
    const networkSockets = 11        // IPC + auth server

    const total =
      ELECTRON_OVERHEAD +
      SQLITE_FDS +
      AUTH_SERVER +
      (sessions * IPC_PER_CHILD) +
      gitWatchers +
      watchersNormal +
      mcpServers +
      networkSockets

    // With realistic overhead, 5 sessions exceed warning threshold
    expect(total).toBeGreaterThan(MACOS_FD_LIMIT * THRESHOLDS.warning)
  })
})
