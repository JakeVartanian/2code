/**
 * Converts machine-readable triggerEvent strings into human-readable trigger lines
 * for the suggestion cards and assessment panel "Why Now" section.
 */

export function formatTrigger(triggerEvent: string, triggerFiles?: string[]): string {
  if (!triggerEvent) return ""

  const primaryFile = triggerFiles?.[0]
    ? triggerFiles[0].split("/").pop()
    : null

  if (triggerEvent === "file-change") {
    return primaryFile ? `Modified ${primaryFile}` : "Recent file edit"
  }
  if (triggerEvent === "commit") {
    return primaryFile ? `Committed changes to ${primaryFile}` : "Recent commit"
  }
  if (triggerEvent === "branch-switch") {
    return "Branch switch detected"
  }
  if (triggerEvent === "session-synthesis") {
    return "" // Don't show — adds no info, just noise on every card
  }
  if (triggerEvent === "chat-batch") {
    return "" // Same — too generic to be useful
  }
  if (triggerEvent === "ci-failure") {
    return "CI failure detected"
  }
  if (triggerEvent === "tool-error") {
    return "Repeated tool errors observed"
  }
  if (triggerEvent === "memory-conflict") {
    return "Conflicts with a known project pattern"
  }

  // Fallback: humanize the raw string
  return triggerEvent.replace(/[-_]/g, " ").replace(/^\w/, c => c.toUpperCase())
}

/**
 * Builds a longer "Why Now" explanation for the assessment panel.
 */
export function formatTriggerDetail(triggerEvent: string, triggerFiles?: string[]): string {
  if (!triggerEvent) return ""

  const fileCount = triggerFiles?.length ?? 0
  const primaryFile = triggerFiles?.[0]?.split("/").pop()

  if (triggerEvent === "file-change" && primaryFile) {
    return fileCount > 1
      ? `You recently modified ${primaryFile} and ${fileCount - 1} other file${fileCount - 1 > 1 ? "s" : ""}.`
      : `You recently modified ${primaryFile}.`
  }
  if (triggerEvent === "commit") {
    return fileCount > 0
      ? `Your recent commit touched ${fileCount} file${fileCount > 1 ? "s" : ""}.`
      : "Your recent commit was analyzed."
  }
  if (triggerEvent === "session-synthesis") {
    return "This was noticed during a review of your recent coding session activity."
  }
  if (triggerEvent === "branch-switch") {
    return "This was detected after switching branches."
  }
  if (triggerEvent === "tool-error") {
    return "Repeated errors were observed during your session."
  }
  if (triggerEvent === "memory-conflict") {
    return "This change conflicts with a previously learned project pattern."
  }

  return formatTrigger(triggerEvent, triggerFiles)
}
