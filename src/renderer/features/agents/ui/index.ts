// Agent UI Components
// All components are designed to work with mocked data for parallel development

// Chat components
export { AgentUserMessageBubble } from "./agent-user-message-bubble"

// Content components
export { AgentsContent } from "./agents-content"

// Preview components
export { AgentPreview } from "./agent-preview"
export { ViewportToggle } from "./viewport-toggle"
export { ScaleControl } from "./scale-control"
export { DevicePresetsBar } from "./device-presets-bar"
export { PreviewRouteDropdown } from "./preview-route-dropdown"

// Diff components
export { AgentDiffView } from "./agent-diff-view"
export type { DiffStats, AgentDiffViewRef } from "./agent-diff-view"
export { diffViewModeAtom } from "./agent-diff-utils"
export type { DiffViewMode } from "./agent-diff-utils"

// Exploring group component
export { AgentExploringGroup } from "./agent-exploring-group"

// Thinking component (Extended Thinking)
export { AgentThinkingTool } from "./agent-thinking-tool"

// Main components
export { ChatView } from "../main/active-chat"
export { NewChatForm } from "../main/new-chat-form"
