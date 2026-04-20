/**
 * Ambient agent UI atoms — pure display state only.
 * Server-derived state lives in the Zustand store (store.ts).
 */

import { atomWithStorage } from "jotai/utils"

/** Whether the ambient sidebar section is expanded/collapsed */
export const ambientPanelExpandedAtom = atomWithStorage<boolean>(
  "ambient:panelExpanded",
  true,
)

// Indicator state is computed inline in ambient-sidebar-section.tsx
// (derived from store suggestions, no atom needed)
