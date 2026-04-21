/**
 * SystemMapView — Main container for the System Map tab.
 * Hero: System Architecture Map showing major zones with connections.
 * Below: Tabbed layout — Audits (default) and Workspace.
 */

import { memo, useState } from "react"
import { useAtomValue } from "jotai"
import {
  FileText,
  Puzzle,
  Bot,
  Workflow,
  Bell,
  ShieldCheck,
  Layers,
} from "lucide-react"
import { cn } from "../../../../lib/utils"

import { selectedProjectAtom } from "../../../../lib/atoms"
import { useSystemMapData } from "./use-system-map-data"
import { WorkflowStages } from "./workflow-stages"
import { MapSection } from "./map-section"
import { PlanNodes } from "./plan-nodes"
import { SkillNodes } from "./skill-nodes"
import { AgentNodes } from "./agent-nodes"
import { OrchestrationSummary } from "./orchestration-summary"
import { AmbientAlerts } from "./ambient-alerts"
import { ArchitectureMap } from "./architecture-map"
import { AuditDashboard } from "./audit-dashboard"

type TabId = "audits" | "workspace"

interface SystemMapViewProps {
  chatId: string
  subChatId: string
}

export const SystemMapView = memo(function SystemMapView({
  chatId,
}: SystemMapViewProps) {
  const selectedProject = useAtomValue(selectedProjectAtom)
  const data = useSystemMapData(selectedProject?.id ?? null, chatId)
  const [activeTab, setActiveTab] = useState<TabId>("audits")

  return (
    <div className="relative h-full overflow-y-auto overflow-x-hidden">
      {/* Content */}
      <div className="relative z-10 p-4 space-y-4">
        {/* Hero: System Architecture Map */}
        <ArchitectureMap
          projectId={selectedProject?.id ?? null}
          projectPath={selectedProject?.path ?? null}
          chatId={chatId}
        />

        {/* Workflow stages — full width, above tabs */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
          <WorkflowStages
            activeStage={data.workflowStage.activeStage}
            completedStages={data.workflowStage.completedStages}
          />
        </div>

        {/* Tab bar */}
        <div className="flex items-center gap-1 border-b border-zinc-800/60 pb-0">
          <TabButton
            active={activeTab === "audits"}
            onClick={() => setActiveTab("audits")}
            icon={<ShieldCheck className="w-3.5 h-3.5" />}
            label="Audits"
          />
          <TabButton
            active={activeTab === "workspace"}
            onClick={() => setActiveTab("workspace")}
            icon={<Layers className="w-3.5 h-3.5" />}
            label="Workspace"
          />
        </div>

        {/* Tab content */}
        {activeTab === "audits" ? (
          <AuditDashboard
            projectId={selectedProject?.id ?? null}
            chatId={chatId}
          />
        ) : (
          /* Workspace tab — existing sections */
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left column */}
            <div className="space-y-4">
              <MapSection
                title="Plans"
                icon={<FileText className="w-4 h-4" />}
                count={data.plans.length}
                accentColor="cyan"
                defaultOpen={data.plans.length > 0}
              >
                <PlanNodes plans={data.plans} />
              </MapSection>

              <MapSection
                title="Ambient Alerts"
                icon={<Bell className="w-4 h-4" />}
                count={data.suggestions.length}
                accentColor="amber"
                defaultOpen={data.suggestions.length > 0}
              >
                <AmbientAlerts suggestions={data.suggestions} />
              </MapSection>
            </div>

            {/* Right column */}
            <div className="space-y-4">
              <MapSection
                title="Skills"
                icon={<Puzzle className="w-4 h-4" />}
                count={data.skills.length}
                accentColor="purple"
                defaultOpen={data.skills.length > 0}
              >
                <SkillNodes skills={data.skills} />
              </MapSection>

              <MapSection
                title="Agents"
                icon={<Bot className="w-4 h-4" />}
                count={data.agents.length}
                accentColor="green"
                defaultOpen={data.agents.length > 0}
              >
                <AgentNodes agents={data.agents} />
              </MapSection>

              <MapSection
                title="Orchestration"
                icon={<Workflow className="w-4 h-4" />}
                count={data.activeRuns.length}
                accentColor="cyan"
                defaultOpen={data.activeRuns.length > 0}
              >
                <OrchestrationSummary runs={data.activeRuns} />
              </MapSection>
            </div>
          </div>
        )}
      </div>
    </div>
  )
})

// ─── Tab Button ─────────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-4 py-2.5 text-xs font-medium transition-all duration-150 border-b-2 -mb-px",
        active
          ? "text-cyan-400 border-cyan-400"
          : "text-zinc-500 border-transparent hover:text-zinc-300 hover:border-zinc-600",
      )}
    >
      {icon}
      {label}
    </button>
  )
}
