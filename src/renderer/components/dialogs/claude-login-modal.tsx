import { useAtom, useSetAtom } from "jotai"
import { X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { pendingAuthRetryMessageAtom } from "../../features/agents/atoms"
import {
  agentsLoginModalOpenAtom,
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
  anthropicOnboardingCompletedAtom,
  type SettingsTab,
} from "../../lib/atoms"
import { appStore } from "../../lib/jotai-store"
import { trpc } from "../../lib/trpc"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
} from "../ui/alert-dialog"
import { Button } from "../ui/button"
import { ClaudeCodeIcon, IconSpinner } from "../ui/icons"
import { Input } from "../ui/input"
import { Logo } from "../ui/logo"

type AuthFlowState =
  | { step: "idle" }
  | { step: "starting" }
  | {
      step: "waiting_url"
      sandboxId: string
      sandboxUrl: string
      sessionId: string
    }
  | {
      step: "has_url"
      sandboxId: string
      oauthUrl: string
      sandboxUrl: string
      sessionId: string
    }
  | { step: "submitting" }
  | { step: "error"; message: string }

type ClaudeLoginModalProps = {
  hideCustomModelSettingsLink?: boolean
  autoStartAuth?: boolean
}

export function ClaudeLoginModal({
  hideCustomModelSettingsLink = false,
  autoStartAuth = false,
}: ClaudeLoginModalProps) {
  const [open, setOpen] = useAtom(agentsLoginModalOpenAtom)
  const setAnthropicOnboardingCompleted = useSetAtom(
    anthropicOnboardingCompletedAtom,
  )
  const setSettingsOpen = useSetAtom(agentsSettingsDialogOpenAtom)
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom)
  const [flowState, setFlowState] = useState<AuthFlowState>({ step: "idle" })
  const [authCode, setAuthCode] = useState("")
  const [userClickedConnect, setUserClickedConnect] = useState(false)
  const [urlOpened, setUrlOpened] = useState(false)
  const [savedOauthUrl, setSavedOauthUrl] = useState<string | null>(null)
  const [savedManualUrl, setSavedManualUrl] = useState<string | null>(null)
  const [showManualInput, setShowManualInput] = useState(false)
  const [authStarted, setAuthStarted] = useState(false)
  const urlOpenedRef = useRef(false)
  const didAutoStartForOpenRef = useRef(false)
  // Track whether the account was already connected when the modal opened.
  // Prevents premature handleAuthSuccess when an old (undecryptable) account
  // exists in the DB from a previous build — isConnected is true on mount,
  // but the token can't actually be used.
  const wasConnectedOnOpenRef = useRef<boolean | null>(null)

  // tRPC mutations
  const startAuthMutation = trpc.claudeCode.startAuth.useMutation()
  const submitCodeMutation = trpc.claudeCode.submitCode.useMutation()
  const openOAuthUrlMutation = trpc.claudeCode.openOAuthUrl.useMutation()
  const trpcUtils = trpc.useUtils()

  const isPolling = flowState.step === "waiting_url" || flowState.step === "has_url"

  // Poll for OAuth URL and auto-callback completion
  const pollStatusQuery = trpc.claudeCode.pollStatus.useQuery(
    {
      sandboxUrl: isPolling ? flowState.sandboxUrl : "",
      sessionId: isPolling ? flowState.sessionId : "",
    },
    {
      enabled: isPolling,
      refetchInterval: 1500,
    }
  )

  // Also poll getIntegration as belt-and-suspenders once auth has started
  const integrationQuery = trpc.claudeCode.getIntegration.useQuery(undefined, {
    enabled: authStarted || isPolling,
    refetchInterval: authStarted || isPolling ? 1500 : false,
  })

  // Capture initial isConnected state when integrationQuery first loads
  useEffect(() => {
    if (integrationQuery.data && wasConnectedOnOpenRef.current === null) {
      wasConnectedOnOpenRef.current = !!integrationQuery.data.isConnected
    }
  }, [integrationQuery.data])

  // Complete as soon as token is NEWLY stored in DB (transition from false→true).
  // Without the transition check, an existing but undecryptable account (from a
  // previous unsigned build) would trigger immediate handleAuthSuccess before the
  // user completes OAuth, causing a close→retry→fail→reopen loop.
  useEffect(() => {
    if (
      (authStarted || isPolling) &&
      integrationQuery.data?.isConnected &&
      wasConnectedOnOpenRef.current === false
    ) {
      handleAuthSuccess()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStarted, isPolling, integrationQuery.data?.isConnected])

  // Update flow state from poll results
  useEffect(() => {
    if (!pollStatusQuery.data) return

    // Auto-complete: localhost callback captured and exchanged the token
    if (pollStatusQuery.data.state === "success") {
      handleAuthSuccess()
      return
    }

    if (pollStatusQuery.data.manualUrl) {
      setSavedManualUrl(pollStatusQuery.data.manualUrl)
    }

    if (flowState.step === "waiting_url" && pollStatusQuery.data.oauthUrl) {
      setSavedOauthUrl(pollStatusQuery.data.oauthUrl)
      setFlowState({
        step: "has_url",
        sandboxId: flowState.sandboxId,
        oauthUrl: pollStatusQuery.data.oauthUrl,
        sandboxUrl: flowState.sandboxUrl,
        sessionId: flowState.sessionId,
      })
    } else if (
      (flowState.step === "waiting_url" || flowState.step === "has_url") &&
      pollStatusQuery.data.state === "error" &&
      !integrationQuery.data?.isConnected
    ) {
      setFlowState({
        step: "error",
        message: pollStatusQuery.data.error || "Failed to get OAuth URL",
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollStatusQuery.data, integrationQuery.data?.isConnected])

  // Auto-open browser when URL is ready (matches onboarding page behavior)
  useEffect(() => {
    if (flowState.step === "has_url" && !urlOpenedRef.current) {
      urlOpenedRef.current = true
      setUrlOpened(true)
    }
  }, [flowState.step])

  // Show manual input after 12s as a safety net
  useEffect(() => {
    if (!urlOpened) return
    const timer = setTimeout(() => setShowManualInput(true), 12000)
    return () => clearTimeout(timer)
  }, [urlOpened])

  // Reset state when modal closes
  useEffect(() => {
    if (!open) {
      setFlowState({ step: "idle" })
      setAuthCode("")
      setUserClickedConnect(false)
      setUrlOpened(false)
      setSavedOauthUrl(null)
      setSavedManualUrl(null)
      setShowManualInput(false)
      setAuthStarted(false)
      urlOpenedRef.current = false
      didAutoStartForOpenRef.current = false
      wasConnectedOnOpenRef.current = null
    }
  }, [open])

  // Helper to trigger retry after successful OAuth
  const triggerAuthRetry = () => {
    const pending = appStore.get(pendingAuthRetryMessageAtom)
    if (pending && pending.provider === "claude-code") {
      console.log("[ClaudeLoginModal] OAuth success - triggering retry for subChatId:", pending.subChatId)
      appStore.set(pendingAuthRetryMessageAtom, { ...pending, readyToRetry: true })
    }
  }

  // Helper to clear pending retry (on cancel/close without success)
  const clearPendingRetry = () => {
    const pending = appStore.get(pendingAuthRetryMessageAtom)
    if (
      pending &&
      pending.provider === "claude-code" &&
      !pending.readyToRetry
    ) {
      console.log("[ClaudeLoginModal] Modal closed without success - clearing pending retry")
      appStore.set(pendingAuthRetryMessageAtom, null)
    }
  }

  const handleAuthSuccess = () => {
    triggerAuthRetry()
    setAnthropicOnboardingCompleted(true)
    setOpen(false)
    void Promise.allSettled([
      trpcUtils.anthropicAccounts.list.invalidate(),
      trpcUtils.anthropicAccounts.getActive.invalidate(),
      trpcUtils.claudeCode.getIntegration.invalidate(),
    ])
  }

  // Check if the code looks like a valid Claude auth code (format: XXX#YYY)
  const isValidCodeFormat = (code: string) => {
    const trimmed = code.trim()
    return trimmed.length > 50 && trimmed.includes("#")
  }

  const handleConnectClick = useCallback(async () => {
    setUserClickedConnect(true)

    if (flowState.step === "has_url") {
      // URL already ready — just re-open it
      openOAuthUrlMutation.mutate(flowState.oauthUrl)
      return
    }

    if (flowState.step === "idle" || flowState.step === "error") {
      urlOpenedRef.current = false
      setUrlOpened(false)
      setShowManualInput(false)
      setFlowState({ step: "starting" })
      try {
        const result = await startAuthMutation.mutateAsync()
        setAuthStarted(true)
        if (result.autoUrl) {
          setSavedOauthUrl(result.autoUrl)
          if (result.manualUrl) setSavedManualUrl(result.manualUrl)
          setFlowState({
            step: "has_url",
            sandboxId: result.sandboxId,
            sandboxUrl: result.sandboxUrl,
            sessionId: result.sessionId,
            oauthUrl: result.autoUrl,
          })
        } else {
          setFlowState({
            step: "waiting_url",
            sandboxId: result.sandboxId,
            sandboxUrl: result.sandboxUrl,
            sessionId: result.sessionId,
          })
        }
      } catch (err) {
        setFlowState({
          step: "error",
          message: err instanceof Error ? err.message : "Failed to start authentication",
        })
      }
    }
  }, [flowState, openOAuthUrlMutation, startAuthMutation])

  useEffect(() => {
    if (
      !open ||
      !autoStartAuth ||
      flowState.step !== "idle" ||
      didAutoStartForOpenRef.current
    ) {
      return
    }

    didAutoStartForOpenRef.current = true
    void handleConnectClick()
  }, [autoStartAuth, flowState.step, handleConnectClick, open])

  const submitCode = async (code: string) => {
    if (submitCodeMutation.isPending) return
    if (!code.trim() || flowState.step !== "has_url") return

    const { sandboxUrl, sessionId } = flowState
    setFlowState({ step: "submitting" })

    try {
      await submitCodeMutation.mutateAsync({
        sandboxUrl,
        sessionId,
        code: code.trim(),
      })
      handleAuthSuccess()
    } catch (err) {
      setFlowState({
        step: "error",
        message: err instanceof Error ? err.message : "Failed to submit code",
      })
    }
  }

  const handleSubmitCode = () => submitCode(authCode)

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setAuthCode(value)

    // Auto-submit if the pasted value looks like a valid auth code
    if (isValidCodeFormat(value) && flowState.step === "has_url") {
      setTimeout(() => submitCode(value), 100)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && authCode.trim()) {
      handleSubmitCode()
    }
  }

  const handleOpenFallbackUrl = () => {
    const url = savedManualUrl ?? savedOauthUrl
    if (url) {
      openOAuthUrlMutation.mutate(url)
    }
    setShowManualInput(true)
  }

  const handleOpenModelsSettings = () => {
    clearPendingRetry()
    setSettingsActiveTab("models" as SettingsTab)
    setSettingsOpen(true)
    setOpen(false)
  }

  const isLoadingAuth =
    flowState.step === "starting" || flowState.step === "waiting_url"
  const isSubmitting = flowState.step === "submitting"

  // Handle modal open/close - clear pending retry if closing without success
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      clearPendingRetry()
    }
    setOpen(newOpen)
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="w-[380px] p-6">
        {/* Close button */}
        <AlertDialogCancel className="absolute right-4 top-4 h-6 w-6 p-0 border-0 bg-transparent hover:bg-muted rounded-sm opacity-70 hover:opacity-100">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </AlertDialogCancel>

        <div className="space-y-8">
          {/* Header with dual icons */}
          <div className="text-center space-y-4">
            <div className="flex items-center justify-center gap-2 p-2 mx-auto w-max rounded-full border border-border">
              <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center">
                <Logo className="w-5 h-5" fill="white" />
              </div>
              <div className="w-10 h-10 rounded-full bg-[#D97757] flex items-center justify-center">
                <ClaudeCodeIcon className="w-6 h-6 text-white" />
              </div>
            </div>
            <div className="space-y-1">
              <h1 className="text-base font-semibold tracking-tight">
                Claude Code
              </h1>
              <p className="text-sm text-muted-foreground">
                Connect your Claude Code subscription
              </p>
            </div>
          </div>

          {/* Content */}
          <div className="space-y-6">
            {/* Connect Button */}
            {!urlOpened && flowState.step !== "has_url" && flowState.step !== "error" && (
              <Button
                onClick={handleConnectClick}
                className="w-full"
                disabled={userClickedConnect && isLoadingAuth}
              >
                {userClickedConnect && isLoadingAuth ? (
                  <IconSpinner className="h-4 w-4" />
                ) : (
                  "Connect"
                )}
              </Button>
            )}

            {/* Waiting for browser OAuth to complete */}
            {(urlOpened || flowState.step === "has_url") && flowState.step !== "submitting" && (
              <div className="space-y-4 flex flex-col items-center w-full">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <IconSpinner className="h-4 w-4 shrink-0" />
                  <span>Complete sign-in in the browser window…</span>
                </div>

                {!showManualInput && (
                  <p className="text-xs text-muted-foreground text-center">
                    Browser showed an error?{" "}
                    <button
                      onClick={handleOpenFallbackUrl}
                      className="text-primary hover:underline"
                    >
                      Click here for a code instead
                    </button>
                  </p>
                )}

                {showManualInput && (
                  <div className="space-y-3 w-full">
                    <p className="text-xs text-muted-foreground text-center">
                      Paste the code from the browser, or{" "}
                      <button onClick={handleOpenFallbackUrl} className="text-primary hover:underline">
                        open sign-in again
                      </button>
                      {" "}to get one.
                    </p>
                    <Input
                      value={authCode}
                      onChange={handleCodeChange}
                      onKeyDown={handleKeyDown}
                      placeholder="Paste your authentication code here…"
                      className="font-mono text-center text-xs"
                      autoFocus
                      disabled={isSubmitting}
                    />
                    <Button
                      onClick={handleSubmitCode}
                      className="w-full"
                      disabled={!authCode.trim() || isSubmitting}
                    >
                      {isSubmitting ? <IconSpinner className="h-4 w-4" /> : "Continue"}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {flowState.step === "submitting" && (
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <IconSpinner className="h-4 w-4 shrink-0" />
                <span>Signing in…</span>
              </div>
            )}

            {/* Error State */}
            {flowState.step === "error" && (
              <div className="space-y-4">
                <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
                  <p className="text-sm text-destructive">{flowState.message}</p>
                </div>
                <Button
                  variant="secondary"
                  onClick={handleConnectClick}
                  className="w-full"
                >
                  Try Again
                </Button>
              </div>
            )}

            {!hideCustomModelSettingsLink && (
              <div className="text-center !mt-2">
                <button
                  type="button"
                  onClick={handleOpenModelsSettings}
                  className="text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
                >
                  Set a custom model in Settings
                </button>
              </div>
            )}
          </div>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
