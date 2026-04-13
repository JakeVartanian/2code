/**
 * Crash Recovery Banner
 *
 * Shows a prominent banner when the app detects a previous crash,
 * offering to restore interrupted sessions.
 */

import { AlertCircle, RefreshCw, X } from "lucide-react"
import { useEffect, useState } from "react"
import { useSetAtom } from "jotai"
import { trpc } from "../../lib/trpc"
import { toast } from "sonner"
import { selectedAgentChatIdAtom } from "../agents/atoms"
import { useAgentSubChatStore } from "../agents/stores/sub-chat-store"
import { Button } from "../../components/ui/button"
import { motion, AnimatePresence } from "motion/react"

interface RecoverableSession {
  subChatId: string
  chatId: string
  name: string
  sessionId: string
  mode: string
  lastActive: string
}

export function CrashRecoveryBanner() {
  const [isVisible, setIsVisible] = useState(false)
  const [sessions, setSessions] = useState<RecoverableSession[]>([])
  const [isRestoring, setIsRestoring] = useState(false)

  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom)
  const { setActiveSubChat, addToOpenSubChats, setChatId } =
    useAgentSubChatStore()
  const { data: crashInfo } = trpc.crashRecovery.getCrashInfo.useQuery(
    undefined,
    {
      refetchOnWindowFocus: false,
      refetchOnMount: true,
      staleTime: Infinity,
    },
  )

  const dismissMutation = trpc.crashRecovery.dismissCrashRecovery.useMutation()
  const markRestoredMutation =
    trpc.crashRecovery.markSessionRestored.useMutation()

  useEffect(() => {
    if (crashInfo?.didCrash && crashInfo.recoverableSessions.length > 0) {
      setIsVisible(true)
      setSessions(crashInfo.recoverableSessions)
    }
  }, [crashInfo])

  const handleDismiss = () => {
    setIsVisible(false)
    dismissMutation.mutate()
  }

  const handleRestoreAll = async () => {
    if (sessions.length === 0) return

    setIsRestoring(true)

    try {
      // Navigate to each session and re-open the tabs
      for (const session of sessions) {
        // Navigate to the chat that contains this sub-chat
        setSelectedChatId(session.chatId)
        setChatId(session.chatId)
        addToOpenSubChats(session.subChatId)
        setActiveSubChat(session.subChatId)

        // Mark this session as restored
        await markRestoredMutation.mutateAsync({
          subChatId: session.subChatId,
        })
      }

      toast.success(
        `Restored ${sessions.length} session${sessions.length > 1 ? "s" : ""}`,
        {
          description:
            "Sessions have been reopened. You can continue where you left off.",
        },
      )

      setIsVisible(false)
    } catch (error) {
      console.error("[CrashRecovery] Failed to restore sessions:", error)
      toast.error("Failed to restore some sessions", {
        description: "Please try reopening them manually from the sidebar.",
      })
    } finally {
      setIsRestoring(false)
    }
  }

  if (!isVisible) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        transition={{ duration: 0.3 }}
        className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[90%] max-w-2xl"
      >
        <div className="bg-gradient-to-r from-orange-500/10 via-red-500/10 to-orange-500/10 border border-orange-500/30 rounded-lg shadow-lg backdrop-blur-sm">
          <div className="p-4 flex items-start gap-3">
            <div className="shrink-0 mt-0.5">
              <AlertCircle className="h-5 w-5 text-orange-500" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-foreground mb-1">
                App Crashed Unexpectedly
              </h3>
              <p className="text-xs text-muted-foreground mb-3">
                {sessions.length === 1
                  ? "1 conversation was interrupted"
                  : `${sessions.length} conversations were interrupted`}
                . Would you like to restore{" "}
                {sessions.length === 1 ? "it" : "them"}?
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={handleRestoreAll}
                  disabled={isRestoring}
                  className="bg-orange-500 hover:bg-orange-600 text-white"
                >
                  {isRestoring ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      Restoring...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                      Restore {sessions.length > 1 ? "All" : "Session"}
                    </>
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleDismiss}
                  disabled={isRestoring}
                  className="text-muted-foreground hover:text-foreground"
                >
                  Dismiss
                </Button>
              </div>
            </div>
            <button
              onClick={handleDismiss}
              disabled={isRestoring}
              className="shrink-0 p-1 rounded hover:bg-orange-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
