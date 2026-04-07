import type { UIMessageChunk } from "./types"

/**
 * Batches UIMessageChunk emissions to reduce IPC overhead between main and renderer processes.
 * Modeled after the terminal DataBatcher in src/main/lib/terminal/data-batcher.ts.
 *
 * When multiple Claude sessions stream simultaneously, each emits 1,000-5,000+
 * individual IPC messages. This batcher collects chunks into a time window and
 * emits them as a single batch message, reducing IPC round-trips to ~60 per second
 * per session.
 *
 * Batching strategy:
 * 1. Time-based: Flushes every BATCH_DURATION_MS (16ms = ~60fps, matching terminal)
 * 2. Size-based: Flushes when buffer exceeds MAX_BATCH_SIZE chunks
 * 3. Immediate flush for critical chunks (finish, error, auth-error, ask-user-question)
 */

const BATCH_DURATION_MS = 16
const MAX_BATCH_SIZE = 500

/**
 * Chunk types that must be emitted immediately without batching.
 * These are interactive or terminal events that the renderer needs to process
 * without any delay.
 */
const IMMEDIATE_CHUNK_TYPES = new Set([
  "finish",
  "error",
  "auth-error",
  "ask-user-question",
  "ask-user-question-timeout",
  "ask-user-question-result",
  "session-init",
  "retry-notification",
])

export type BatchedUIMessageChunk =
  | UIMessageChunk
  | { type: "batch"; chunks: UIMessageChunk[] }

export class ChunkBatcher {
  private buffer: UIMessageChunk[] = []
  private timeout: ReturnType<typeof setTimeout> | null = null
  private onFlush: (chunk: BatchedUIMessageChunk) => void
  private disposed = false

  constructor(onFlush: (chunk: BatchedUIMessageChunk) => void) {
    this.onFlush = onFlush
  }

  /**
   * Add a chunk to the batch. Certain chunk types (errors, finish, interactive
   * prompts) are emitted immediately. All others are batched.
   *
   * Returns false if the batcher has been disposed.
   */
  write(chunk: UIMessageChunk): boolean {
    if (this.disposed) return false

    // Critical chunks bypass batching entirely
    if (IMMEDIATE_CHUNK_TYPES.has(chunk.type)) {
      // Flush any pending batched chunks first so ordering is preserved
      this.flush()
      this.onFlush(chunk)
      return true
    }

    this.buffer.push(chunk)

    // Size-based flush: prevent unbounded memory growth
    if (this.buffer.length >= MAX_BATCH_SIZE) {
      this.flush()
      return true
    }

    // Time-based flush: start the timer on first buffered chunk
    if (this.timeout === null) {
      this.timeout = setTimeout(() => this.flush(), BATCH_DURATION_MS)
    }

    return true
  }

  /**
   * Flush all buffered chunks immediately.
   * Emits a single batch message if there are multiple chunks,
   * or emits the chunk directly if there is only one.
   */
  flush(): void {
    if (this.timeout !== null) {
      clearTimeout(this.timeout)
      this.timeout = null
    }

    if (this.buffer.length === 0) return

    // Clear buffer BEFORE calling onFlush so that if onFlush throws,
    // the buffer is not left in a dirty state and chunks aren't re-emitted
    // on the next flush call.
    const chunks = this.buffer
    this.buffer = []

    if (chunks.length === 1) {
      // Single chunk: emit directly without wrapping in batch
      this.onFlush(chunks[0])
    } else {
      // Multiple chunks: emit as a single batch message
      this.onFlush({ type: "batch", chunks })
    }
  }

  /**
   * Dispose of the batcher, flushing any remaining chunks.
   * After disposal, write() becomes a no-op.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.flush()
  }
}
