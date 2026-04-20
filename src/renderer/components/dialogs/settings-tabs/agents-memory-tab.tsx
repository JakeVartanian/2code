import { useState, useMemo, useCallback } from "react"
import { useAtom, useAtomValue } from "jotai"
import { trpc } from "../../../lib/trpc"
import { Button } from "../../ui/button"
import {
  Plus,
  Trash2,
  Archive,
  RefreshCw,
  Upload,
  Search,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  Zap,
  Brain,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "../../../lib/utils"
import {
  selectedProjectAtom,
  memoryAutoCaptureEnabledAtom,
  memoryInjectionEnabledAtom,
  memoryTokenBudgetAtom,
} from "../../../lib/atoms"

// Category badge colors
const CATEGORY_COLORS: Record<string, string> = {
  architecture: "bg-blue-500/15 text-blue-400",
  convention: "bg-purple-500/15 text-purple-400",
  deployment: "bg-green-500/15 text-green-400",
  debugging: "bg-orange-500/15 text-orange-400",
  preference: "bg-cyan-500/15 text-cyan-400",
  gotcha: "bg-red-500/15 text-red-400",
}

const CATEGORIES = [
  "architecture",
  "convention",
  "deployment",
  "debugging",
  "preference",
  "gotcha",
] as const

type MemoryCategory = (typeof CATEGORIES)[number]

// Category filter pills
function CategoryFilter({
  selected,
  onChange,
}: {
  selected: MemoryCategory | null
  onChange: (cat: MemoryCategory | null) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pb-2">
      <button
        onClick={() => onChange(null)}
        className={cn(
          "px-2 py-0.5 rounded-full text-xs font-medium transition-colors",
          !selected
            ? "bg-foreground/15 text-foreground"
            : "bg-muted text-muted-foreground hover:bg-muted-foreground/20",
        )}
      >
        All
      </button>
      {CATEGORIES.map((cat) => (
        <button
          key={cat}
          onClick={() => onChange(selected === cat ? null : cat)}
          className={cn(
            "px-2 py-0.5 rounded-full text-xs font-medium transition-colors capitalize",
            selected === cat
              ? CATEGORY_COLORS[cat]
              : "bg-muted text-muted-foreground hover:bg-muted-foreground/20",
          )}
        >
          {cat}
        </button>
      ))}
    </div>
  )
}

// Individual memory item in the list
function MemoryItem({
  memory,
  isSelected,
  onClick,
}: {
  memory: any
  isSelected: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-2.5 border-b border-border/50 transition-colors",
        isSelected
          ? "bg-accent/50"
          : "hover:bg-accent/30",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span
              className={cn(
                "px-1.5 py-0 rounded text-[10px] font-medium capitalize",
                CATEGORY_COLORS[memory.category] || "bg-muted text-muted-foreground",
              )}
            >
              {memory.category}
            </span>
            {memory.isStale && (
              <AlertTriangle className="w-3 h-3 text-yellow-500" />
            )}
            {memory.source === "auto" && (
              <span className="text-[10px] text-muted-foreground">auto</span>
            )}
          </div>
          <p className="text-sm font-medium truncate">{memory.title}</p>
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {memory.content.slice(0, 80)}
          </p>
        </div>
        <div className="text-xs text-muted-foreground tabular-nums shrink-0">
          {memory.relevanceScore}
        </div>
      </div>
    </button>
  )
}

// Memory detail panel
function MemoryDetail({
  memory,
  onUpdate,
  onDelete,
  onArchive,
}: {
  memory: any
  onUpdate: (id: string, data: any) => void
  onDelete: (id: string) => void
  onArchive: (id: string) => void
}) {
  const [editTitle, setEditTitle] = useState(memory.title)
  const [editContent, setEditContent] = useState(memory.content)
  const [editCategory, setEditCategory] = useState<MemoryCategory>(memory.category)
  const [editRelevance, setEditRelevance] = useState(memory.relevanceScore)
  const [isDirty, setIsDirty] = useState(false)

  // Reset when memory changes
  useMemo(() => {
    setEditTitle(memory.title)
    setEditContent(memory.content)
    setEditCategory(memory.category)
    setEditRelevance(memory.relevanceScore)
    setIsDirty(false)
  }, [memory.id])

  const handleSave = () => {
    onUpdate(memory.id, {
      title: editTitle,
      content: editContent,
      category: editCategory,
      relevanceScore: editRelevance,
    })
    setIsDirty(false)
  }

  const linkedFiles = memory.linkedFiles
    ? JSON.parse(memory.linkedFiles)
    : []

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Title */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">
            Title
          </label>
          <input
            value={editTitle}
            onChange={(e) => {
              setEditTitle(e.target.value)
              setIsDirty(true)
            }}
            className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-sm"
          />
        </div>

        {/* Category */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">
            Category
          </label>
          <select
            value={editCategory}
            onChange={(e) => {
              setEditCategory(e.target.value as MemoryCategory)
              setIsDirty(true)
            }}
            className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-sm capitalize"
          >
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
        </div>

        {/* Content */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">
            Content (Markdown)
          </label>
          <textarea
            value={editContent}
            onChange={(e) => {
              setEditContent(e.target.value)
              setIsDirty(true)
            }}
            rows={8}
            className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm font-mono resize-y"
          />
        </div>

        {/* Relevance Score */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">
            Relevance Score: {editRelevance}
          </label>
          <input
            type="range"
            min={0}
            max={100}
            value={editRelevance}
            onChange={(e) => {
              setEditRelevance(Number(e.target.value))
              setIsDirty(true)
            }}
            className="w-full"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>Low priority</span>
            <span>High priority</span>
          </div>
        </div>

        {/* Linked Files */}
        {linkedFiles.length > 0 && (
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Linked Files
            </label>
            <div className="space-y-1">
              {linkedFiles.map((fp: string, i: number) => (
                <div
                  key={i}
                  className="text-xs font-mono text-muted-foreground px-2 py-1 bg-muted rounded"
                >
                  {fp}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Metadata */}
        <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t border-border/50">
          <div className="flex justify-between">
            <span>Source</span>
            <span className="capitalize">{memory.source}</span>
          </div>
          <div className="flex justify-between">
            <span>Accessed</span>
            <span>{memory.accessCount} times</span>
          </div>
          {memory.createdAt && (
            <div className="flex justify-between">
              <span>Created</span>
              <span>{new Date(memory.createdAt).toLocaleDateString()}</span>
            </div>
          )}
          {memory.isStale && (
            <div className="flex items-center gap-1 text-yellow-500 mt-1">
              <AlertTriangle className="w-3 h-3" />
              <span>Some linked files may be missing</span>
            </div>
          )}
        </div>
      </div>

      {/* Action bar */}
      <div className="border-t border-border p-3 flex items-center gap-2">
        {isDirty && (
          <Button size="sm" onClick={handleSave}>
            Save Changes
          </Button>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onArchive(memory.id)}
          className="text-muted-foreground"
        >
          <Archive className="w-3.5 h-3.5 mr-1" />
          Archive
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDelete(memory.id)}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="w-3.5 h-3.5 mr-1" />
          Delete
        </Button>
      </div>
    </div>
  )
}

// Add Memory Form
function AddMemoryForm({
  projectId,
  onCreated,
  onCancel,
}: {
  projectId: string
  onCreated: () => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [category, setCategory] = useState<MemoryCategory>("preference")

  const createMutation = trpc.memory.create.useMutation({
    onSuccess: () => {
      toast.success("Memory added")
      onCreated()
    },
    onError: (err) => toast.error(err.message),
  })

  return (
    <div className="p-4 space-y-3">
      <h3 className="text-sm font-semibold">Add Memory</h3>
      <input
        placeholder="Title (short summary)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-sm"
      />
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value as MemoryCategory)}
        className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-sm capitalize"
      >
        {CATEGORIES.map((cat) => (
          <option key={cat} value={cat}>{cat}</option>
        ))}
      </select>
      <textarea
        placeholder="Content (markdown)"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={5}
        className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm font-mono resize-y"
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!title.trim() || !content.trim()}
          onClick={() =>
            createMutation.mutate({
              projectId,
              title,
              content,
              category,
              source: "manual",
            })
          }
        >
          Add
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

// ─── Main tab component ────────────────────────────────────────────────────

export function AgentsMemoryTab() {
  const selectedProject = useAtomValue(selectedProjectAtom)
  const [autoCaptureEnabled, setAutoCapture] = useAtom(memoryAutoCaptureEnabledAtom)
  const [injectionEnabled, setInjection] = useAtom(memoryInjectionEnabledAtom)
  const [tokenBudget, setTokenBudget] = useAtom(memoryTokenBudgetAtom)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [categoryFilter, setCategoryFilter] = useState<MemoryCategory | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [showAddForm, setShowAddForm] = useState(false)

  // Fetch memories
  const {
    data: memories,
    refetch,
    isLoading,
  } = trpc.memory.list.useQuery(
    {
      projectId: selectedProject?.id || "",
      category: categoryFilter || undefined,
      search: searchQuery || undefined,
    },
    { enabled: !!selectedProject?.id },
  )

  // Fetch stats
  const { data: stats } = trpc.memory.stats.useQuery(
    { projectId: selectedProject?.id || "" },
    { enabled: !!selectedProject?.id },
  )

  // Mutations
  const updateMutation = trpc.memory.update.useMutation({
    onSuccess: () => {
      toast.success("Memory updated")
      refetch()
    },
    onError: (err) => toast.error(err.message),
  })

  const deleteMutation = trpc.memory.delete.useMutation({
    onSuccess: () => {
      toast.success("Memory deleted")
      setSelectedId(null)
      refetch()
    },
    onError: (err) => toast.error(err.message),
  })

  const validateMutation = trpc.memory.validate.useMutation({
    onSuccess: (result) => {
      toast.success(
        `Validated: ${result.validated} OK, ${result.markedStale} newly stale`,
      )
      refetch()
    },
    onError: (err) => toast.error(err.message),
  })

  const importMutation = trpc.memory.importFromFile.useMutation({
    onSuccess: (result) => {
      toast.success(`Imported ${result.imported} memories`)
      refetch()
    },
    onError: (err) => toast.error(err.message),
  })

  const handleUpdate = useCallback(
    (id: string, data: any) => {
      updateMutation.mutate({ id, ...data })
    },
    [updateMutation],
  )

  const handleDelete = useCallback(
    (id: string) => {
      deleteMutation.mutate({ id })
    },
    [deleteMutation],
  )

  const handleArchive = useCallback(
    (id: string) => {
      updateMutation.mutate({ id, isArchived: true })
      setSelectedId(null)
    },
    [updateMutation],
  )

  const selectedMemory = useMemo(
    () => memories?.find((m) => m.id === selectedId),
    [memories, selectedId],
  )

  // Brain status (hooks must be before early returns)
  const { data: brainStatus } = trpc.ambient.getBrainStatus.useQuery(
    { projectId: selectedProject?.id || "" },
    { enabled: !!selectedProject?.id },
  )

  const buildBrainMutation = trpc.ambient.buildBrain.useMutation({
    onSuccess: (result) => {
      if (result.success) {
        toast.success(`Brain built: ${result.memoriesCreated} memories created`)
        refetch()
      } else {
        toast.error(result.error ?? "Failed to build brain")
      }
    },
    onError: (err) => toast.error(err.message),
  })

  // Ambient agent status
  const { data: ambientStatus } = trpc.ambient.getStatus.useQuery(
    { projectId: selectedProject?.id || "" },
    { enabled: !!selectedProject?.id },
  )

  const toggleAmbient = trpc.ambient.toggle.useMutation({
    onSuccess: (result) => {
      toast.success(`Ambient agent ${result.enabled ? "enabled" : "disabled"}`)
    },
  })

  if (!selectedProject) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        Select a project to manage memories
      </div>
    )
  }

  return (
    <div className="h-full flex">
      {/* Left panel: list */}
      <div className="w-[320px] border-r border-border flex flex-col">
        {/* Brain & Ambient Section */}
        <div className="px-3 py-3 border-b border-border/50 space-y-3">
          {/* Brain status card */}
          <div className="rounded-lg border border-border/50 p-2.5 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <Brain className="h-3.5 w-3.5 text-teal-500" />
              <span>Project Brain</span>
              <span className="ml-auto text-muted-foreground">
                {brainStatus?.memoryCount ?? 0} memories
              </span>
            </div>

            {brainStatus && brainStatus.memoryCount > 0 ? (
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-teal-500/60"
                    style={{ width: `${Math.min(100, (brainStatus.memoryCount / 20) * 100)}%` }}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => buildBrainMutation.mutate({ projectId: selectedProject!.id, projectPath: selectedProject!.path })}
                  disabled={buildBrainMutation.isPending}
                >
                  <RefreshCw className={cn("h-3 w-3 mr-1", buildBrainMutation.isPending && "animate-spin")} />
                  Refresh
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="w-full h-7 text-xs"
                onClick={() => buildBrainMutation.mutate({ projectId: selectedProject!.id, projectPath: selectedProject!.path })}
                disabled={buildBrainMutation.isPending}
              >
                <Zap className={cn("h-3 w-3 mr-1.5", buildBrainMutation.isPending && "animate-spin")} />
                {buildBrainMutation.isPending ? "Building..." : "Build Brain"}
              </Button>
            )}
          </div>

          {/* Ambient agent toggle */}
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5">
              <Zap className="h-3 w-3 text-muted-foreground" />
              <span>Ambient Agent</span>
              <span className={cn(
                "h-1.5 w-1.5 rounded-full",
                ambientStatus?.agentStatus === "running" ? "bg-green-500"
                : ambientStatus?.agentStatus === "paused" ? "bg-amber-500"
                : "bg-zinc-500"
              )} />
            </div>
            <button
              onClick={() => toggleAmbient.mutate({
                projectId: selectedProject!.id,
                projectPath: selectedProject!.path,
                enabled: ambientStatus?.agentStatus !== "running",
              })}
              className={cn(
                "relative h-5 w-9 rounded-full transition-colors",
                ambientStatus?.agentStatus === "running" ? "bg-teal-500" : "bg-muted",
              )}
            >
              <span className={cn(
                "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform",
                ambientStatus?.agentStatus === "running" ? "translate-x-4" : "translate-x-0.5",
              )} />
            </button>
          </div>
        </div>

        {/* Stats bar */}
        <div className="px-3 py-2 border-b border-border/50 flex items-center gap-3 text-xs text-muted-foreground">
          <span>{stats?.total ?? 0} memories</span>
          {(stats?.staleCount ?? 0) > 0 && (
            <span className="text-yellow-500">
              {stats?.staleCount} stale
            </span>
          )}
          <span>~{stats?.estimatedTokens ?? 0} tokens</span>
        </div>

        {/* Search */}
        <div className="px-3 py-2 border-b border-border/50">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              placeholder="Search memories..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 rounded-md border border-border bg-background text-sm"
            />
          </div>
        </div>

        {/* Category filter */}
        <CategoryFilter selected={categoryFilter} onChange={setCategoryFilter} />

        {/* Memory list */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              Loading...
            </div>
          ) : memories?.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              No memories yet. Add one or let them auto-capture from conversations.
            </div>
          ) : (
            memories?.map((m) => (
              <MemoryItem
                key={m.id}
                memory={m}
                isSelected={m.id === selectedId}
                onClick={() => setSelectedId(m.id)}
              />
            ))
          )}
        </div>

        {/* Bottom actions */}
        <div className="border-t border-border p-2 flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAddForm(true)}
            className="text-xs"
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            Add
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (selectedProject?.path) {
                const claudeMdPath = `${selectedProject.path}/CLAUDE.md`
                importMutation.mutate({
                  projectId: selectedProject.id,
                  filePath: claudeMdPath,
                })
              }
            }}
            className="text-xs"
          >
            <Upload className="w-3.5 h-3.5 mr-1" />
            Import
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (selectedProject?.path) {
                validateMutation.mutate({
                  projectId: selectedProject.id,
                  projectPath: selectedProject.path,
                })
              }
            }}
            className="text-xs"
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            Validate
          </Button>
        </div>

        {/* Settings toggles */}
        <div className="border-t border-border p-3 space-y-2">
          <label className="flex items-center justify-between text-xs">
            <span>Auto-capture from conversations</span>
            <input
              type="checkbox"
              checked={autoCaptureEnabled}
              onChange={(e) => setAutoCapture(e.target.checked)}
              className="rounded"
            />
          </label>
          <label className="flex items-center justify-between text-xs">
            <span>Inject into session prompts</span>
            <input
              type="checkbox"
              checked={injectionEnabled}
              onChange={(e) => setInjection(e.target.checked)}
              className="rounded"
            />
          </label>
          <label className="text-xs">
            <span className="block mb-1">Token budget: {tokenBudget}</span>
            <input
              type="range"
              min={500}
              max={5000}
              step={100}
              value={tokenBudget}
              onChange={(e) => setTokenBudget(Number(e.target.value))}
              className="w-full"
            />
          </label>
        </div>
      </div>

      {/* Right panel: detail or add form */}
      <div className="flex-1 min-w-0">
        {showAddForm ? (
          <AddMemoryForm
            projectId={selectedProject.id}
            onCreated={() => {
              setShowAddForm(false)
              refetch()
            }}
            onCancel={() => setShowAddForm(false)}
          />
        ) : selectedMemory ? (
          <MemoryDetail
            memory={selectedMemory}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
            onArchive={handleArchive}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            Select a memory to view details
          </div>
        )}
      </div>
    </div>
  )
}
