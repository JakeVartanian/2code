import { useMemo } from "react"
import { trpc } from "../../../lib/trpc"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>

/**
 * Wraps trpc.chats.get with message transformation logic:
 * - JSON parses messages
 * - Migrates old tool-invocation parts to tool-{toolName} format
 * - Normalizes ACP verb types
 * - Normalizes state fields from DB format to AI SDK format
 * - Maps field names (createdAt → created_at, etc.)
 */
export function useAgentChat(
  chatId: string | null | undefined,
  opts?: { enabled?: boolean; staleTime?: number; gcTime?: number },
) {
  const result = trpc.chats.get.useQuery(
    { id: chatId! },
    {
      ...(opts ?? {}),
      enabled: !!chatId && opts?.enabled !== false,
      staleTime: opts?.staleTime ?? 10_000,
      gcTime: opts?.gcTime ?? 60_000,
    },
  )

  const transformedData = useMemo(() => {
    if (!result.data) return null
    return {
      ...result.data,
      sandbox_id: null,
      meta: null,
      subChats: result.data.subChats?.map((sc: AnyObj) => {
        let parsedMessages: AnyObj[] = []
        try {
          parsedMessages = sc.messages ? JSON.parse(sc.messages) : []
          parsedMessages = parsedMessages.map((msg: AnyObj) => {
            if (!msg.parts) return msg
            return {
              ...msg,
              parts: msg.parts.map((part: AnyObj) => {
                // Migrate old "tool-invocation" type to "tool-{toolName}"
                if (part.type === "tool-invocation" && part.toolName) {
                  return {
                    ...part,
                    type: `tool-${part.toolName}`,
                    toolCallId: part.toolCallId || part.toolInvocationId,
                    input: part.input || part.args,
                  }
                }
                // Normalize ACP tool types
                if (
                  part.type?.startsWith("tool-") &&
                  (part.input?.toolName ||
                    part.type.includes(" ") ||
                    part.type ===
                      "tool-acp.acp_provider_agent_dynamic_tool")
                ) {
                  const acpVerbMap: AnyObj = {
                    Read: "Read",
                    Run: "Bash",
                    List: "Glob",
                    Search: "Grep",
                    Grep: "Grep",
                    Glob: "Glob",
                    Edit: "Edit",
                    Write: "Write",
                    Thought: "Thinking",
                    Fetch: "WebFetch",
                  }
                  let parsedInput: AnyObj = {}
                  if (part.input && typeof part.input === "object") {
                    parsedInput = part.input as AnyObj
                  } else if (typeof part.input === "string") {
                    try {
                      const parsed = JSON.parse(part.input)
                      if (parsed && typeof parsed === "object") {
                        parsedInput = parsed as AnyObj
                      }
                    } catch {
                      parsedInput = {}
                    }
                  }
                  const title: string =
                    parsedInput.toolName || part.type.slice(5)
                  const args: AnyObj =
                    parsedInput.args && typeof parsedInput.args === "object"
                      ? parsedInput.args
                      : parsedInput
                  const spaceIdx = title.indexOf(" ")
                  const verb =
                    spaceIdx === -1 ? title : title.slice(0, spaceIdx)
                  const detail =
                    spaceIdx === -1 ? "" : title.slice(spaceIdx + 1)
                  const toolType = acpVerbMap[verb]
                  if (toolType) {
                    const unwrapped: AnyObj = {
                      ...part,
                      type: `tool-${toolType}`,
                      input: {
                        ...args,
                        _acpTitle: title,
                        _acpDetail: detail,
                      },
                    }
                    if (
                      toolType === "Read" &&
                      !unwrapped.input.file_path &&
                      detail
                    )
                      unwrapped.input.file_path = detail
                    if (toolType === "Bash") {
                      if (Array.isArray(unwrapped.input.command)) {
                        unwrapped.input.command =
                          unwrapped.input.command[
                            unwrapped.input.command.length - 1
                          ] || detail
                      } else if (!unwrapped.input.command && detail) {
                        unwrapped.input.command = detail
                      }
                    }
                    if (
                      toolType === "Grep" &&
                      !unwrapped.input.pattern &&
                      detail
                    )
                      unwrapped.input.pattern = detail
                    if (
                      toolType === "Glob" &&
                      !unwrapped.input.pattern &&
                      detail
                    )
                      unwrapped.input.pattern = detail
                    // State normalization
                    if (unwrapped.state) {
                      let normalizedState = unwrapped.state
                      if (unwrapped.state === "result") {
                        normalizedState =
                          unwrapped.result?.success === false
                            ? "output-error"
                            : "output-available"
                      }
                      return {
                        ...unwrapped,
                        state: normalizedState,
                        output: unwrapped.output || unwrapped.result,
                      }
                    }
                    return unwrapped
                  }
                }
                // Normalize state field from DB format to AI SDK format
                if (part.type?.startsWith("tool-") && part.state) {
                  let normalizedState = part.state
                  if (part.state === "result") {
                    normalizedState =
                      part.result?.success === false
                        ? "output-error"
                        : "output-available"
                  }
                  return {
                    ...part,
                    state: normalizedState,
                    output: part.output || part.result,
                  }
                }
                return part
              }),
            }
          })
        } catch {
          console.warn(
            "[useAgentChat] Failed to parse messages for subChat:",
            sc.id,
          )
          parsedMessages = []
        }
        return {
          ...sc,
          created_at: sc.createdAt,
          updated_at: sc.updatedAt,
          messages: parsedMessages,
          stream_id: null,
        }
      }),
    }
  }, [result.data])

  return {
    data: transformedData,
    isLoading: result.isLoading,
  }
}
