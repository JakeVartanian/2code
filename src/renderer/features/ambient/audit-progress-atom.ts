/**
 * Live audit progress atom — tracks per-zone status during "Audit All" runs.
 * Written by the subscription handler in use-ambient-data.ts,
 * read by architecture-map.tsx and zone-card.tsx.
 */

import { atom } from "jotai"
import type { AuditProgress } from "../../../shared/audit-types"

export interface AuditProgressState {
  isRunning: boolean
  runId: string | null
  startedAt: number | null
  zoneCount: number
  progress: AuditProgress[]
}

const defaultState: AuditProgressState = {
  isRunning: false,
  runId: null,
  startedAt: null,
  zoneCount: 0,
  progress: [],
}

export const auditProgressAtom = atom<AuditProgressState>(defaultState)
export const auditProgressDefaultState = defaultState
