import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"
import type { ApprovalSensitivity } from "../../../../main/lib/orchestration/types"

/** Whether orchestration mode is enabled for the current chat (persisted) */
export const orchestrationEnabledAtom = atomWithStorage<boolean>(
  "orchestration:enabled",
  false,
  undefined,
  { getOnInit: true },
)

/** Approval sensitivity level (persisted) */
export const orchestrationApprovalLevelAtom = atomWithStorage<ApprovalSensitivity>(
  "orchestration:approvalLevel",
  "normal",
  undefined,
  { getOnInit: true },
)

/** Cost limit in USD (persisted) */
export const orchestrationCostLimitAtom = atomWithStorage<number>(
  "orchestration:costLimit",
  5,
  undefined,
  { getOnInit: true },
)

/** Whether the orchestration panel is open */
export const orchestrationPanelOpenAtom = atom(false)

/** Currently selected run ID for detail view */
export const orchestrationSelectedRunIdAtom = atom<string | null>(null)

/** Currently selected task ID for expanded detail */
export const orchestrationSelectedTaskIdAtom = atom<string | null>(null)
