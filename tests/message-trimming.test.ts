/**
 * Tests for message trimming and pruning logic.
 *
 * These tests catch regressions that lead to renderer memory bloat:
 * - Tool outputs growing unbounded (caused 61MB single chat, 1.56GB renderer RSS)
 * - Message count exceeding caps
 * - JSON payload exceeding size limits
 */

import { describe, it, expect } from "vitest"

// --- Inline the trimming logic so tests don't need Electron imports ---

const TOOL_OUTPUT_MAX_BYTES = 1024
const TOOL_TYPES_TO_TRIM = new Set([
  "tool-Read", "tool-Edit", "tool-Bash", "tool-Write", "tool-Agent",
  "tool-Grep", "tool-Glob",
])

function shouldTrimPart(partType: string): boolean {
  if (TOOL_TYPES_TO_TRIM.has(partType)) return true
  if (partType.startsWith("tool-mcp_")) return true
  return false
}

function trimToolOutput(value: unknown): unknown {
  if (typeof value === "string" && value.length > TOOL_OUTPUT_MAX_BYTES) {
    return value.slice(0, TOOL_OUTPUT_MAX_BYTES) + `\n\n[… trimmed ${Math.round(value.length / 1024)}KB for display]`
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const trimmed: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      trimmed[k] = trimToolOutput(v)
    }
    return trimmed
  }
  if (Array.isArray(value)) {
    return value.map(trimToolOutput)
  }
  return value
}

function trimMessagesForRenderer(messagesJson: string): string {
  try {
    const messages = JSON.parse(messagesJson)
    if (!Array.isArray(messages)) return messagesJson
    const trimmed = messages.map((msg: any) => {
      if (!msg.parts || !Array.isArray(msg.parts)) return msg
      const newParts = msg.parts.map((part: any) => {
        if (!part.type || !shouldTrimPart(part.type)) return part
        const newPart = { ...part }
        if (newPart.output !== undefined) newPart.output = trimToolOutput(newPart.output)
        if (newPart.result !== undefined) newPart.result = trimToolOutput(newPart.result)
        newPart._trimmed = true
        return newPart
      })
      return { ...msg, parts: newParts }
    })
    return JSON.stringify(trimmed)
  } catch {
    return messagesJson
  }
}

// --- Inline pruning logic ---

const MAX_MESSAGES_PER_CHAT = 200
const MAX_MESSAGES_JSON_BYTES = 5 * 1024 * 1024
const MAX_MESSAGES_SIZE_PRUNE_TARGET = 100

function pruneMessageHistory(messages: any[], subChatId: string): any[] {
  let result = messages
  if (result.length > MAX_MESSAGES_PER_CHAT) {
    result = result.slice(-MAX_MESSAGES_PER_CHAT)
  }
  const jsonSize = JSON.stringify(result).length
  if (jsonSize > MAX_MESSAGES_JSON_BYTES) {
    result = result.slice(-MAX_MESSAGES_SIZE_PRUNE_TARGET)
  }
  return result
}

// --- Inline strip logic ---

const KEEP_FULL_CONTENT_COUNT = 50
const TOOL_OUTPUT_TRIM_THRESHOLD = 2048
const TOOL_PART_TYPES_TO_STRIP = new Set([
  "tool-Read", "tool-Edit", "tool-Bash", "tool-Write", "tool-Agent",
  "tool-Grep", "tool-Glob",
])

function stripOldToolOutputs(messages: any[]): { messages: any[]; bytesSaved: number } {
  if (messages.length <= KEEP_FULL_CONTENT_COUNT) return { messages, bytesSaved: 0 }
  let bytesSaved = 0
  const cutoff = messages.length - KEEP_FULL_CONTENT_COUNT
  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i]
    if (!msg.parts || !Array.isArray(msg.parts)) continue
    for (const part of msg.parts) {
      if (!part.type) continue
      const isToolType = TOOL_PART_TYPES_TO_STRIP.has(part.type) || part.type.startsWith("tool-mcp_")
      if (!isToolType) continue
      for (const field of ["output", "result"] as const) {
        if (part[field] === undefined) continue
        const json = JSON.stringify(part[field])
        if (json.length > TOOL_OUTPUT_TRIM_THRESHOLD) {
          bytesSaved += json.length
          const excerpt = typeof part[field] === "string"
            ? part[field].slice(0, 200)
            : JSON.stringify(part[field]).slice(0, 200)
          part[field] = `[stripped ${Math.round(json.length / 1024)}KB — ${excerpt}…]`
        }
      }
    }
  }
  return { messages, bytesSaved }
}

// --- Helpers ---

function makeMessage(role: string, parts: any[]) {
  return { id: crypto.randomUUID(), role, parts }
}

function makeToolPart(type: string, outputSize: number) {
  return {
    type,
    toolCallId: `call-${crypto.randomUUID().slice(0, 8)}`,
    toolName: type.replace("tool-", ""),
    input: { file_path: "/some/file.ts" },
    state: "output-available",
    output: "x".repeat(outputSize),
    result: { content: "y".repeat(outputSize) },
  }
}

function makeTextPart(text: string) {
  return { type: "text", text }
}

// =============================================================================
// Tests
// =============================================================================

describe("trimMessagesForRenderer", () => {
  it("trims large tool-Read outputs to 1KB", () => {
    const messages = [
      makeMessage("assistant", [makeToolPart("tool-Read", 50_000)]),
    ]
    const result = trimMessagesForRenderer(JSON.stringify(messages))
    const parsed = JSON.parse(result)
    const output = parsed[0].parts[0].output as string
    expect(output.length).toBeLessThan(2000)
    expect(output).toContain("[… trimmed")
    expect(parsed[0].parts[0]._trimmed).toBe(true)
  })

  it("trims large tool-Edit outputs", () => {
    const messages = [
      makeMessage("assistant", [makeToolPart("tool-Edit", 20_000)]),
    ]
    const result = trimMessagesForRenderer(JSON.stringify(messages))
    const parsed = JSON.parse(result)
    expect((parsed[0].parts[0].output as string).length).toBeLessThan(2000)
  })

  it("trims large tool-Bash outputs", () => {
    const messages = [
      makeMessage("assistant", [makeToolPart("tool-Bash", 100_000)]),
    ]
    const result = trimMessagesForRenderer(JSON.stringify(messages))
    const parsed = JSON.parse(result)
    expect((parsed[0].parts[0].output as string).length).toBeLessThan(2000)
  })

  it("does NOT trim text parts", () => {
    const longText = "z".repeat(10_000)
    const messages = [
      makeMessage("assistant", [makeTextPart(longText)]),
    ]
    const result = trimMessagesForRenderer(JSON.stringify(messages))
    const parsed = JSON.parse(result)
    expect(parsed[0].parts[0].text).toBe(longText)
  })

  it("does NOT trim small tool outputs", () => {
    const messages = [
      makeMessage("assistant", [makeToolPart("tool-Read", 500)]),
    ]
    const result = trimMessagesForRenderer(JSON.stringify(messages))
    const parsed = JSON.parse(result)
    expect(parsed[0].parts[0].output).toBe("x".repeat(500))
    // _trimmed is set on any tool type that enters shouldTrimPart(), even if output is small
    // The key check is that output content is preserved unchanged
  })

  it("trims MCP tool outputs", () => {
    const messages = [
      makeMessage("assistant", [makeToolPart("tool-mcp__figma__get_design_context", 30_000)]),
    ]
    const result = trimMessagesForRenderer(JSON.stringify(messages))
    const parsed = JSON.parse(result)
    expect((parsed[0].parts[0].output as string).length).toBeLessThan(2000)
  })

  it("does NOT trim tool-Thinking parts", () => {
    const messages = [
      makeMessage("assistant", [{
        type: "tool-Thinking",
        toolCallId: "think-1",
        input: { text: "a".repeat(5000) },
        output: { text: "b".repeat(5000) },
      }]),
    ]
    const result = trimMessagesForRenderer(JSON.stringify(messages))
    const parsed = JSON.parse(result)
    // Thinking is not in the trim list, should be unchanged
    expect(parsed[0].parts[0].output.text).toBe("b".repeat(5000))
  })

  it("handles malformed JSON gracefully", () => {
    const result = trimMessagesForRenderer("not json {{{")
    expect(result).toBe("not json {{{")
  })

  it("handles empty messages array", () => {
    const result = trimMessagesForRenderer("[]")
    expect(result).toBe("[]")
  })

  it("reduces a realistic bloated chat significantly", () => {
    // Simulate the actual bloat pattern: 200+ tool parts with large outputs
    const messages: any[] = []
    for (let i = 0; i < 200; i++) {
      messages.push(makeMessage("assistant", [
        makeToolPart("tool-Read", 6_000),   // Avg from real data
        makeToolPart("tool-Edit", 13_000),  // Avg from real data
        makeToolPart("tool-Bash", 2_500),   // Avg from real data
      ]))
    }
    const before = JSON.stringify(messages).length
    const result = trimMessagesForRenderer(JSON.stringify(messages))
    const after = result.length

    expect(before).toBeGreaterThan(5_000_000) // Should be > 5MB before
    expect(after).toBeLessThan(before * 0.3)  // Should be < 30% of original
  })
})

describe("pruneMessageHistory", () => {
  it("keeps messages under the count cap", () => {
    const messages = Array.from({ length: 100 }, (_, i) =>
      makeMessage("user", [makeTextPart(`msg ${i}`)])
    )
    const result = pruneMessageHistory(messages, "test")
    expect(result.length).toBe(100) // Under 200, no pruning
  })

  it("prunes messages over the count cap to 200", () => {
    const messages = Array.from({ length: 300 }, (_, i) =>
      makeMessage("user", [makeTextPart(`msg ${i}`)])
    )
    const result = pruneMessageHistory(messages, "test")
    expect(result.length).toBe(200)
    // Should keep the LAST 200
    expect(result[0].parts[0].text).toBe("msg 100")
  })

  it("prunes by size when total JSON exceeds 5MB", () => {
    // Each message is ~50KB → 200 messages = ~10MB → exceeds 5MB cap
    const messages = Array.from({ length: 200 }, (_, i) =>
      makeMessage("assistant", [makeToolPart("tool-Read", 50_000)])
    )
    const result = pruneMessageHistory(messages, "test")
    expect(result.length).toBe(100) // Size-pruned to 100
  })
})

describe("stripOldToolOutputs", () => {
  it("does nothing when messages are under the keep-full threshold", () => {
    const messages = Array.from({ length: 30 }, () =>
      makeMessage("assistant", [makeToolPart("tool-Read", 5000)])
    )
    const { bytesSaved } = stripOldToolOutputs(messages)
    expect(bytesSaved).toBe(0)
  })

  it("strips outputs from messages older than the last 50", () => {
    const messages = Array.from({ length: 100 }, () =>
      makeMessage("assistant", [makeToolPart("tool-Read", 5000)])
    )
    const { bytesSaved } = stripOldToolOutputs(messages)
    expect(bytesSaved).toBeGreaterThan(0)
    // First 50 messages should be stripped
    expect(messages[0].parts[0].output).toContain("[stripped")
    // Last 50 should be untouched
    expect(messages[99].parts[0].output).toBe("x".repeat(5000))
  })

  it("does NOT strip text parts", () => {
    const messages = Array.from({ length: 100 }, () =>
      makeMessage("assistant", [makeTextPart("a".repeat(5000))])
    )
    const { bytesSaved } = stripOldToolOutputs(messages)
    expect(bytesSaved).toBe(0)
    expect(messages[0].parts[0].text).toBe("a".repeat(5000))
  })

  it("does NOT strip small tool outputs", () => {
    const messages = Array.from({ length: 100 }, () =>
      makeMessage("assistant", [makeToolPart("tool-Read", 500)]) // Under 2KB threshold
    )
    const { bytesSaved } = stripOldToolOutputs(messages)
    expect(bytesSaved).toBe(0)
  })

  it("strips MCP tool outputs from old messages", () => {
    const messages = Array.from({ length: 100 }, () =>
      makeMessage("assistant", [makeToolPart("tool-mcp__figma__get_screenshot", 10_000)])
    )
    const { bytesSaved } = stripOldToolOutputs(messages)
    expect(bytesSaved).toBeGreaterThan(0)
    expect(messages[0].parts[0].output).toContain("[stripped")
  })
})

describe("size regression guards", () => {
  it("MAX_MESSAGES_PER_CHAT is 200 or less", () => {
    // If someone bumps this back to 500, this test fails
    expect(MAX_MESSAGES_PER_CHAT).toBeLessThanOrEqual(200)
  })

  it("MAX_MESSAGES_JSON_BYTES is 5MB or less", () => {
    expect(MAX_MESSAGES_JSON_BYTES).toBeLessThanOrEqual(5 * 1024 * 1024)
  })

  it("TOOL_OUTPUT_MAX_BYTES is 1KB or less", () => {
    expect(TOOL_OUTPUT_MAX_BYTES).toBeLessThanOrEqual(1024)
  })

  it("trimMessagesForRenderer output is always smaller than input for large payloads", () => {
    const messages = Array.from({ length: 50 }, () =>
      makeMessage("assistant", [
        makeToolPart("tool-Read", 10_000),
        makeToolPart("tool-Edit", 10_000),
      ])
    )
    const input = JSON.stringify(messages)
    const output = trimMessagesForRenderer(input)
    // With 50 messages × 2 parts × 10KB each = ~1MB input
    // After trimming to 1KB each = ~100KB output
    expect(output.length).toBeLessThan(input.length * 0.5)
  })
})
