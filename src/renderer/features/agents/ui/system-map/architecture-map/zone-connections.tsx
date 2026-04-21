/**
 * ZoneConnections — SVG layer drawing bezier curves between zones
 * with protocol labels at midpoints.
 */

import { memo, useMemo } from "react"
import { motion, AnimatePresence } from "motion/react"
import { ZONE_WIDTH, ZONE_HEIGHT } from "./layout"
import type { EnrichedZone } from "./use-architecture-data"

interface ZoneConnectionsProps {
  zones: EnrichedZone[]
  positions: Map<string, { x: number; y: number }>
  width: number
  height: number
}

interface ConnectionPath {
  key: string
  d: string
  color: string
  labelX: number
  labelY: number
  protocol: string
}

function getZoneColor(confidence: number): string {
  if (confidence >= 80) return "34,197,94"    // green
  if (confidence >= 60) return "6,182,212"    // cyan
  if (confidence >= 40) return "245,158,11"   // amber
  if (confidence >= 20) return "236,72,153"   // pink
  return "82,82,91"                            // gray
}

function buildCurvePath(
  fromX: number, fromY: number,
  toX: number, toY: number,
): string {
  const dx = toX - fromX
  const dy = toY - fromY

  // Control point: perpendicular offset for curve
  const cx1 = fromX + dx * 0.3
  const cy1 = fromY + dy * 0.1
  const cx2 = fromX + dx * 0.7
  const cy2 = fromY + dy * 0.9

  return `M ${fromX} ${fromY} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${toX} ${toY}`
}

export const ZoneConnections = memo(function ZoneConnections({
  zones,
  positions,
  width,
  height,
}: ZoneConnectionsProps) {
  const paths = useMemo<ConnectionPath[]>(() => {
    const result: ConnectionPath[] = []
    const seen = new Set<string>()

    for (const zone of zones) {
      const fromPos = positions.get(zone.id)
      if (!fromPos) continue

      for (const conn of zone.connections) {
        const toPos = positions.get(conn.targetZoneId)
        if (!toPos) continue

        // Deduplicate bidirectional connections
        const pairKey = [zone.id, conn.targetZoneId].sort().join(":")
        if (seen.has(pairKey)) continue
        seen.add(pairKey)

        // Connect from center of source to center of target
        const fromCx = fromPos.x + ZONE_WIDTH / 2
        const fromCy = fromPos.y + ZONE_HEIGHT / 2
        const toCx = toPos.x + ZONE_WIDTH / 2
        const toCy = toPos.y + ZONE_HEIGHT / 2

        const d = buildCurvePath(fromCx, fromCy, toCx, toCy)
        const color = getZoneColor(zone.confidence)

        // Label at midpoint
        const labelX = (fromCx + toCx) / 2
        const labelY = (fromCy + toCy) / 2 - 8

        result.push({
          key: pairKey,
          d,
          color,
          labelX,
          labelY,
          protocol: conn.protocol,
        })
      }
    }

    return result
  }, [zones, positions])

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
              stroke={`rgba(${path.color}, 0.15)`}
              strokeWidth={2}
              strokeLinecap="round"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ duration: 0.8, ease: "easeOut", delay: 0.3 }}
            />
            <motion.text
              x={path.labelX}
              y={path.labelY}
              fill={`rgba(${path.color}, 0.4)`}
              fontSize={8}
              fontFamily="Geist Mono, monospace"
              textAnchor="middle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4, delay: 0.8 }}
            >
              {path.protocol}
            </motion.text>
          </g>
        ))}
      </AnimatePresence>
    </svg>
  )
})
