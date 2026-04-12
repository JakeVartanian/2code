import { atom } from "jotai"
import type { MemoryCategory } from "../../../../main/lib/memory/types"

/** Whether the memory panel is open */
export const memoryPanelOpenAtom = atom(false)

/** Active category filter in the memory panel (null = show all) */
export const memoryCategoryFilterAtom = atom<MemoryCategory | null>(null)

/** Search query in the memory panel */
export const memorySearchAtom = atom("")

/** Which topic file is currently being viewed (null = index view) */
export const memoryActiveTopicAtom = atom<string | null>(null)
