import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { ChevronDown, MoreHorizontal, Plus, Trash2 } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  agentsLoginModalOpenAtom,
  claudeLoginModalConfigAtom,
  enabledOpenRouterModelsAtom,
  hiddenModelsAtom,
  openaiApiKeyAtom,
  openRouterApiKeyAtom,
  openRouterFreeOnlyAtom,
  openRouterModelsAtom,
  openRouterModelsLoadingAtom,
} from "../../../lib/atoms"
import { ClaudeCodeIcon, SearchIcon } from "../../ui/icons"
import { CLAUDE_MODELS } from "../../../features/agents/lib/models"
import { trpc } from "../../../lib/trpc"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu"
import { Input } from "../../ui/input"
import { Label } from "../../ui/label"
import { Switch } from "../../ui/switch"

// Hook to detect narrow screen
function useIsNarrowScreen(): boolean {
  const [isNarrow, setIsNarrow] = useState(false)

  useEffect(() => {
    const checkWidth = () => {
      setIsNarrow(window.innerWidth <= 768)
    }

    checkWidth()
    window.addEventListener("resize", checkWidth)
    return () => window.removeEventListener("resize", checkWidth)
  }, [])

  return isNarrow
}

// Account row component
function AccountRow({
  account,
  isActive,
  onSetActive,
  onRename,
  onRemove,
  isLoading,
}: {
  account: {
    id: string
    displayName: string | null
    email: string | null
    connectedAt: string | null
  }
  isActive: boolean
  onSetActive: () => void
  onRename: () => void
  onRemove: () => void
  isLoading: boolean
}) {
  return (
    <div className="flex items-center justify-between p-3 hover:bg-muted/50">
      <div className="flex items-center gap-3">
        <div>
          <div className="text-sm font-medium">
            {account.displayName || "Anthropic Account"}
          </div>
          {account.email && (
            <div className="text-xs text-muted-foreground">{account.email}</div>
          )}
          {!account.email && account.connectedAt && (
            <div className="text-xs text-muted-foreground">
              Connected{" "}
              {new Date(account.connectedAt).toLocaleDateString(undefined, {
                dateStyle: "short",
              })}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {!isActive && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onSetActive}
            disabled={isLoading}
          >
            Switch
          </Button>
        )}
        {isActive && (
          <Badge variant="secondary" className="text-xs">
            Active
          </Badge>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="h-7 w-7">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onRename}>Rename</DropdownMenuItem>
            <DropdownMenuItem
              className="data-[highlighted]:bg-red-500/15 data-[highlighted]:text-red-400"
              onClick={onRemove}
            >
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

// Anthropic accounts section component
function AnthropicAccountsSection() {
  const { data: accounts, isLoading: isAccountsLoading, refetch: refetchList } =
    trpc.anthropicAccounts.list.useQuery(undefined, {
      refetchOnMount: true,
      staleTime: 0,
    })
  const { data: activeAccount, refetch: refetchActive } =
    trpc.anthropicAccounts.getActive.useQuery(undefined, {
      refetchOnMount: true,
      staleTime: 0,
    })
  const { data: claudeCodeIntegration } = trpc.claudeCode.getIntegration.useQuery()
  const trpcUtils = trpc.useUtils()

  // Auto-migrate legacy account if needed
  const migrateLegacy = trpc.anthropicAccounts.migrateLegacy.useMutation({
    onSuccess: async () => {
      await refetchList()
      await refetchActive()
    },
  })

  // Trigger migration if: no accounts, not loading, has legacy connection, not already migrating
  useEffect(() => {
    if (
      !isAccountsLoading &&
      accounts?.length === 0 &&
      claudeCodeIntegration?.isConnected &&
      !migrateLegacy.isPending &&
      !migrateLegacy.isSuccess
    ) {
      migrateLegacy.mutate()
    }
  }, [isAccountsLoading, accounts, claudeCodeIntegration, migrateLegacy])

  const setActiveMutation = trpc.anthropicAccounts.setActive.useMutation({
    onSuccess: () => {
      trpcUtils.anthropicAccounts.list.invalidate()
      trpcUtils.anthropicAccounts.getActive.invalidate()
      trpcUtils.claudeCode.getIntegration.invalidate()
      toast.success("Account switched")
    },
    onError: (err) => {
      toast.error(`Failed to switch account: ${err.message}`)
    },
  })

  const renameMutation = trpc.anthropicAccounts.rename.useMutation({
    onSuccess: () => {
      trpcUtils.anthropicAccounts.list.invalidate()
      trpcUtils.anthropicAccounts.getActive.invalidate()
      toast.success("Account renamed")
    },
    onError: (err) => {
      toast.error(`Failed to rename account: ${err.message}`)
    },
  })

  const removeMutation = trpc.anthropicAccounts.remove.useMutation({
    onSuccess: () => {
      // Optimistically mark as disconnected NOW (synchronously) so the migrateLegacy
      // effect doesn't race: if list settles before getIntegration refetches, it would
      // see accounts=[] + isConnected=true (stale) and re-create the account from the
      // legacy table before we have a chance to clear it.
      trpcUtils.claudeCode.getIntegration.setData(undefined, {
        isConnected: false,
        connectedAt: null,
        accountId: null,
        displayName: null,
      })
      trpcUtils.anthropicAccounts.list.invalidate()
      trpcUtils.anthropicAccounts.getActive.invalidate()
      trpcUtils.claudeCode.getIntegration.invalidate()
      toast.success("Account removed")
    },
    onError: (err) => {
      toast.error(`Failed to remove account: ${err.message}`)
    },
  })

  const handleRename = (accountId: string, currentName: string | null) => {
    const newName = window.prompt(
      "Enter new name for this account:",
      currentName || "Anthropic Account"
    )
    if (newName && newName.trim()) {
      renameMutation.mutate({ accountId, displayName: newName.trim() })
    }
  }

  const handleRemove = (accountId: string, displayName: string | null) => {
    const confirmed = window.confirm(
      `Are you sure you want to remove "${displayName || "this account"}"? You will need to re-authenticate to use it again.`
    )
    if (confirmed) {
      removeMutation.mutate({ accountId })
    }
  }

  const isLoading =
    setActiveMutation.isPending ||
    renameMutation.isPending ||
    removeMutation.isPending

  // Don't show section if no accounts
  if (!isAccountsLoading && (!accounts || accounts.length === 0)) {
    return null
  }

  return (
    <div className="bg-background rounded-lg border border-border overflow-hidden divide-y divide-border">
        {isAccountsLoading ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            Loading accounts...
          </div>
        ) : (
          accounts?.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              isActive={activeAccount?.id === account.id}
              onSetActive={() => setActiveMutation.mutate({ accountId: account.id })}
              onRename={() => handleRename(account.id, account.displayName)}
              onRemove={() => handleRemove(account.id, account.displayName)}
              isLoading={isLoading}
            />
          ))
        )}
    </div>
  )
}

export function AgentsModelsTab() {
  const setClaudeLoginModalConfig = useSetAtom(claudeLoginModalConfigAtom)
  const setClaudeLoginModalOpen = useSetAtom(agentsLoginModalOpenAtom)
  const isNarrowScreen = useIsNarrowScreen()
  const { data: claudeCodeIntegration, isLoading: isClaudeCodeLoading } =
    trpc.claudeCode.getIntegration.useQuery()
  const isClaudeCodeConnected = claudeCodeIntegration?.isConnected

  const [storedOpenAIKey, setStoredOpenAIKey] = useAtom(openaiApiKeyAtom)
  const [openaiKey, setOpenaiKey] = useState(storedOpenAIKey)
  const setOpenAIKeyMutation = trpc.voice.setOpenAIKey.useMutation()
  const trpcUtils = trpc.useUtils()

  useEffect(() => {
    setOpenaiKey(storedOpenAIKey)
  }, [storedOpenAIKey])

  const handleClaudeCodeSetup = () => {
    setClaudeLoginModalConfig({
      hideCustomModelSettingsLink: true,
      autoStartAuth: true,
    })
    setClaudeLoginModalOpen(true)
  }

  const [hiddenModels, setHiddenModels] = useAtom(hiddenModelsAtom)

  const toggleModelVisibility = useCallback((modelId: string) => {
    setHiddenModels((prev) => {
      if (prev.includes(modelId)) {
        return prev.filter((id) => id !== modelId)
      }
      return [...prev, modelId]
    })
  }, [setHiddenModels])

  // OpenAI key handlers
  const trimmedOpenAIKey = openaiKey.trim()
  const canResetOpenAI = !!trimmedOpenAIKey

  const handleSaveOpenAI = async () => {
    if (trimmedOpenAIKey === storedOpenAIKey) return // No change
    if (trimmedOpenAIKey && !trimmedOpenAIKey.startsWith("sk-")) {
      toast.error("Invalid OpenAI API key format. Key should start with 'sk-'")
      return
    }

    try {
      await setOpenAIKeyMutation.mutateAsync({ key: trimmedOpenAIKey })
      setStoredOpenAIKey(trimmedOpenAIKey)
      // Invalidate voice availability check
      await trpcUtils.voice.isAvailable.invalidate()
      toast.success("OpenAI API key saved")
    } catch (err) {
      toast.error("Failed to save OpenAI API key")
    }
  }

  const handleResetOpenAI = async () => {
    try {
      await setOpenAIKeyMutation.mutateAsync({ key: "" })
      setStoredOpenAIKey("")
      setOpenaiKey("")
      await trpcUtils.voice.isAvailable.invalidate()
      toast.success("OpenAI API key removed")
    } catch (err) {
      toast.error("Failed to remove OpenAI API key")
    }
  }

  // All models list for the top section
  const allModels = useMemo(() => {
    return CLAUDE_MODELS.map((m) => ({ id: m.id, name: `${m.name} ${m.version}`, provider: "claude" as const }))
  }, [])

  const [modelSearch, setModelSearch] = useState("")
  const filteredModels = useMemo(() => {
    if (!modelSearch.trim()) return allModels
    const q = modelSearch.toLowerCase().trim()
    return allModels.filter((m) => m.name.toLowerCase().includes(q))
  }, [allModels, modelSearch])

  // OpenRouter state
  const [storedOpenRouterKey, setStoredOpenRouterKey] = useAtom(openRouterApiKeyAtom)
  const [openRouterFreeOnly, setOpenRouterFreeOnly] = useAtom(openRouterFreeOnlyAtom)
  const [openRouterKey, setOpenRouterKey] = useState(storedOpenRouterKey)
  const [openRouterModels, setOpenRouterModels] = useAtom(openRouterModelsAtom)
  const [isFetchingOpenRouterModels, setIsFetchingOpenRouterModels] = useAtom(openRouterModelsLoadingAtom)
  const [enabledOpenRouterModels, setEnabledOpenRouterModels] = useAtom(enabledOpenRouterModelsAtom)
  const [openRouterModelSearch, setOpenRouterModelSearch] = useState("")

  useEffect(() => {
    setOpenRouterKey(storedOpenRouterKey)
  }, [storedOpenRouterKey])

  const fetchOpenRouterModelsMutation = trpc.agents.fetchOpenRouterModels.useMutation({
    onSuccess: (models) => {
      setOpenRouterModels(models)
    },
    onError: (err) => {
      toast.error(err.message || "Failed to fetch OpenRouter models")
      setOpenRouterModels([])
    },
    onSettled: () => {
      setIsFetchingOpenRouterModels(false)
    },
  })

  const fetchOpenRouterModels = useCallback((apiKey: string) => {
    if (!apiKey.trim()) return
    setIsFetchingOpenRouterModels(true)
    fetchOpenRouterModelsMutation.mutate({ apiKey: apiKey.trim() })
  }, [setIsFetchingOpenRouterModels, fetchOpenRouterModelsMutation])

  const handleOpenRouterKeyBlur = useCallback(() => {
    const trimmed = openRouterKey.trim()
    if (trimmed === storedOpenRouterKey) return
    setStoredOpenRouterKey(trimmed)
    if (trimmed) {
      toast.success("OpenRouter API key saved")
      fetchOpenRouterModels(trimmed)
    }
  }, [openRouterKey, storedOpenRouterKey, setStoredOpenRouterKey, fetchOpenRouterModels])

  const handleRemoveOpenRouterKey = () => {
    setStoredOpenRouterKey("")
    setOpenRouterKey("")
    setOpenRouterModels([])
    toast.success("OpenRouter API key removed")
  }

  // Fetch OpenRouter models on mount only if we have a key but no cached models
  useEffect(() => {
    if (storedOpenRouterKey && openRouterModels.length === 0) {
      fetchOpenRouterModels(storedOpenRouterKey)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filteredOpenRouterModels = useMemo(() => {
    let models = openRouterModels
    if (openRouterFreeOnly) {
      models = models.filter((m) => m.isFree)
    }
    if (openRouterModelSearch.trim()) {
      const q = openRouterModelSearch.toLowerCase().trim()
      models = models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
    }
    return models
  }, [openRouterModels, openRouterFreeOnly, openRouterModelSearch])

  const toggleOpenRouterModel = useCallback((modelId: string) => {
    setEnabledOpenRouterModels((prev) => {
      if (prev.includes(modelId)) {
        return prev.filter((id) => id !== modelId)
      }
      return [...prev, modelId]
    })
  }, [setEnabledOpenRouterModels])

  const enabledCountInView = useMemo(() => {
    return filteredOpenRouterModels.filter((m) => enabledOpenRouterModels.includes(m.id)).length
  }, [filteredOpenRouterModels, enabledOpenRouterModels])

  const handleEnableAllVisible = useCallback(() => {
    setEnabledOpenRouterModels((prev) => {
      const newIds = filteredOpenRouterModels.map((m) => m.id).filter((id) => !prev.includes(id))
      return [...prev, ...newIds]
    })
  }, [filteredOpenRouterModels, setEnabledOpenRouterModels])

  const handleDisableAllVisible = useCallback(() => {
    const visibleIds = new Set(filteredOpenRouterModels.map((m) => m.id))
    setEnabledOpenRouterModels((prev) => prev.filter((id) => !visibleIds.has(id)))
  }, [filteredOpenRouterModels, setEnabledOpenRouterModels])

  const [isApiKeysOpen, setIsApiKeysOpen] = useState(false)

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      {!isNarrowScreen && (
        <div className="flex flex-col space-y-1.5 text-center sm:text-left">
          <h3 className="text-sm font-semibold text-foreground">Models</h3>
        </div>
      )}

      {/* ===== Models Section ===== */}
      <div className="space-y-2">
        <div className="bg-background rounded-lg border border-border overflow-hidden">
          {/* Search */}
          <div className="px-1.5 pt-1.5 pb-0.5">
            <div className="flex items-center gap-1.5 h-7 px-1.5 rounded-md bg-muted/50">
              <SearchIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                placeholder="Add or search model"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>

          {/* Model list */}
          <div className="divide-y divide-border">
            {filteredModels.map((m) => {
              const isEnabled = !hiddenModels.includes(m.id)
              return (
                <div
                  key={m.id}
                  className="flex items-center justify-between px-4 py-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{m.name}</span>
                    <ClaudeCodeIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <Switch
                    checked={isEnabled}
                    onCheckedChange={() => toggleModelVisibility(m.id)}
                  />
                </div>
              )
            })}
            {filteredModels.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                No models found
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ===== Accounts Section ===== */}
      <div className="space-y-2">
        {/* Anthropic Accounts */}
        <div className="pb-2 flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium text-foreground">
              Anthropic Accounts
            </h4>
            <p className="text-xs text-muted-foreground">
              Manage your Claude API accounts
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleClaudeCodeSetup}
            disabled={isClaudeCodeLoading}
          >
            <Plus className="h-3 w-3 mr-1" />
            {isClaudeCodeConnected ? "Add" : "Connect"}
          </Button>
        </div>

        <AnthropicAccountsSection />
      </div>

      {/* ===== API Keys Section (Collapsible) ===== */}
      <Collapsible open={isApiKeysOpen} onOpenChange={setIsApiKeysOpen}>
        <CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-foreground/80 transition-colors">
          <ChevronDown className={`h-4 w-4 transition-transform ${isApiKeysOpen ? "" : "-rotate-90"}`} />
          API Keys
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-3">
          {/* OpenAI API Key for Voice Input */}
          <div className="bg-background rounded-lg border border-border overflow-hidden">
            <div className="flex items-center justify-between gap-6 p-4">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <Label className="text-sm font-medium">OpenAI API Key</Label>
                  {canResetOpenAI && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleResetOpenAI}
                      disabled={setOpenAIKeyMutation.isPending}
                      className="h-5 px-1.5 text-xs text-muted-foreground hover:text-red-600 hover:bg-red-500/10"
                    >
                      Remove
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Required for voice transcription (Whisper API)
                </p>
              </div>
              <div className="flex-shrink-0 w-80">
                <Input
                  type="password"
                  value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                  onBlur={handleSaveOpenAI}
                  className="w-full"
                  placeholder="sk-..."
                />
              </div>
            </div>
          </div>

          {/* OpenRouter API Key */}
          <div className="space-y-2">
            <div className="bg-background rounded-lg border border-border overflow-hidden">
              <div className="flex items-center justify-between gap-6 p-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm font-medium">OpenRouter API Key</Label>
                    {storedOpenRouterKey && (
                      <Badge variant="secondary" className="text-xs">
                        Active
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Access all OpenRouter models (free &amp; paid)
                  </p>
                </div>
                <div className="flex-shrink-0 w-80 flex items-center gap-2">
                  <Input
                    type="password"
                    value={openRouterKey}
                    onChange={(e) => setOpenRouterKey(e.target.value)}
                    onBlur={() => void handleOpenRouterKeyBlur()}
                    className="w-full font-mono"
                    placeholder="sk-or-..."
                  />
                  {storedOpenRouterKey && (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={handleRemoveOpenRouterKey}
                      aria-label="Remove OpenRouter API key"
                      className="text-muted-foreground hover:text-red-600 hover:bg-red-500/10"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>

              {/* Free/Paid toggle */}
              {storedOpenRouterKey && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-border">
                  <div className="flex-1">
                    <Label className="text-sm font-medium">Free models only</Label>
                    <p className="text-xs text-muted-foreground">
                      Show only models with no cost
                    </p>
                  </div>
                  <Switch
                    checked={openRouterFreeOnly}
                    onCheckedChange={setOpenRouterFreeOnly}
                  />
                </div>
              )}
            </div>

            {/* OpenRouter models list */}
            {storedOpenRouterKey && (
              <div className="bg-background rounded-lg border border-border overflow-hidden">
                <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    OpenRouter Models
                  </span>
                  <div className="flex items-center gap-2">
                    {isFetchingOpenRouterModels ? (
                      <span className="text-xs text-muted-foreground">Loading…</span>
                    ) : (
                      <>
                        <span className="text-xs text-muted-foreground">
                          {enabledCountInView} / {filteredOpenRouterModels.length} enabled
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => fetchOpenRouterModels(storedOpenRouterKey)}
                          className="h-5 px-1.5 text-xs text-muted-foreground"
                          title="Refresh model list"
                        >
                          Refresh
                        </Button>
                      </>
                    )}
                    {filteredOpenRouterModels.length > 0 && (
                      enabledCountInView < filteredOpenRouterModels.length ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={handleEnableAllVisible}
                          className="h-5 px-1.5 text-xs text-muted-foreground"
                        >
                          Enable all
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={handleDisableAllVisible}
                          className="h-5 px-1.5 text-xs text-muted-foreground"
                        >
                          Disable all
                        </Button>
                      )
                    )}
                  </div>
                </div>

                {/* Note: only models with tool support are shown — Claude Code requires tool use */}
                <div className="px-4 py-1.5 text-xs text-muted-foreground border-b border-border">
                  Only showing models that support tool use (required by Claude Code)
                </div>

                {/* Search within OpenRouter models */}
                <div className="px-1.5 pt-1.5 pb-0.5 border-b border-border">
                  <div className="flex items-center gap-1.5 h-7 px-1.5 rounded-md bg-muted/50">
                    <SearchIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <input
                      value={openRouterModelSearch}
                      onChange={(e) => setOpenRouterModelSearch(e.target.value)}
                      placeholder="Search OpenRouter models..."
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    />
                  </div>
                </div>

                <div className="divide-y divide-border max-h-64 overflow-y-auto">
                  {filteredOpenRouterModels.length === 0 && !isFetchingOpenRouterModels ? (
                    <div className="px-4 py-3 text-xs text-muted-foreground">
                      {openRouterModels.length === 0
                        ? "No models loaded."
                        : openRouterModelSearch.trim()
                          ? "No models match your search."
                          : "No free models available."}
                    </div>
                  ) : (
                    filteredOpenRouterModels.map((m) => {
                      const isEnabled = enabledOpenRouterModels.includes(m.id)
                      return (
                        <div key={m.id} className="flex items-center justify-between px-4 py-2.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-sm truncate">{m.name}</span>
                            {m.isFree && (
                              <Badge variant="secondary" className="text-xs shrink-0">Free</Badge>
                            )}
                          </div>
                          <Switch
                            checked={isEnabled}
                            onCheckedChange={() => toggleOpenRouterModel(m.id)}
                          />
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
