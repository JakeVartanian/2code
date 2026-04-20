import { useAtomValue, useSetAtom } from "jotai"
import { lazy, Suspense, useEffect } from "react"
import {
  agentsSettingsDialogActiveTabAtom,
  devToolsUnlockedAtom,
} from "../../lib/atoms"
import { desktopViewAtom } from "../agents/atoms"

// Lazy-load all settings tabs — only the active tab is loaded at a time
const AgentsAppearanceTab = lazy(() => import("../../components/dialogs/settings-tabs/agents-appearance-tab").then(m => ({ default: m.AgentsAppearanceTab })))
const AgentsBetaTab = lazy(() => import("../../components/dialogs/settings-tabs/agents-beta-tab").then(m => ({ default: m.AgentsBetaTab })))
const AgentsCustomAgentsTab = lazy(() => import("../../components/dialogs/settings-tabs/agents-custom-agents-tab").then(m => ({ default: m.AgentsCustomAgentsTab })))
const AgentsDebugTab = lazy(() => import("../../components/dialogs/settings-tabs/agents-debug-tab").then(m => ({ default: m.AgentsDebugTab })))
const AgentsKeyboardTab = lazy(() => import("../../components/dialogs/settings-tabs/agents-keyboard-tab").then(m => ({ default: m.AgentsKeyboardTab })))
const AgentsMcpTab = lazy(() => import("../../components/dialogs/settings-tabs/agents-mcp-tab").then(m => ({ default: m.AgentsMcpTab })))
const AgentsModelsTab = lazy(() => import("../../components/dialogs/settings-tabs/agents-models-tab").then(m => ({ default: m.AgentsModelsTab })))
const AgentsPreferencesTab = lazy(() => import("../../components/dialogs/settings-tabs/agents-preferences-tab").then(m => ({ default: m.AgentsPreferencesTab })))
const AgentsProfileTab = lazy(() => import("../../components/dialogs/settings-tabs/agents-profile-tab").then(m => ({ default: m.AgentsProfileTab })))
const AgentsProjectsTab = lazy(() => import("../../components/dialogs/settings-tabs/agents-project-worktree-tab").then(m => ({ default: m.AgentsProjectsTab })))
const AgentsSkillsTab = lazy(() => import("../../components/dialogs/settings-tabs/agents-skills-tab").then(m => ({ default: m.AgentsSkillsTab })))
const AgentsPluginsTab = lazy(() => import("../../components/dialogs/settings-tabs/agents-plugins-tab").then(m => ({ default: m.AgentsPluginsTab })))
const AgentsMemoryTab = lazy(() => import("../../components/dialogs/settings-tabs/agents-memory-tab").then(m => ({ default: m.AgentsMemoryTab })))
const AgentsSectionsTab = lazy(() => import("../../components/dialogs/settings-tabs/agents-sections-tab").then(m => ({ default: m.AgentsSectionsTab })))

// Check if we're in development mode
const isDevelopment = import.meta.env.DEV

export function SettingsContent() {
  const activeTab = useAtomValue(agentsSettingsDialogActiveTabAtom)
  const devToolsUnlocked = useAtomValue(devToolsUnlockedAtom)
  const showDebugTab = isDevelopment || devToolsUnlocked
  const setDesktopView = useSetAtom(desktopViewAtom)

  // Escape key closes settings
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        setDesktopView(null)
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [setDesktopView])

  const renderTabContent = () => {
    switch (activeTab) {
      case "profile":
        return <AgentsProfileTab />
      case "appearance":
        return <AgentsAppearanceTab />
      case "keyboard":
        return <AgentsKeyboardTab />
      case "preferences":
        return <AgentsPreferencesTab />
      case "models":
        return <AgentsModelsTab />
      case "skills":
        return <AgentsSkillsTab />
      case "agents":
        return <AgentsCustomAgentsTab />
      case "mcp":
        return <AgentsMcpTab />
      case "plugins":
        return <AgentsPluginsTab />
      case "projects":
        return <AgentsProjectsTab />
      case "beta":
        return <AgentsBetaTab />
      case "memory":
        return <AgentsMemoryTab />
      case "sections":
        return <AgentsSectionsTab />
      case "debug":
        return showDebugTab ? <AgentsDebugTab /> : null
      default:
        return null
    }
  }

  // Two-panel tabs need full width and height, no scroll wrapper
  const isTwoPanelTab = activeTab === "mcp" || activeTab === "skills" || activeTab === "agents" || activeTab === "projects" || activeTab === "keyboard" || activeTab === "plugins" || activeTab === "memory" || activeTab === "sections"

  if (isTwoPanelTab) {
    return (
      <div className="h-full overflow-hidden">
        <Suspense fallback={null}>
          {renderTabContent()}
        </Suspense>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto">
        <Suspense fallback={null}>
          {renderTabContent()}
        </Suspense>
      </div>
    </div>
  )
}
