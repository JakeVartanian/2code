/**
 * Layout engine for the Memory Brain — positions 6 category nodes
 * in a hexagonal arrangement with a central stats hub.
 */

import { CATEGORIES, NODE_WIDTH, NODE_HEIGHT, PADDING, type Category } from "./constants"

export interface NodePosition {
  x: number
  y: number
}

/**
 * Compute hexagonal layout positions for category nodes.
 * Places nodes in a hex ring around the center of the container.
 */
export function computeBrainLayout(
  containerWidth: number,
  containerHeight: number,
): Map<Category | "center", NodePosition> {
  const positions = new Map<Category | "center", NodePosition>()

  const cx = containerWidth / 2
  const cy = containerHeight / 2

  // Center hub
  positions.set("center", { x: cx, y: cy })

  // Hex ring radius — adapts to container size
  const maxRadiusX = (containerWidth - NODE_WIDTH - PADDING * 2) / 2
  const maxRadiusY = (containerHeight - NODE_HEIGHT - PADDING * 2) / 2
  const radius = Math.min(maxRadiusX, maxRadiusY, 200)

  // Start from top (-90deg), go clockwise
  const startAngle = -Math.PI / 2

  for (let i = 0; i < CATEGORIES.length; i++) {
    const angle = startAngle + (i * 2 * Math.PI) / CATEGORIES.length
    const x = cx + radius * Math.cos(angle)
    const y = cy + radius * Math.sin(angle)

    positions.set(CATEGORIES[i], {
      x: Math.max(PADDING, Math.min(containerWidth - NODE_WIDTH - PADDING, x - NODE_WIDTH / 2)),
      y: Math.max(PADDING, Math.min(containerHeight - NODE_HEIGHT - PADDING, y - NODE_HEIGHT / 2)),
    })
  }

  return positions
}
