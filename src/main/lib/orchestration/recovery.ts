/**
 * Orchestration Crash Recovery
 *
 * On app startup, detects incomplete orchestration runs and marks them
 * as failed (since no active AbortController exists for them).
 * Users can then resume from the last checkpoint via the UI.
 */

import { getIncompleteRuns, loadCheckpoint, updateRunStatus } from "./checkpoint"
import type { CheckpointData } from "./types"

export interface RecoverableRun {
  id: string
  goal: string
  status: string
  chatId: string
  checkpoint: CheckpointData | null
  isValid: boolean
}

/**
 * Detect and handle incomplete orchestration runs from a previous session.
 * Called on app startup after DB initialization.
 *
 * Returns info about what was found for logging.
 */
export function recoverIncompleteRuns(): {
  found: number
  recovered: number
  failed: number
} {
  const incompleteRuns = getIncompleteRuns()

  if (incompleteRuns.length === 0) {
    return { found: 0, recovered: 0, failed: 0 }
  }

  console.log(`[orchestration/recovery] Found ${incompleteRuns.length} incomplete run(s)`)

  let recovered = 0
  let failed = 0

  for (const run of incompleteRuns) {
    const checkpoint = loadCheckpoint(run.id)
    const isValid = validateCheckpoint(checkpoint)

    if (isValid && checkpoint && checkpoint.completedTaskIds.length > 0) {
      // Run has valid progress — mark as paused so user can resume
      updateRunStatus(run.id, "paused")
      recovered++
      console.log(
        `[orchestration/recovery] Run ${run.id} ("${run.goal.slice(0, 40)}...") ` +
        `paused with ${checkpoint.completedTaskIds.length} completed tasks — can be resumed`,
      )
    } else {
      // No valid checkpoint or no progress — mark as failed
      updateRunStatus(run.id, "failed")
      failed++
      console.log(
        `[orchestration/recovery] Run ${run.id} ("${run.goal.slice(0, 40)}...") ` +
        `marked as failed (${isValid ? "no progress" : "invalid checkpoint"})`,
      )
    }
  }

  return { found: incompleteRuns.length, recovered, failed }
}

/**
 * Validate checkpoint data integrity before allowing resume.
 */
function validateCheckpoint(checkpoint: CheckpointData | null): boolean {
  if (!checkpoint) return false

  // Must have required fields
  if (!Array.isArray(checkpoint.completedTaskIds)) return false
  if (typeof checkpoint.taskResults !== "object" || checkpoint.taskResults === null) return false
  if (typeof checkpoint.accumulatedCostUsd !== "number") return false
  if (typeof checkpoint.lastCheckpointAt !== "number") return false

  // Completed IDs and results should be consistent
  for (const id of checkpoint.completedTaskIds) {
    if (typeof id !== "string") return false
  }

  // Cost should be reasonable (not NaN or negative)
  if (isNaN(checkpoint.accumulatedCostUsd) || checkpoint.accumulatedCostUsd < 0) return false

  return true
}

/**
 * Get recoverable runs with their checkpoint state.
 * Used by the UI to present recovery options.
 */
export function getRecoverableRuns(): RecoverableRun[] {
  const incompleteRuns = getIncompleteRuns()

  return incompleteRuns.map((run) => {
    const checkpoint = loadCheckpoint(run.id)
    return {
      id: run.id,
      goal: run.goal,
      status: run.status,
      chatId: run.chatId,
      checkpoint,
      isValid: validateCheckpoint(checkpoint),
    }
  })
}
