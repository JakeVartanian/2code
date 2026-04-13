import { Provider as JotaiProvider, useAtomValue, useSetAtom } from "jotai"
import { ThemeProvider, useTheme } from "next-themes"
import { Component, useEffect, useMemo } from "react"
import type { ErrorInfo, ReactNode } from "react"
import { Toaster } from "sonner"
import { TooltipProvider } from "./components/ui/tooltip"
import { TRPCProvider } from "./contexts/TRPCProvider"
import { WindowProvider, getInitialWindowParams } from "./contexts/WindowContext"
import { selectedProjectAtom, selectedAgentChatIdAtom } from "./features/agents/atoms"
import { useAgentSubChatStore } from "./features/agents/stores/sub-chat-store"
import { AgentsLayout } from "./features/layout/agents-layout"
import {
  AnthropicOnboardingPage,
  ApiKeyOnboardingPage,
  BillingMethodPage,
  SelectRepoPage,
} from "./features/onboarding"
import {
  anthropicOnboardingCompletedAtom,
  apiKeyOnboardingCompletedAtom,
  billingMethodAtom,
  billingMethodConfirmedAtom,
} from "./lib/atoms"
import { Logo } from "./components/ui/logo"
import { appStore } from "./lib/jotai-store"
import { VSCodeThemeProvider } from "./lib/themes/theme-provider"
import { trpc } from "./lib/trpc"
import { SecureApiKeysSyncer } from "./lib/secure-api-keys-syncer"
import { CrashRecoveryBanner } from "./features/crash-recovery/crash-recovery-banner"

/**
 * Top-level error boundary to prevent white-screen crashes.
 * Catches any unhandled rendering error and shows a recovery UI.
 */
class AppErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[AppErrorBoundary] Uncaught render error:", error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          background: "#09090b",
          color: "#fafafa",
          gap: "16px",
          padding: "24px",
          textAlign: "center",
        }}>
          <h1 style={{ fontSize: "18px", fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ fontSize: "14px", color: "#71717a", maxWidth: "400px" }}>
            {this.state.error?.message || "An unexpected error occurred"}
          </p>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null })
              window.location.reload()
            }}
            style={{
              padding: "8px 16px",
              borderRadius: "6px",
              border: "1px solid #27272a",
              background: "#18181b",
              color: "#fafafa",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            Reload App
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * Custom Toaster that adapts to theme
 */
function ThemedToaster() {
  const { resolvedTheme } = useTheme()

  return (
    <Toaster
      position="bottom-right"
      theme={resolvedTheme as "light" | "dark" | "system"}
      closeButton
    />
  )
}

/**
 * Full-screen spinner shown while the main process finishes initializing.
 * Prevents any DB-touching tRPC calls from firing before the main process is ready.
 */
function AppLoadingScreen() {
  return (
    <div className="h-screen w-screen flex items-center justify-center bg-background">
      <div className="animate-spin rounded-full p-2">
        <Logo className="w-8 h-8 opacity-60" />
      </div>
    </div>
  )
}

/**
 * Readiness gate — renders a spinner until the main process is fully initialized.
 * Separate component so AppContent's hooks always run in the same order.
 */
function AppReadyGate() {
  const appStatusQuery = trpc.app.status.useQuery(undefined, {
    refetchInterval: (query) => (query.state.data?.ready ? false : 300),
    retry: true,
    retryDelay: 300,
  })

  if (!appStatusQuery.data?.ready) {
    return <AppLoadingScreen />
  }

  return <AppContent />
}

/**
 * Main content router - decides which page to show based on onboarding state
 */
function AppContent() {

  const billingMethod = useAtomValue(billingMethodAtom)
  const setBillingMethod = useSetAtom(billingMethodAtom)
  const billingMethodConfirmed = useAtomValue(billingMethodConfirmedAtom)
  const anthropicOnboardingCompleted = useAtomValue(
    anthropicOnboardingCompletedAtom
  )
  const setAnthropicOnboardingCompleted = useSetAtom(anthropicOnboardingCompletedAtom)
  const apiKeyOnboardingCompleted = useAtomValue(apiKeyOnboardingCompletedAtom)
  const setApiKeyOnboardingCompleted = useSetAtom(apiKeyOnboardingCompletedAtom)
  const selectedProject = useAtomValue(selectedProjectAtom)
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom)
  const { setActiveSubChat, addToOpenSubChats, setChatId } = useAgentSubChatStore()

  // Apply initial window params (chatId/subChatId) when opening via "Open in new window"
  useEffect(() => {
    const params = getInitialWindowParams()
    if (params.chatId) {
      console.log("[App] Opening chat from window params:", params.chatId, params.subChatId)
      setSelectedChatId(params.chatId)
      setChatId(params.chatId)
      if (params.subChatId) {
        addToOpenSubChats(params.subChatId)
        setActiveSubChat(params.subChatId)
      }
    }
  }, [setSelectedChatId, setChatId, addToOpenSubChats, setActiveSubChat])

  // Claim the initially selected chat to prevent duplicate windows.
  // For new windows opened via "Open in new window", the chat is pre-claimed by main process.
  // For restored windows (persisted localStorage), we need to claim here.
  // Read atom directly from store to avoid stale closure with empty deps.
  useEffect(() => {
    if (!window.desktopApi?.claimChat) return
    const currentChatId = appStore.get(selectedAgentChatIdAtom)
    if (!currentChatId) return
    window.desktopApi.claimChat(currentChatId).then((result) => {
      if (!result.ok) {
        // Another window already has this chat — clear our selection
        setSelectedChatId(null)
      }
    })
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Check if user has existing CLI config (API key or proxy)
  // Based on PR #29 by @sa4hnd
  const { data: cliConfig, isLoading: isLoadingCliConfig } =
    trpc.claudeCode.hasExistingCliConfig.useQuery()

  // Check if Claude Code is already connected in the DB (active account or legacy credentials)
  const { data: claudeCodeIntegration } = trpc.claudeCode.getIntegration.useQuery()

  // Migration: If user already completed Anthropic onboarding but has no billing method set,
  // automatically set it to "claude-subscription" (legacy users before billing method was added)
  useEffect(() => {
    if (!billingMethod && anthropicOnboardingCompleted) {
      setBillingMethod("claude-subscription")
    }
  }, [billingMethod, anthropicOnboardingCompleted, setBillingMethod])

  // Auto-skip onboarding if user has existing CLI config (API key or proxy)
  // This allows users with ANTHROPIC_API_KEY to use the app without OAuth
  useEffect(() => {
    if (cliConfig?.hasConfig && !billingMethod) {
      console.log("[App] Detected existing CLI config, auto-completing onboarding")
      setBillingMethod("api-key")
      setApiKeyOnboardingCompleted(true)
    }
  }, [cliConfig?.hasConfig, billingMethod, setBillingMethod, setApiKeyOnboardingCompleted])

  // Auto-skip onboarding if DB already has a connected Claude Code account.
  // This handles cases where localStorage was cleared (new build, reset) but the DB wasn't —
  // the user is already authenticated and shouldn't have to re-connect.
  useEffect(() => {
    if (claudeCodeIntegration?.isConnected && !anthropicOnboardingCompleted) {
      console.log("[App] DB has active Claude Code account, auto-completing onboarding")
      setBillingMethod("claude-subscription")
      setAnthropicOnboardingCompleted(true)
    }
  }, [claudeCodeIntegration?.isConnected, anthropicOnboardingCompleted, setBillingMethod, setAnthropicOnboardingCompleted])

  // Fetch projects to validate selectedProject exists
  const { data: projects, isLoading: isLoadingProjects } =
    trpc.projects.list.useQuery()

  // Validated project - only valid if exists in DB
  const validatedProject = useMemo(() => {
    if (!selectedProject) return null
    // While loading, trust localStorage value to prevent flicker
    if (isLoadingProjects) return selectedProject
    // After loading, validate against DB
    if (!projects) return null
    const exists = projects.some((p) => p.id === selectedProject.id)
    return exists ? selectedProject : null
  }, [selectedProject, projects, isLoadingProjects])

  // Determine which page to show:
  // 1. No billing method selected -> BillingMethodPage
  // 1b. Billing method is claude-subscription but onboarding not complete AND user hasn't
  //     confirmed billing this session -> BillingMethodPage (handles stale localStorage on cold start)
  // 2. Claude subscription selected but not completed -> AnthropicOnboardingPage
  // 3. API key or custom model selected but not completed -> ApiKeyOnboardingPage
  // 4. No valid project selected -> SelectRepoPage
  // 5. Otherwise -> AgentsLayout
  if (!billingMethod || (billingMethod === "claude-subscription" && !anthropicOnboardingCompleted && !billingMethodConfirmed)) {
    return <BillingMethodPage />
  }

  if (billingMethod === "claude-subscription" && !anthropicOnboardingCompleted) {
    return <AnthropicOnboardingPage />
  }

  if (
    (billingMethod === "api-key" || billingMethod === "custom-model") &&
    !apiKeyOnboardingCompleted
  ) {
    return <ApiKeyOnboardingPage />
  }

  if (!validatedProject && !isLoadingProjects) {
    return <SelectRepoPage />
  }

  return (
    <>
      <SecureApiKeysSyncer />
      <AgentsLayout />
    </>
  )
}

export function App() {
  return (
    <AppErrorBoundary>
      <WindowProvider>
        <JotaiProvider store={appStore}>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
            <VSCodeThemeProvider>
              <TooltipProvider delayDuration={500}>
                <TRPCProvider>
                  <div
                    data-agents-page
                    className="h-screen w-screen bg-background text-foreground overflow-hidden"
                  >
                    <AppReadyGate />
                  </div>
                  <CrashRecoveryBanner />
                  <ThemedToaster />
                </TRPCProvider>
              </TooltipProvider>
            </VSCodeThemeProvider>
          </ThemeProvider>
        </JotaiProvider>
      </WindowProvider>
    </AppErrorBoundary>
  )
}
