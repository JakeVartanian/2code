/**
 * CategoryConnections — SVG bezier curves between semantically
 * related memory categories, with protocol-style labels.
 */

import { memo, useMemo } from "react"
import { motion, AnimatePresence } from "motion/react"
import {
  CATEGORY_CONNECTIONS,
  CATEGORY_META,
  NODE_WIDTH,
  NODE_HEIGHT,
  type Category,
} from "./constants"
import type { NodePosition } from "./layout"

interface CategoryConnectionsProps {
  positions: Map<Category | "center", NodePosition>
  categoryCounts: Map<Category, number>
  width: number
  height: number
}

interface ConnectionPath {
  key: string
  d: string
  color: string
  labelX: number
  labelY: number
  label: string
}

function buildCurvePath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): string {
  const dx = toX - fromX
  const dy = toY - fromY
  const cx1 = fromX + dx * 0.3
  const cy1 = fromY + dy * 0.1
  const cx2 = fromX + dx * 0.7
  const cy2 = fromY + dy * 0.9
  return `M ${fromX} ${fromY} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${toX} ${toY}`
}

export const CategoryConnections = memo(function CategoryConnections({
  positions,
  categoryCounts,
  width,
  height,
}: CategoryConnectionsProps) {
  const paths = useMemo<ConnectionPath[]>(() => {
    const result: ConnectionPath[] = []

    for (const conn of CATEGORY_CONNECTIONS) {
      const fromPos = positions.get(conn.from)
      const toPos = positions.get(conn.to)
      if (!fromPos || !toPos) continue

      // Only draw connection if at least one side has memories
      const fromCount = categoryCounts.get(conn.from) ?? 0
      const toCount = categoryCounts.get(conn.to) ?? 0
      if (fromCount === 0 && toCount === 0) continue

      const fromCx = fromPos.x + NODE_WIDTH / 2
      const fromCy = fromPos.y + NODE_HEIGHT / 2
      const toCx = toPos.x + NODE_WIDTH / 2
      const toCy = toPos.y + NODE_HEIGHT / 2

      const d = buildCurvePath(fromCx, fromCy, toCx, toCy)

      // Blend color from the two connected categories
      const color = CATEGORY_META[conn.from].glowRgb

      result.push({
        key: `${conn.from}:${conn.to}`,
        d,
        color,
        labelX: (fromCx + toCx) / 2,
        labelY: (fromCy + toCy) / 2 - 8,
        label: conn.label,
      })
    }

    return result
  }, [positions, categoryCounts])

  if (paths.length === 0) return null

  return (
    <svg
      width={width}
      height={height}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
    >
      <AnimatePresence>
        {paths.map((path) => (
          <g key={path.key}>
            <motion.path
              d={path.d}
              fill="none"
              stroke={`rgba(${path.color}, 0.1)`}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeDasharray="4 4"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ duration: 1, ease: "easeOut", delay: 0.4 }}
            />
            <motion.text
              x={path.labelX}
              y={path.labelY}
              fill={`rgba(${path.color}, 0.3)`}
              fontSize={8}
              fontFamily="Geist Mono, monospace"
              textAnchor="middle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4, delay: 1 }}
            >
              {path.label}
            </motion.text>
          </g>
        ))}
      </AnimatePresence>
    </svg>
  )
})
