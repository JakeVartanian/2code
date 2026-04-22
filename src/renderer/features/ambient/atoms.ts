/**
 * Ambient agent UI atoms — pure display state only.
 * Server-derived state lives in the Zustand store (store.ts).
 */

import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"

/** Whether the ambient sidebar section is expanded/collapsed */
export const ambientPanelExpandedAtom = atomWithStorage<boolean>(
  "ambient:panelExpanded",
  true,
)

/** Last-used implement mode — persisted so repeat users don't re-select */
export const implementModeAtom = atomWithStorage<"plan" | "agent">(
  "ambient:implementMode",
  "plan",
)

/** The suggestion currently shown in the full assessment panel (null = list view) */
export const assessmentPanelSuggestionIdAtom = atom<string | null>(null)
