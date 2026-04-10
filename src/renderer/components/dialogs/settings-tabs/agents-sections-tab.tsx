import { useState, useMemo, useCallback } from "react"
import { useAtomValue } from "jotai"
import { trpc } from "../../../lib/trpc"
import { Button } from "../../ui/button"
import { RefreshCw, ChevronDown, Shield, ShieldOff } from "lucide-react"
import { toast } from "sonner"
import { cn } from "../../../lib/utils"
import { selectedProjectAtom } from "../../../lib/atoms"
import type { WorkspaceSection } from "../../../../shared/section-types"

// ─── Section icon color map ────────────────────────────────────────────────

function SectionIcon({ section, className }: { section: WorkspaceSection; className?: string }) {
  return (
    <div
      className={cn(
        "w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold",
        section.enabled
          ? "bg-foreground/10 text-foreground"
          : "bg-muted text-muted-foreground",
        className,
      )}
    >
      {section.name.slice(0, 2).toUpperCase()}
    </div>
  )
}

// ─── Main tab component ────────────────────────────────────────────────────

export function AgentsSectionsTab() {
  const selectedProject = useAtomValue(selectedProjectAtom)
  const [expandedSection, setExpandedSection] = useState<string | null>(null)

  // Fetch sections for current project
  const {
    data: sectionsData,
    refetch,
    isLoading,
  } = trpc.sections.get.useQuery(
    { projectId: selectedProject?.id || "" },
    { enabled: !!selectedProject?.id },
  )

  const toggleMutation = trpc.sections.toggle.useMutation({
    onSuccess: () => {
      refetch()
    },
    onError: (err) => {
      toast.error(`Failed to toggle: ${err.message}`)
    },
  })

  const saveMutation = trpc.sections.save.useMutation({
    onSuccess: () => {
      refetch()
      toast.success("Sections saved")
    },
    onError: (err) => {
      toast.error(`Failed to save: ${err.message}`)
    },
  })

  const detectMutation = trpc.sections.detect.useMutation({
    onSuccess: (detected) => {
      if (selectedProject?.id) {
        saveMutation.mutate({
          projectId: selectedProject.id,
          config: detected,
        })
      }
    },
    onError: (err) => {
      toast.error(`Detection failed: ${err.message}`)
    },
  })

  const sections = sectionsData?.config?.sections || []
  const isAutoDetected = sectionsData?.config?.autoDetected ?? false

  const enabledCount = useMemo(
    () => sections.filter((s) => s.enabled).length,
    [sections],
  )

  const handleToggle = useCallback(
    (sectionId: string, enabled: boolean) => {
      if (!selectedProject?.id) return
      toggleMutation.mutate({
        projectId: selectedProject.id,
        sectionId,
        enabled,
      })
    },
    [selectedProject?.id, toggleMutation],
  )

  const handleReDetect = useCallback(() => {
    if (!selectedProject?.id) return
    detectMutation.mutate({ projectId: selectedProject.id })
  }, [selectedProject?.id, detectMutation])

  const handleSave = useCallback(() => {
    if (!selectedProject?.id || !sectionsData?.config) return
    saveMutation.mutate({
      projectId: selectedProject.id,
      config: sectionsData.config,
    })
  }, [selectedProject?.id, sectionsData?.config, saveMutation])

  if (!selectedProject) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Select a project to manage sections
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Workspace Sections
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              Control which parts of the codebase Claude can modify. Disabled
              sections are protected from changes.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleReDetect}
              disabled={detectMutation.isPending}
              className="h-7 text-xs"
            >
              <RefreshCw
                className={cn(
                  "w-3.5 h-3.5 mr-1.5",
                  detectMutation.isPending && "animate-spin",
                )}
              />
              Re-detect
            </Button>
            {isAutoDetected && (
              <Button
                variant="default"
                size="sm"
                onClick={handleSave}
                disabled={saveMutation.isPending}
                className="h-7 text-xs"
              >
                Save
              </Button>
            )}
          </div>
        </div>

        {/* Summary bar */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Shield className="w-3.5 h-3.5 text-green-500" />
            {enabledCount} enabled
          </span>
          <span className="flex items-center gap-1">
            <ShieldOff className="w-3.5 h-3.5 text-red-500" />
            {sections.length - enabledCount} guarded
          </span>
          {isAutoDetected && (
            <span className="text-amber-500 font-medium">Auto-detected (not saved)</span>
          )}
        </div>
      </div>

      {/* Section list */}
      <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-2">
        {isLoading ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            Detecting sections...
          </div>
        ) : sections.length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            No sections detected. Click "Re-detect" to scan the project.
          </div>
        ) : (
          sections.map((section) => {
            const isExpanded = expandedSection === section.id
            return (
              <div
                key={section.id}
                className={cn(
                  "border rounded-lg transition-colors",
                  section.enabled
                    ? "border-border bg-background"
                    : "border-red-500/30 bg-red-500/5",
                )}
              >
                {/* Section header */}
                <div className="flex items-center gap-3 px-4 py-3">
                  <SectionIcon section={section} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "text-sm font-medium",
                          section.enabled
                            ? "text-foreground"
                            : "text-red-500 line-through",
                        )}
                      >
                        {section.name}
                      </span>
                      {!section.enabled && (
                        <span className="text-[10px] font-medium text-red-500 bg-red-500/10 px-1.5 py-0.5 rounded">
                          GUARDED
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {section.patterns.length}{" "}
                      {section.patterns.length === 1 ? "pattern" : "patterns"}
                    </span>
                  </div>

                  {/* Expand patterns */}
                  <button
                    onClick={() =>
                      setExpandedSection(isExpanded ? null : section.id)
                    }
                    className="p-1 rounded hover:bg-foreground/5 transition-colors"
                  >
                    <ChevronDown
                      className={cn(
                        "w-4 h-4 text-muted-foreground transition-transform",
                        isExpanded && "rotate-180",
                      )}
                    />
                  </button>

                  {/* Toggle */}
                  <button
                    onClick={() => handleToggle(section.id, !section.enabled)}
                    disabled={toggleMutation.isPending}
                    className={cn(
                      "relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
                      section.enabled ? "bg-green-500" : "bg-muted-foreground/30",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform",
                        section.enabled ? "translate-x-4" : "translate-x-1",
                      )}
                    />
                  </button>
                </div>

                {/* Expanded patterns */}
                {isExpanded && (
                  <div className="px-4 pb-3 pt-0">
                    <div className="border-t border-border/50 pt-2 space-y-1">
                      {section.patterns.map((pattern) => (
                        <div
                          key={pattern}
                          className="text-xs font-mono text-muted-foreground bg-muted/50 px-2 py-1 rounded"
                        >
                          {pattern}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
