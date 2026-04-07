"use client"

import { useSetAtom } from "jotai"
import { ChevronLeft } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { ClaudeCodeIcon, IconSpinner } from "../../components/ui/icons"
import { Input } from "../../components/ui/input"
import { Logo } from "../../components/ui/logo"
import {
  anthropicOnboardingCompletedAtom,
  billingMethodAtom,
} from "../../lib/atoms"
import { trpc } from "../../lib/trpc"

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

export function AnthropicOnboardingPage() {
  const [flowState, setFlowState] = useState<AuthFlowState>({ step: "idle" })
  const [authCode, setAuthCode] = useState("")
  const [userClickedConnect, setUserClickedConnect] = useState(false)
  const [urlOpened, setUrlOpened] = useState(false)
  const [savedOauthUrl, setSavedOauthUrl] = useState<string | null>(null)
  const [savedManualUrl, setSavedManualUrl] = useState<string | null>(null)
  const [showManualInput, setShowManualInput] = useState(false)
  const [manualCode, setManualCode] = useState("")
  const urlOpenedAtRef = useRef<number | null>(null)
  const [ignoredExistingToken, setIgnoredExistingToken] = useState(false)
  const [isUsingExistingToken, setIsUsingExistingToken] = useState(false)
  const [existingTokenError, setExistingTokenError] = useState<string | null>(null)
  const urlOpenedRef = useRef(false)
  const setAnthropicOnboardingCompleted = useSetAtom(
    anthropicOnboardingCompletedAtom
  )
  const setBillingMethod = useSetAtom(billingMethodAtom)

  const handleBack = () => {
    setBillingMethod(null)
  }

  const formatTokenPreview = (token: string) => {
    const trimmed = token.trim()
    if (trimmed.length <= 16) return trimmed
    return `${trimmed.slice(0, 19)}...${trimmed.slice(-6)}`
  }

  // tRPC mutations
  const startAuthMutation = trpc.claudeCode.startAuth.useMutation()
  const submitCodeMutation = trpc.claudeCode.submitCode.useMutation()
  const openOAuthUrlMutation = trpc.claudeCode.openOAuthUrl.useMutation()
  const importSystemTokenMutation = trpc.claudeCode.importSystemToken.useMutation()
  // Disabled: importing CLI token is broken — access tokens expire in ~8 hours
  // and we don't store the refresh token. Always use sandbox OAuth flow instead.
  // const existingTokenQuery = trpc.claudeCode.getSystemToken.useQuery()
  // const existingToken = existingTokenQuery.data?.token ?? null
  const existingToken = null
  const hasExistingToken = false
  const checkedExistingToken = true
  const shouldOfferExistingToken = false

  // Poll for OAuth URL and auto-completion (localhost callback)
  const isPolling = flowState.step === "waiting_url" || flowState.step === "has_url"
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

  // Track whether auth was started so integrationQuery keeps running even after error
  const [authStarted, setAuthStarted] = useState(false)

  // Always poll getIntegration once auth has started — belt-and-suspenders for success detection.
  // We intentionally keep polling even in error state in case the token was stored before the error fired.
  const integrationQuery = trpc.claudeCode.getIntegration.useQuery(undefined, {
    enabled: authStarted || isPolling,
    refetchInterval: isPolling || authStarted ? 1500 : false,
  })

  // Auth is NOT auto-started — user must click "Connect" to begin the flow.
  // This prevents unexpected browser popups on first load.

  // Complete onboarding as soon as the token is stored in the DB — belt-and-suspenders.
  // Only fires after auth has been started (so we don't complete on stale data from a previous session).
  useEffect(() => {
    if ((authStarted || isPolling) && integrationQuery.data?.isConnected) {
      setAnthropicOnboardingCompleted(true)
    }
  }, [authStarted, isPolling, integrationQuery.data?.isConnected, setAnthropicOnboardingCompleted])

  // Show manual input after 12s as a safety net, in case user already has a code
  useEffect(() => {
    if (!urlOpened) return
    const timer = setTimeout(() => setShowManualInput(true), 12000)
    return () => clearTimeout(timer)
  }, [urlOpened])

  // Update flow state from poll results
  useEffect(() => {
    if (!pollStatusQuery.data) return

    // Auto-complete: localhost callback captured the code and exchanged the token
    if (pollStatusQuery.data.state === "success") {
      setAnthropicOnboardingCompleted(true)
      return
    }

    // Save manual URL whenever we get it
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
      // Only show error if we haven't already stored the token successfully
      setFlowState({
        step: "error",
        message: pollStatusQuery.data.error || "Failed to get OAuth URL",
      })
    }
  }, [pollStatusQuery.data, flowState, integrationQuery.data?.isConnected, setAnthropicOnboardingCompleted])

  // Browser is opened automatically in startAuth — mark as opened when we reach has_url
  useEffect(() => {
    if (flowState.step === "has_url" && !urlOpenedRef.current) {
      urlOpenedRef.current = true
      setUrlOpened(true)
    }
  }, [flowState.step])

  // Check if the code looks like a valid Claude auth code (format: XXX#YYY)
  const isValidCodeFormat = (code: string) => {
    const trimmed = code.trim()
    return trimmed.length > 50 && trimmed.includes("#")
  }

  const handleConnectClick = async () => {
    setUserClickedConnect(true)

    if (flowState.step === "has_url") {
      // Browser was already opened — just mark state
      urlOpenedRef.current = true
      setUrlOpened(true)
      return
    }

    // Start auth for idle, error, or any non-active state
    if (flowState.step === "idle" || flowState.step === "error") {
      urlOpenedRef.current = false
      setUrlOpened(false)
      setFlowState({ step: "starting" })
      try {
        const result = await startAuthMutation.mutateAsync()
        setAuthStarted(true)
        setFlowState({
          step: "waiting_url",
          sandboxId: result.sandboxId,
          sandboxUrl: result.sandboxUrl,
          sessionId: result.sessionId,
        })
      } catch (err) {
        setFlowState({
          step: "error",
          message:
            err instanceof Error ? err.message : "Failed to start authentication",
        })
      }
    }
  }

  const handleUseExistingToken = async () => {
    if (!hasExistingToken || isUsingExistingToken) return

    setIsUsingExistingToken(true)
    setExistingTokenError(null)

    try {
      await importSystemTokenMutation.mutateAsync()
      setAnthropicOnboardingCompleted(true)
    } catch (err) {
      setExistingTokenError(
        err instanceof Error ? err.message : "Failed to use existing token"
      )
      setIsUsingExistingToken(false)
    }
  }

  const handleRejectExistingToken = () => {
    setIgnoredExistingToken(true)
    setExistingTokenError(null)
    handleConnectClick()
  }

  // Submit code - reusable for both auto-submit and manual Enter
  const submitCode = async (code: string) => {
    if (submitCodeMutation.isPending) return // FIX: prevent double-submit race condition
    if (!code.trim() || flowState.step !== "has_url") return

    const { sandboxUrl, sessionId } = flowState
    setFlowState({ step: "submitting" })

    try {
      await submitCodeMutation.mutateAsync({
        sandboxUrl,
        sessionId,
        code: code.trim(),
      })
      // Success - mark onboarding as completed
      setAnthropicOnboardingCompleted(true)
    } catch (err) {
      setFlowState({
        step: "error",
        message: err instanceof Error ? err.message : "Failed to submit code",
      })
    }
  }

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setAuthCode(value)

    // Auto-submit if the pasted value looks like a valid auth code
    if (isValidCodeFormat(value) && flowState.step === "has_url") {
      // Small delay to let the UI update before submitting
      setTimeout(() => submitCode(value), 100)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && authCode.trim()) {
      submitCode(authCode)
    }
  }

  const handleOpenManualUrl = () => {
    const url = savedManualUrl ?? savedOauthUrl
    if (url) {
      openOAuthUrlMutation.mutate(url)
    }
    setShowManualInput(true)
  }

  const handleManualCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setManualCode(value)
    if (isValidCodeFormat(value) && flowState.step === "has_url") {
      setTimeout(() => submitCode(value), 100)
    }
  }

  const handleManualCodeKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && manualCode.trim()) {
      submitCode(manualCode)
    }
  }

  const isLoadingAuth =
    flowState.step === "starting" || flowState.step === "waiting_url"
  const isSubmitting = flowState.step === "submitting"

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-background select-none">
      {/* Draggable title bar area */}
      <div
        className="fixed top-0 left-0 right-0 h-10"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      {/* Back button - fixed in top left corner below traffic lights */}
      <button
        onClick={handleBack}
        className="fixed top-12 left-4 flex items-center justify-center h-8 w-8 rounded-full hover:bg-foreground/5 transition-colors"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>

      <div className="w-full max-w-[440px] space-y-8 px-4">
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
              Connect Claude Code
            </h1>
            <p className="text-sm text-muted-foreground">
              Connect your Claude Code subscription to get started
            </p>
          </div>
        </div>

        {/* Content */}
        <div className="space-y-6 flex flex-col items-center">
          {/* Existing token prompt */}
          {shouldOfferExistingToken && flowState.step === "idle" && (
            <div className="space-y-4 w-full">
              <div className="p-4 bg-muted/50 border border-border rounded-lg">
                <p className="text-sm font-medium">
                  Existing Claude Code credentials found
                </p>
                {existingToken && (
                  <pre className="mt-2 px-2.5 py-2 text-xs text-foreground whitespace-pre-wrap break-words font-mono bg-background/60 rounded border border-border/60">
                    {formatTokenPreview(existingToken)}
                  </pre>
                )}
              </div>
              {existingTokenError && (
                <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                  <p className="text-sm text-destructive">
                    {existingTokenError}
                  </p>
                </div>
              )}
              <div className="flex w-full gap-2">
                <button
                  onClick={handleRejectExistingToken}
                  disabled={isUsingExistingToken}
                  className="h-8 px-3 flex-1 bg-muted text-foreground rounded-lg text-sm font-medium transition-[background-color,transform] duration-150 hover:bg-muted/80 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                >
                  Auth with Anthropic
                </button>
                <button
                  onClick={handleUseExistingToken}
                  disabled={isUsingExistingToken}
                  className="h-8 px-3 flex-1 bg-primary text-primary-foreground rounded-lg text-sm font-medium transition-[background-color,transform] duration-150 hover:bg-primary/90 active:scale-[0.97] shadow-[0_0_0_0.5px_rgb(23,23,23),inset_0_0_0_1px_rgba(255,255,255,0.14)] dark:shadow-[0_0_0_0.5px_rgb(23,23,23),inset_0_0_0_1px_rgba(255,255,255,0.14)] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                >
                  {isUsingExistingToken ? (
                    <IconSpinner className="h-4 w-4" />
                  ) : (
                    "Use existing token"
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Connect Button - visible until browser opens or error shown */}
          {!urlOpened &&
            flowState.step !== "has_url" &&
            flowState.step !== "error" && (
              <button
                onClick={handleConnectClick}
                disabled={userClickedConnect && isLoadingAuth}
                className="h-8 px-4 min-w-[85px] bg-primary text-primary-foreground rounded-lg text-sm font-medium transition-[background-color,transform] duration-150 hover:bg-primary/90 active:scale-[0.97] shadow-[0_0_0_0.5px_rgb(23,23,23),inset_0_0_0_1px_rgba(255,255,255,0.14)] dark:shadow-[0_0_0_0.5px_rgb(23,23,23),inset_0_0_0_1px_rgba(255,255,255,0.14)] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
              >
                {userClickedConnect && isLoadingAuth ? (
                  <IconSpinner className="h-4 w-4" />
                ) : (
                  "Connect"
                )}
              </button>
            )}

          {/* Waiting for browser OAuth to complete */}
          {(urlOpened || flowState.step === "has_url") && (
            <div className="space-y-4 flex flex-col items-center w-full">
              {/* Always show spinner while waiting for auto-complete */}
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <IconSpinner className="h-4 w-4 shrink-0" />
                <span>Complete sign-in in the browser window…</span>
              </div>

              {/* Immediate manual link — browser error or redirect failed */}
              {!showManualInput && (
                <p className="text-xs text-muted-foreground text-center">
                  Browser showed an error?{" "}
                  <button
                    onClick={handleOpenManualUrl}
                    className="text-primary hover:underline"
                  >
                    Click here for a code instead
                  </button>
                </p>
              )}

              {/* Manual code input — shown when user asks for it or after 12s */}
              {showManualInput && (
                <div className="space-y-3 w-full">
                  <p className="text-xs text-muted-foreground text-center">
                    Paste the code from the browser, or{" "}
                    <button onClick={handleOpenManualUrl} className="text-primary hover:underline">
                      open sign-in again
                    </button>
                    {" "}to get one.
                  </p>
                  <Input
                    value={manualCode}
                    onChange={handleManualCodeChange}
                    onKeyDown={handleManualCodeKeyDown}
                    placeholder="Paste your authentication code here…"
                    className="font-mono text-center text-xs"
                    autoFocus
                    disabled={isSubmitting}
                  />
                  <button
                    onClick={() => submitCode(manualCode)}
                    disabled={!manualCode.trim() || isSubmitting || flowState.step !== "has_url"}
                    className="w-full h-8 px-3 bg-primary text-primary-foreground rounded-lg text-sm font-medium transition-[background-color,transform] duration-150 hover:bg-primary/90 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                  >
                    {isSubmitting ? <IconSpinner className="h-4 w-4" /> : "Continue"}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Error State */}
          {flowState.step === "error" && (
            <div className="space-y-4">
              <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
                <p className="text-sm text-destructive">{flowState.message}</p>
              </div>
              <button
                onClick={handleConnectClick}
                className="w-full h-8 px-3 bg-muted text-foreground rounded-lg text-sm font-medium transition-[background-color,transform] duration-150 hover:bg-muted/80 active:scale-[0.97] flex items-center justify-center"
              >
                Try Again
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
