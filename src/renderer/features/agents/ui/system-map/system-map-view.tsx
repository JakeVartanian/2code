/**
 * SystemMapView — Main container for the System Map tab.
 * Hero: System Architecture Map showing major zones with connections
 * and confidence coloring derived from AI-synthesized architecture data.
 * Below: existing workspace AI state sections (memory, skills, etc.).
 */

import { memo } from "react"
import { useAtomValue } from "jotai"
import {
  Brain,
  FileText,
  Puzzle,
  Bot,
  Workflow,
  Bell,
} from "lucide-react"

import { selectedProjectAtom } from "../../../../lib/atoms"
import { useSystemMapData } from "./use-system-map-data"
import { WorkflowStages } from "./workflow-stages"
import { MapSection } from "./map-section"
import { MemoryBrain } from "./memory-brain"
import { PlanNodes } from "./plan-nodes"
import { SkillNodes } from "./skill-nodes"
import { AgentNodes } from "./agent-nodes"
import { OrchestrationSummary } from "./orchestration-summary"
import { AmbientAlerts } from "./ambient-alerts"
import { ArchitectureMap } from "./architecture-map"

interface SystemMapViewProps {
  chatId: string
  subChatId: string
}

export const SystemMapView = memo(function SystemMapView({
  chatId,
}: SystemMapViewProps) {
  const selectedProject = useAtomValue(selectedProjectAtom)
  const data = useSystemMapData(selectedProject?.id ?? null, chatId)

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

        {/* Workflow stages — full width */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
          <WorkflowStages
            activeStage={data.workflowStage.activeStage}
            completedStages={data.workflowStage.completedStages}
          />
        </div>

        {/* Main 2-column grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left column */}
          <div className="space-y-4">
            <MapSection
              title="Memory Bank"
              icon={<Brain className="w-4 h-4" />}
              count={data.memories.length}
              accentColor="blue"
            >
              <MemoryBrain memories={data.memories} />
            </MapSection>

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
      </div>
    </div>
  )
})
