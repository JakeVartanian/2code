/**
 * Layout engine — positions zones in the container based on positionHints.
 * Pure function, no React dependency.
 */

import type { PositionHint } from "../../../../../../shared/system-map-types"

export const ZONE_WIDTH = 260
export const ZONE_HEIGHT = 160
const PADDING = 40

interface LayoutInput {
  id: string
  positionHint: PositionHint
}

interface LayoutResult {
  x: number
  y: number
}

/**
 * Map position hints to container regions.
 */
function hintToPosition(
  hint: PositionHint,
  containerW: number,
  containerH: number,
): { x: number; y: number } {
  const cx = containerW / 2 - ZONE_WIDTH / 2
  const cy = containerH / 2 - ZONE_HEIGHT / 2

  const positions: Record<PositionHint, { x: number; y: number }> = {
    "top":          { x: cx, y: PADDING },
    "top-left":     { x: PADDING, y: PADDING },
    "top-right":    { x: containerW - ZONE_WIDTH - PADDING, y: PADDING },
    "center":       { x: cx, y: cy },
    "left":         { x: PADDING, y: cy },
    "right":        { x: containerW - ZONE_WIDTH - PADDING, y: cy },
    "bottom-left":  { x: PADDING + 60, y: containerH - ZONE_HEIGHT - PADDING },
    "bottom-right": { x: containerW - ZONE_WIDTH - PADDING - 60, y: containerH - ZONE_HEIGHT - PADDING },
    "bottom":       { x: cx, y: containerH - ZONE_HEIGHT - PADDING },
  }

  return positions[hint] || positions.center
}

/**
 * Resolve overlapping zones by nudging them apart.
 */
function resolveOverlaps(
  positions: Map<string, LayoutResult>,
  iterations: number = 5,
): void {
  const ids = [...positions.keys()]
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = positions.get(ids[i])!
        const b = positions.get(ids[j])!

        const overlapX = (ZONE_WIDTH + 20) - Math.abs(a.x - b.x)
        const overlapY = (ZONE_HEIGHT + 20) - Math.abs(a.y - b.y)

        if (overlapX > 0 && overlapY > 0) {
          // Nudge apart along the axis with less overlap
          if (overlapX < overlapY) {
            const nudge = overlapX / 2 + 10
            if (a.x <= b.x) { a.x -= nudge; b.x += nudge }
            else { a.x += nudge; b.x -= nudge }
          } else {
            const nudge = overlapY / 2 + 10
            if (a.y <= b.y) { a.y -= nudge; b.y += nudge }
            else { a.y += nudge; b.y -= nudge }
          }
          moved = true
        }
      }
    }
    if (!moved) break
  }
}

/**
 * Compute zone positions from position hints and container size.
 */
export function computeLayout(
  zones: LayoutInput[],
  containerWidth: number,
  containerHeight: number,
): Map<string, LayoutResult> {
  const positions = new Map<string, LayoutResult>()

  for (const zone of zones) {
    const pos = hintToPosition(zone.positionHint, containerWidth, containerHeight)
    positions.set(zone.id, { ...pos })
  }

  // Resolve any overlapping zones
  resolveOverlaps(positions)

  // Clamp all positions within container bounds
  for (const pos of positions.values()) {
    pos.x = Math.max(PADDING, Math.min(containerWidth - ZONE_WIDTH - PADDING, pos.x))
    pos.y = Math.max(PADDING, Math.min(containerHeight - ZONE_HEIGHT - PADDING, pos.y))
  }

  return positions
}
