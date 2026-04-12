import { useState } from "react"
import { useAtom } from "jotai"
import { X, Plus, Brain, FileText, History, RefreshCw } from "lucide-react"
import { Button } from "../../../components/ui/button"
import { Badge } from "../../../components/ui/badge"
import { trpc } from "../../../lib/trpc"
import { memoryPanelOpenAtom, memoryActiveTopicAtom } from "../atoms"
import { MemoryEntryEditor } from "./memory-entry-editor"
import { TopicFileViewer } from "./topic-file-viewer"
import { SessionLogViewer } from "./session-log-viewer"

type Tab = "index" | "sessions"

interface MemoryPanelProps {
  projectPath: string
}

export function MemoryPanel({ projectPath }: MemoryPanelProps) {
  const [isOpen, setIsOpen] = useAtom(memoryPanelOpenAtom)
  const [activeTopic, setActiveTopic] = useAtom(memoryActiveTopicAtom)
  const [tab, setTab] = useState<Tab>("index")
  const [showEditor, setShowEditor] = useState(false)

  const utils = trpc.useUtils()
  const { data: vault } = trpc.memory.getVault.useQuery(
    { projectPath },
    { enabled: isOpen, staleTime: 10_000 },
  )

  const initMutation = trpc.memory.init.useMutation({
    onSuccess: () => utils.memory.getVault.invalidate(),
  })

  const consolidateMutation = trpc.memory.consolidate.useMutation({
    onSuccess: () => {
      utils.memory.getVault.invalidate()
      utils.memory.getAllEntries.invalidate()
    },
  })

  if (!isOpen) return null

  const totalEntries = vault?.topics.reduce((sum, t) => sum + t.entryCount, 0) ?? 0

  return (
    <div className="fixed inset-y-0 right-0 w-80 z-50 border-l bg-background shadow-xl flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-foreground" />
          <span className="text-sm font-medium">Project Memory</span>
          {totalEntries > 0 && (
            <Badge variant="secondary" className="text-[9px] px-1 py-0">
              {totalEntries}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => consolidateMutation.mutate({ projectPath })}
            disabled={consolidateMutation.isPending}
            title="Consolidate memory"
          >
            <RefreshCw className={`h-3 w-3 ${consolidateMutation.isPending ? "animate-spin" : ""}`} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => {
              setIsOpen(false)
              setActiveTopic(null)
            }}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b px-3">
        <button
          onClick={() => { setTab("index"); setActiveTopic(null) }}
          className={`px-2 py-1.5 text-xs font-medium border-b-2 transition-colors ${
            tab === "index"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <FileText className="h-3 w-3 inline mr-1" />
          Topics
        </button>
        <button
          onClick={() => { setTab("sessions"); setActiveTopic(null) }}
          className={`px-2 py-1.5 text-xs font-medium border-b-2 transition-colors ${
            tab === "sessions"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <History className="h-3 w-3 inline mr-1" />
          Sessions
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3">
        {!vault ? (
          <div className="flex flex-col items-center justify-center py-8 gap-3">
            <Brain className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground text-center">
              No memory vault for this project yet.
            </p>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => initMutation.mutate({ projectPath })}
              disabled={initMutation.isPending}
            >
              Initialize Memory
            </Button>
          </div>
        ) : tab === "sessions" ? (
          <SessionLogViewer projectPath={projectPath} />
        ) : activeTopic ? (
          <TopicFileViewer
            projectPath={projectPath}
            filename={activeTopic}
            onBack={() => setActiveTopic(null)}
          />
        ) : (
          <div className="space-y-3">
            {/* Add memory button */}
            {showEditor ? (
              <MemoryEntryEditor
                projectPath={projectPath}
                onClose={() => setShowEditor(false)}
                onSaved={() => setShowEditor(false)}
              />
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="w-full h-7 text-xs gap-1"
                onClick={() => setShowEditor(true)}
              >
                <Plus className="h-3 w-3" />
                Add Memory
              </Button>
            )}

            {/* Topic files list */}
            {vault.topics.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">
                Memories will appear here as you work with Claude.
              </p>
            ) : (
              <div className="space-y-1.5">
                {vault.topics
                  .filter((t) => t.entryCount > 0)
                  .map((topic) => (
                    <button
                      key={topic.filename}
                      onClick={() => setActiveTopic(topic.filename)}
                      className="w-full flex items-center justify-between p-2 rounded-md hover:bg-foreground/5 transition-colors text-left"
                    >
                      <div className="min-w-0">
                        <p className="text-[11px] font-medium text-foreground truncate">
                          {topic.filename.replace(".md", "").replace(/-/g, " ")}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {topic.entryCount} {topic.entryCount === 1 ? "entry" : "entries"}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
                        {topic.categories[0]?.replace(/-/g, " ") ?? ""}
                      </Badge>
                    </button>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
