import { atom } from "jotai"
import { useStreamingStatusStore } from "../stores/streaming-status-store"
import { clearSubChatRuntimeCaches } from "../stores/sub-chat-runtime-cleanup"

// Stub atoms for web-only features unused in desktop
export const clearSubChatSelectionAtom = atom(null, () => {})
export const isSubChatMultiSelectModeAtom = atom(false)
export const selectedSubChatIdsAtom = atom(new Set<string>())
export const selectedTeamIdAtom = atom<string | null>(null)
export type PlanType = string

// Module-level scroll position cache (per subChatId, session-only)
// Stores { scrollTop, scrollHeight, wasAtBottom } so we can restore position on tab switch
export const scrollPositionCache = new Map<
  string,
  { scrollTop: number; scrollHeight: number; wasAtBottom: boolean }
>()
export const mountedChatViewInnerCounts = new Map<string, number>()
export const pendingSubChatCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function clearRuntimeCachesForSubChat(subChatId: string) {
  clearSubChatRuntimeCaches(subChatId)
  scrollPositionCache.delete(subChatId)
}

/** Wait for streaming to finish by subscribing to the status store.
 *  Includes a 30s safety timeout — if the store never transitions to "ready",
 *  the promise resolves anyway to prevent hanging the UI indefinitely. */
export const STREAMING_READY_TIMEOUT_MS = 30_000

export function waitForStreamingReady(subChatId: string): Promise<void> {
  return new Promise((resolve) => {
    if (!useStreamingStatusStore.getState().isStreaming(subChatId)) {
      resolve()
      return
    }

    const timeout = setTimeout(() => {
      console.warn(
        `[waitForStreamingReady] Timed out after ${STREAMING_READY_TIMEOUT_MS}ms for subChat ${subChatId.slice(-8)}, proceeding anyway`
      )
      unsub()
      resolve()
    }, STREAMING_READY_TIMEOUT_MS)

    const unsub = useStreamingStatusStore.subscribe(
      (state) => state.statuses[subChatId],
      (status) => {
        if (status === "ready" || status === "error" || status === undefined) {
          clearTimeout(timeout)
          unsub()
          resolve()
        }
      }
    )
  })
}

// Exploring tools - these get grouped when 2+ consecutive
export const EXPLORING_TOOLS = new Set([
  "tool-Read",
  "tool-Grep",
  "tool-Glob",
  "tool-WebSearch",
  "tool-WebFetch",
])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>

// Group consecutive exploring tools into exploring-group
export function groupExploringTools(parts: AnyObj[], nestedToolIds: Set<string>): AnyObj[] {
  const result: AnyObj[] = []
  let currentGroup: AnyObj[] = []

  for (const part of parts) {
    // Skip nested tools - they shouldn't be grouped, they render inside parent
    const isNested = part.toolCallId && nestedToolIds.has(part.toolCallId)

    if (EXPLORING_TOOLS.has(part.type) && !isNested) {
      currentGroup.push(part)
    } else {
      // Flush group if 3+
      if (currentGroup.length >= 3) {
        result.push({ type: "exploring-group", parts: currentGroup })
      } else {
        result.push(...currentGroup)
      }
      currentGroup = []
      result.push(part)
    }
  }
  // Flush remaining
  if (currentGroup.length >= 3) {
    result.push({ type: "exploring-group", parts: currentGroup })
  } else {
    result.push(...currentGroup)
  }
  return result
}

// Get the ID of the first sub-chat by creation date
export function getFirstSubChatId(
  subChats:
    | Array<{ id: string; created_at?: Date | string | null }>
    | undefined,
): string | null {
  if (!subChats?.length) return null
  const sorted = [...subChats].sort(
    (a, b) =>
      (a.created_at ? new Date(a.created_at).getTime() : 0) -
      (b.created_at ? new Date(b.created_at).getTime() : 0),
  )
  return sorted[0]?.id ?? null
}

// Layout constants for chat header and sticky messages
export const CHAT_LAYOUT = {
  // Padding top for chat content
  paddingTopSidebarOpen: "pt-12", // When sidebar open (absolute header overlay)
  paddingTopSidebarClosed: "pt-4", // When sidebar closed (regular header)
  paddingTopMobile: "pt-14", // Mobile has header
  // Sticky message top position (title is now in flex above scroll, so top-0)
  stickyTopSidebarOpen: "top-0", // When sidebar open (desktop, absolute header)
  stickyTopSidebarClosed: "top-0", // When sidebar closed (desktop, flex header)
  stickyTopMobile: "top-0", // Mobile (flex header, so top-0)
  // Header padding when absolute
  headerPaddingSidebarOpen: "pt-1.5 pb-12 px-3 pl-2",
  headerPaddingSidebarClosed: "p-2 pt-1.5",
} as const
