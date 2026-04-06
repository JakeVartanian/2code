"use client"

import { ChevronRight, Zap } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../../../components/ui/command"
import { CheckIcon, ClaudeCodeIcon, IconChevronDown, ThinkingIcon } from "../../../components/ui/icons"
import { Switch } from "../../../components/ui/switch"
import { Button } from "../../../components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../components/ui/popover"
import { cn } from "../../../lib/utils"

export type AgentProviderId = "claude-code"

type ClaudeModelOption = {
  id: string
  name: string
  version: string
}

interface AgentModelSelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedAgentId: AgentProviderId
  onSelectedAgentIdChange: (provider: AgentProviderId) => void
  selectedModelLabel: string
  allowProviderSwitch?: boolean
  triggerClassName?: string
  contentClassName?: string
  onOpenModelsSettings?: () => void
  onContinueWithProvider?: (provider: AgentProviderId) => void
  claude: {
    models: ClaudeModelOption[]
    selectedModelId?: string
    onSelectModel: (modelId: string) => void
    hasCustomModelConfig: boolean
    isOffline: boolean
    ollamaModels: string[]
    selectedOllamaModel?: string
    recommendedOllamaModel?: string
    onSelectOllamaModel: (modelId: string) => void
    isConnected: boolean
    thinkingEnabled: boolean
    onThinkingChange: (enabled: boolean) => void
  }
}

type FlatModelItem =
  | { type: "claude"; model: ClaudeModelOption }
  | { type: "ollama"; modelName: string; isRecommended: boolean }
  | { type: "custom" }

export function AgentModelSelector({
  open,
  onOpenChange,
  selectedAgentId,
  onSelectedAgentIdChange,
  selectedModelLabel,
  allowProviderSwitch = true,
  triggerClassName,
  contentClassName,
  onOpenModelsSettings,
  onContinueWithProvider,
  claude,
}: AgentModelSelectorProps) {
  const [search, setSearch] = useState("")

  // Build flat list of all models
  const allModels = useMemo<FlatModelItem[]>(() => {
    const items: FlatModelItem[] = []

    if (claude.isOffline && claude.ollamaModels.length > 0) {
      for (const m of claude.ollamaModels) {
        items.push({
          type: "ollama",
          modelName: m,
          isRecommended: m === claude.recommendedOllamaModel,
        })
      }
    } else if (claude.hasCustomModelConfig) {
      items.push({ type: "custom" })
    } else {
      for (const m of claude.models) {
        items.push({ type: "claude", model: m })
      }
    }

    return items
  }, [claude])

  // Filter by search
  const filteredModels = useMemo(() => {
    if (!search.trim()) return allModels
    const q = search.toLowerCase().trim()
    return allModels.filter((item) => {
      switch (item.type) {
        case "claude":
          return (
            item.model.name.toLowerCase().includes(q) ||
            item.model.version.toLowerCase().includes(q) ||
            `${item.model.name} ${item.model.version}`.toLowerCase().includes(q)
          )
        case "ollama":
          return item.modelName.toLowerCase().includes(q)
        case "custom":
          return "custom model".includes(q)
      }
    })
  }, [allModels, search])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      onOpenChange(nextOpen)
      if (!nextOpen) {
        setSearch("")
      }
    },
    [onOpenChange],
  )

  const triggerIcon =
    claude.isOffline && claude.ollamaModels.length > 0 ? (
      <Zap className="h-4 w-4" />
    ) : (
      <ClaudeCodeIcon className="h-3.5 w-3.5" />
    )

  const isItemSelected = (item: FlatModelItem): boolean => {
    switch (item.type) {
      case "claude":
        return selectedAgentId === "claude-code" && claude.selectedModelId === item.model.id
      case "ollama":
        return selectedAgentId === "claude-code" && claude.selectedOllamaModel === item.modelName
      case "custom":
        return selectedAgentId === "claude-code"
    }
  }

  const handleItemClick = (item: FlatModelItem) => {
    switch (item.type) {
      case "claude":
        onSelectedAgentIdChange("claude-code")
        claude.onSelectModel(item.model.id)
        break
      case "ollama":
        onSelectedAgentIdChange("claude-code")
        claude.onSelectOllamaModel(item.modelName)
        break
      case "custom":
        onSelectedAgentIdChange("claude-code")
        break
    }
    handleOpenChange(false)
  }

  const getItemIcon = (item: FlatModelItem) => {
    switch (item.type) {
      case "claude":
        return <ClaudeCodeIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      case "ollama":
        return <Zap className="h-4 w-4 text-muted-foreground shrink-0" />
      case "custom":
        return <ClaudeCodeIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    }
  }

  const getItemLabel = (item: FlatModelItem): string => {
    switch (item.type) {
      case "claude":
        return `${item.model.name} ${item.model.version}`
      case "ollama":
        return item.modelName + (item.isRecommended ? " (recommended)" : "")
      case "custom":
        return "Custom Model"
    }
  }

  const getItemKey = (item: FlatModelItem): string => {
    switch (item.type) {
      case "claude":
        return `claude-${item.model.id}`
      case "ollama":
        return `ollama-${item.modelName}`
      case "custom":
        return "custom"
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 text-sm text-muted-foreground transition-[background-color,color] duration-150 ease-out rounded-md outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70",
            "hover:text-foreground hover:bg-muted/50",
            triggerClassName,
          )}
        >
          {triggerIcon}
          <span className="truncate">{selectedModelLabel}</span>
          <IconChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn("w-64 p-0", contentClassName)}
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search models..."
            value={search}
            onValueChange={setSearch}
          />

          {/* Claude thinking toggle */}
          {!claude.isOffline && !claude.hasCustomModelConfig && (
            <>
              <div
                className="flex items-center justify-between min-h-[32px] py-[5px] px-1.5 mx-1"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-1.5">
                  <ThinkingIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-sm">Thinking</span>
                </div>
                <Switch
                  checked={claude.thinkingEnabled}
                  onCheckedChange={claude.onThinkingChange}
                  className="scale-75"
                />
              </div>
              <CommandSeparator />
            </>
          )}

          <CommandList className="max-h-[300px] overflow-y-auto">
            {filteredModels.length > 0 ? (
              <CommandGroup>
                {filteredModels.map((item) => {
                  const selected = isItemSelected(item)
                  return (
                    <CommandItem
                      key={getItemKey(item)}
                      value={getItemKey(item)}
                      onSelect={() => handleItemClick(item)}
                      className="gap-2"
                    >
                      {getItemIcon(item)}
                      <span className="truncate flex-1">{getItemLabel(item)}</span>
                      {selected && (
                        <CheckIcon className="h-4 w-4 shrink-0" />
                      )}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ) : (
              <CommandEmpty>No models found.</CommandEmpty>
            )}
          </CommandList>

          {onOpenModelsSettings && (
            <div className="border-t border-border/50 py-1">
              <button
                onClick={() => {
                  onOpenModelsSettings()
                  handleOpenChange(false)
                }}
                className="flex items-center gap-1.5 min-h-[32px] py-[5px] px-1.5 mx-1 w-[calc(100%-8px)] rounded-md text-sm cursor-default select-none outline-none dark:hover:bg-neutral-800 hover:text-foreground transition-colors"
              >
                <span className="flex-1 text-left">Add Models</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
