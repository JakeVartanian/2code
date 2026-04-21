/**
 * ConnectionLines — SVG overlay rendering bezier curves between connected nodes.
 * Uses ResizeObserver to track node positions and draws quadratic bezier paths.
 *
 * This is a structural v1 — positions are computed from DOM refs registered
 * via the context provider pattern. Visual fidelity will improve in later iterations.
 */

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  createContext,
  useContext,
  useMemo,
} from "react"
import { motion, AnimatePresence } from "motion/react"

// ─── Types ───────────────────────────────────────────────────────────

interface Connection {
  fromId: string
  toId: string
  type: string
}

interface ConnectionLinesProps {
  connections: Connection[]
}

interface NodePosition {
  x: number
  y: number
  width: number
  height: number
}

interface NodeRegistryContextValue {
  registerNode: (id: string, element: HTMLElement | null) => void
}

// ─── Context for registering node DOM elements ──────────────────────

const NodeRegistryContext = createContext<NodeRegistryContextValue>({
  registerNode: () => {},
})

export function useNodeRegistry() {
  return useContext(NodeRegistryContext)
}

export function NodeRegistryProvider({
  children,
  onPositionsChange,
}: {
  children: React.ReactNode
  onPositionsChange: (positions: Map<string, NodePosition>) => void
}) {
  const elementsRef = useRef(new Map<string, HTMLElement>())
  const observerRef = useRef<ResizeObserver | null>(null)

  const measureAll = useCallback(() => {
    const positions = new Map<string, NodePosition>()
    for (const [id, el] of elementsRef.current) {
      const rect = el.getBoundingClientRect()
      positions.set(id, {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
      })
    }
    onPositionsChange(positions)
  }, [onPositionsChange])

  useEffect(() => {
    observerRef.current = new ResizeObserver(measureAll)
    for (const el of elementsRef.current.values()) {
      observerRef.current.observe(el)
    }
    // Initial measurement
    measureAll()

    return () => {
      observerRef.current?.disconnect()
    }
  }, [measureAll])

  const registerNode = useCallback(
    (id: string, element: HTMLElement | null) => {
      if (element) {
        elementsRef.current.set(id, element)
        observerRef.current?.observe(element)
      } else {
        const existing = elementsRef.current.get(id)
        if (existing) {
          observerRef.current?.unobserve(existing)
        }
        elementsRef.current.delete(id)
      }
      measureAll()
    },
    [measureAll],
  )

  const value = useMemo(() => ({ registerNode }), [registerNode])

  return (
    <NodeRegistryContext.Provider value={value}>
      {children}
    </NodeRegistryContext.Provider>
  )
}

// ─── SVG Connection Lines ───────────────────────────────────────────

function buildQuadraticPath(
  from: NodePosition,
  to: NodePosition,
): string {
  const dx = to.x - from.x
  const dy = to.y - from.y

  // Control point offset perpendicular to the line
  const cx = from.x + dx / 2
  const cy = from.y + dy / 2 - Math.abs(dx) * 0.15

  return `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`
}

export const ConnectionLines = memo(function ConnectionLines({
  connections,
}: ConnectionLinesProps) {
  const [positions, setPositions] = useState<Map<string, NodePosition>>(
    new Map(),
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 })

  // Track container size
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSvgSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        })
      }
    })

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const renderedPaths = useMemo(() => {
    const paths: Array<{ key: string; d: string }> = []

    for (const conn of connections) {
      const from = positions.get(conn.fromId)
      const to = positions.get(conn.toId)
      if (!from || !to) continue

      // Adjust positions relative to container
      const container = containerRef.current
      if (!container) continue
      const containerRect = container.getBoundingClientRect()

      const relFrom: NodePosition = {
        ...from,
        x: from.x - containerRect.left,
        y: from.y - containerRect.top,
      }
      const relTo: NodePosition = {
        ...to,
        x: to.x - containerRect.left,
        y: to.y - containerRect.top,
      }

      paths.push({
        key: `${conn.fromId}-${conn.toId}-${conn.type}`,
        d: buildQuadraticPath(relFrom, relTo),
      })
    }

    return paths
  }, [connections, positions])

  return (
    <NodeRegistryProvider onPositionsChange={setPositions}>
      <div
        ref={containerRef}
        className="absolute inset-0 pointer-events-none overflow-hidden"
        style={{ zIndex: 1 }}
      >
        <svg
          width={svgSize.width}
          height={svgSize.height}
          className="absolute inset-0"
        >
          <AnimatePresence>
            {renderedPaths.map((path) => (
              <motion.path
                key={path.key}
                d={path.d}
                fill="none"
                stroke="rgb(6 182 212)" // cyan-500
                strokeWidth={1.5}
                strokeOpacity={0.15}
                strokeLinecap="round"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: "easeOut" }}
                className="hover:stroke-opacity-40 transition-[stroke-opacity] duration-200 pointer-events-auto"
              />
            ))}
          </AnimatePresence>
        </svg>
      </div>
    </NodeRegistryProvider>
  )
})
