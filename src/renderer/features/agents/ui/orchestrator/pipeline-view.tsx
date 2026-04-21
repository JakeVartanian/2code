/**
 * PipelineView — visual flow showing Memory Context → Reasoning → Plan Steps → Expected Outcome.
 * Core visual component of the orchestrator tab.
 *
 * Memory items are swipeable cards: drag left to reveal archive/delete actions.
 */

import { memo, useState, useEffect, useCallback, useMemo } from "react"
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useTransform,
  type PanInfo,
} from "motion/react"
import {
  ChevronDown,
  ChevronRight,
  Brain,
  Lightbulb,
  ListTodo,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Zap,
  Loader2,
  Search,
  Plus,
  Trash2,
  Archive,
  Pencil,
  X,
  Check,
  GripVertical,
} from "lucide-react"
import { cn } from "../../../../lib/utils"
import { trpc } from "../../../../lib/trpc"
import { useAtomValue } from "jotai"
import { selectedProjectAtom } from "../../../../lib/atoms"
import { toast } from "sonner"
import { TaskCard } from "./task-card"
import type { OrchestrationRun, RunStatus, Autonomy } from "../../stores/orchestration-store"

// ═══════════════════════════════════════════════════════════════════════════
// Shared types & constants
// ═══════════════════════════════════════════════════════════════════════════

const CATEGORIES = [
  "architecture",
  "convention",
  "deployment",
  "debugging",
  "preference",
  "gotcha",
] as const

type MemoryCategory = (typeof CATEGORIES)[number]

const CATEGORY_META: Record<MemoryCategory, {
  label: string
  color: string
  textColor: string
  badgeBg: string
  badgeText: string
}> = {
  architecture: { label: "Architecture", color: "border-blue-500/30", textColor: "text-blue-400", badgeBg: "bg-blue-500/15", badgeText: "text-blue-400" },
  convention: { label: "Convention", color: "border-purple-500/30", textColor: "text-purple-400", badgeBg: "bg-purple-500/15", badgeText: "text-purple-400" },
  deployment: { label: "Deployment", color: "border-green-500/30", textColor: "text-green-400", badgeBg: "bg-green-500/15", badgeText: "text-green-400" },
  debugging: { label: "Debugging", color: "border-amber-500/30", textColor: "text-amber-400", badgeBg: "bg-amber-500/15", badgeText: "text-amber-400" },
  preference: { label: "Preference", color: "border-cyan-500/30", textColor: "text-cyan-400", badgeBg: "bg-cyan-500/15", badgeText: "text-cyan-400" },
  gotcha: { label: "Gotcha", color: "border-red-500/30", textColor: "text-red-400", badgeBg: "bg-red-500/15", badgeText: "text-red-400" },
}

const STATE_DOT: Record<string, string> = {
  active: "bg-emerald-400",
  cold: "bg-amber-400",
  dead: "bg-zinc-500",
}

// ═══════════════════════════════════════════════════════════════════════════
// Collapsible section wrapper
// ═══════════════════════════════════════════════════════════════════════════

function PipelineSection({
  title,
  icon: Icon,
  defaultOpen,
  children,
  badge,
}: {
  title: string
  icon: React.ElementType
  defaultOpen?: boolean
  children: React.ReactNode
  badge?: string | number
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen ?? true)

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-accent/30 transition-colors"
      >
        {isOpen ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
        )}
        <Icon className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium">{title}</span>
        {badge !== undefined && (
          <span className="text-xs text-muted-foreground ml-auto">{badge}</span>
        )}
      </button>
      {isOpen && (
        <div className="px-4 pb-3 border-t border-border/30">
          {children}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Swipeable Memory Card — drag left to reveal actions
// ═══════════════════════════════════════════════════════════════════════════

const SWIPE_THRESHOLD = 80
const ACTION_ZONE_WIDTH = 140

function SwipeableMemoryCard({
  memory,
  isExpanded,
  isEditing,
  onToggle,
  onEdit,
  onSave,
  onCancel,
  onDelete,
  onArchive,
}: {
  memory: {
    id: string
    category: string
    title: string
    content: string
    relevanceScore: number
    state: "active" | "cold" | "dead"
    updatedAt: string
  }
  isExpanded: boolean
  isEditing: boolean
  onToggle: () => void
  onEdit: () => void
  onSave: (title: string, content: string, category: MemoryCategory) => void
  onCancel: () => void
  onDelete: () => void
  onArchive: () => void
}) {
  const meta = CATEGORY_META[memory.category as MemoryCategory] ?? CATEGORY_META.preference
  const x = useMotionValue(0)
  const actionOpacity = useTransform(x, [-ACTION_ZONE_WIDTH, -40, 0], [1, 0.5, 0])
  const actionScale = useTransform(x, [-ACTION_ZONE_WIDTH, -40, 0], [1, 0.8, 0.6])
  const [swiped, setSwiped] = useState(false)

  const [editTitle, setEditTitle] = useState(memory.title)
  const [editContent, setEditContent] = useState(memory.content)
  const [editCategory, setEditCategory] = useState(memory.category as MemoryCategory)

  const handleStartEdit = useCallback(() => {
    setEditTitle(memory.title)
    setEditContent(memory.content)
    setEditCategory(memory.category as MemoryCategory)
    onEdit()
  }, [memory, onEdit])

  const handleDragEnd = useCallback((_: any, info: PanInfo) => {
    if (info.offset.x < -SWIPE_THRESHOLD) {
      setSwiped(true)
    } else {
      setSwiped(false)
    }
  }, [])

  // Close swipe when expanding/collapsing
  useEffect(() => {
    setSwiped(false)
  }, [isExpanded])

  return (
    <div className="relative overflow-hidden rounded-lg mb-1.5">
      {/* Action buttons behind the card */}
      <motion.div
        className="absolute inset-y-0 right-0 flex items-center gap-1 pr-2"
        style={{ opacity: actionOpacity, scale: actionScale, width: ACTION_ZONE_WIDTH }}
      >
        <button
          onClick={(e) => { e.stopPropagation(); onArchive(); setSwiped(false) }}
          className="flex-1 h-full flex flex-col items-center justify-center rounded-md bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors"
        >
          <Archive className="w-4 h-4" />
          <span className="text-[9px] mt-0.5">Archive</span>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); setSwiped(false) }}
          className="flex-1 h-full flex flex-col items-center justify-center rounded-md bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
        >
          <Trash2 className="w-4 h-4" />
          <span className="text-[9px] mt-0.5">Delete</span>
        </button>
      </motion.div>

      {/* Draggable card surface */}
      <motion.div
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: -ACTION_ZONE_WIDTH, right: 0 }}
        dragElastic={0.1}
        dragMomentum={false}
        onDragEnd={handleDragEnd}
        animate={{ x: swiped ? -ACTION_ZONE_WIDTH : 0 }}
        transition={{ type: "spring", stiffness: 400, damping: 35 }}
        style={{ x }}
        className={cn(
          "relative rounded-lg border bg-background/80 backdrop-blur-sm cursor-grab active:cursor-grabbing",
          "transition-shadow hover:shadow-md",
          meta.color,
        )}
      >
        {/* Row header */}
        <button
          onClick={onToggle}
          className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
        >
          <GripVertical className="w-3 h-3 text-zinc-600 shrink-0 opacity-40" />
          <span className={cn("inline-block w-2 h-2 rounded-full shrink-0", STATE_DOT[memory.state])} />
          <span className={cn("px-1.5 py-0 rounded text-[10px] font-medium shrink-0", meta.badgeBg, meta.badgeText)}>
            {meta.label}
          </span>
          <span className="text-[13px] text-zinc-200 flex-1 truncate">{memory.title}</span>
          <span className="text-[10px] font-mono text-zinc-600 shrink-0 tabular-nums">{memory.relevanceScore}</span>
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-zinc-500 shrink-0" />
          )}
        </button>

        {/* Expanded content */}
        <AnimatePresence>
          {isExpanded && !isEditing && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="overflow-hidden"
            >
              <div className="px-3 pb-3 pl-[46px] space-y-2">
                <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap">
                  {memory.content}
                </p>
                <div className="flex items-center gap-2 text-[10px] text-zinc-600">
                  <span className="capitalize">{memory.state}</span>
                  {memory.updatedAt && (
                    <span>{new Date(memory.updatedAt).toLocaleDateString()}</span>
                  )}
                </div>
                <div className="flex items-center gap-1 pt-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleStartEdit() }}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                  >
                    <Pencil className="w-3 h-3" />
                    Edit
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onArchive() }}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-zinc-400 hover:text-amber-400 hover:bg-zinc-800 transition-colors"
                  >
                    <Archive className="w-3 h-3" />
                    Archive
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete() }}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-zinc-400 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                    Delete
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {isExpanded && isEditing && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="overflow-hidden"
            >
              <div className="px-3 pb-3 pl-[46px] space-y-2">
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full px-2 py-1 rounded border border-zinc-700 bg-zinc-900 text-sm text-zinc-200"
                  placeholder="Title"
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
                <select
                  value={editCategory}
                  onChange={(e) => setEditCategory(e.target.value as MemoryCategory)}
                  className="w-full px-2 py-1 rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-300 capitalize"
                  onClick={(e) => e.stopPropagation()}
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>{CATEGORY_META[cat].label}</option>
                  ))}
                </select>
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={4}
                  className="w-full px-2 py-1 rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-300 font-mono resize-y"
                  placeholder="Content (markdown)"
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={(e) => { e.stopPropagation(); onSave(editTitle, editContent, editCategory) }}
                    disabled={!editTitle.trim() || !editContent.trim()}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-40"
                  >
                    <Check className="w-3 h-3" />
                    Save
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onCancel() }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                  >
                    <X className="w-3 h-3" />
                    Cancel
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Add Memory Inline Form
// ═══════════════════════════════════════════════════════════════════════════

function AddMemoryInline({
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
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="overflow-hidden"
    >
      <div className="rounded-lg border border-dashed border-blue-500/30 bg-blue-500/5 p-3 mb-2 space-y-2">
        <div className="flex items-center gap-2 text-xs font-medium text-blue-400">
          <Plus className="w-3.5 h-3.5" />
          New Memory
        </div>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full px-2 py-1 rounded border border-zinc-700 bg-zinc-900 text-sm text-zinc-200"
          placeholder="Title (short summary)"
          autoFocus
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as MemoryCategory)}
          className="w-full px-2 py-1 rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-300 capitalize"
        >
          {CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>{CATEGORY_META[cat].label}</option>
          ))}
        </select>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={3}
          className="w-full px-2 py-1 rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-300 font-mono resize-y"
          placeholder="Content (markdown)"
        />
        <div className="flex items-center gap-1.5">
          <button
            onClick={() =>
              createMutation.mutate({ projectId, title, content, category, source: "manual" })
            }
            disabled={!title.trim() || !content.trim() || createMutation.isPending}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-40"
          >
            <Check className="w-3 h-3" />
            Add
          </button>
          <button
            onClick={onCancel}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <X className="w-3 h-3" />
            Cancel
          </button>
        </div>
      </div>
    </motion.div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Memory Context Section — interactive, swipeable memory list
// ═══════════════════════════════════════════════════════════════════════════

// Helper: derive memory state from relevance + staleness
function deriveMemoryState(memory: {
  relevanceScore: number
  isStale?: boolean | null
  isArchived?: boolean | null
}): "active" | "cold" | "dead" {
  if (memory.isArchived) return "dead"
  if (memory.isStale) return "cold"
  if (memory.relevanceScore < 20) return "cold"
  return "active"
}

function MemorySection({ projectId }: { projectId: string | null }) {
  const selectedProject = useAtomValue(selectedProjectAtom)
  const [search, setSearch] = useState("")
  const [categoryFilter, setCategoryFilter] = useState<MemoryCategory | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const { data: stats } = trpc.memory.stats.useQuery(
    { projectId: projectId || "" },
    { enabled: !!projectId, refetchInterval: 10_000 },
  )

  const { data: memories, refetch: refetchList } = trpc.memory.list.useQuery(
    { projectId: projectId || "", includeArchived: false, includeStale: true },
    { enabled: !!projectId, refetchInterval: 10_000 },
  )

  const utils = trpc.useUtils()

  const buildBrainMutation = trpc.ambient.buildBrain.useMutation({
    onSuccess: (result) => {
      if (result.success) {
        const parts = [`${result.memoriesCreated} created`]
        if ((result.memoriesUpdated ?? 0) > 0) parts.push(`${result.memoriesUpdated} updated`)
        if ((result.failedPasses?.length ?? 0) > 0) parts.push(`${result.failedPasses!.length} passes failed`)
        const duration = result.durationMs ? ` (${Math.round(result.durationMs / 1000)}s)` : ""
        toast.success(`Brain built: ${parts.join(", ")}${duration}`)
        refetchList()
      } else {
        toast.error(result.error ?? "Failed to build brain")
      }
    },
    onError: (err) => toast.error(err.message),
  })

  const updateMutation = trpc.memory.update.useMutation({
    onSuccess: () => {
      toast.success("Memory updated")
      setEditingId(null)
      refetchList()
    },
    onError: (err) => toast.error(err.message),
  })

  const deleteMutation = trpc.memory.delete.useMutation({
    onSuccess: () => {
      toast.success("Memory deleted")
      setExpandedId(null)
      refetchList()
    },
    onError: (err) => toast.error(err.message),
  })

  // Map DB memories to display format
  const displayMemories = useMemo(() => {
    if (!memories) return []
    return memories.map((m) => ({
      id: m.id,
      category: m.category,
      title: m.title,
      content: m.content,
      relevanceScore: m.relevanceScore,
      state: deriveMemoryState(m),
      updatedAt: m.updatedAt instanceof Date
        ? m.updatedAt.toISOString()
        : String(m.updatedAt ?? ""),
    }))
  }, [memories])

  // Filter
  const filtered = useMemo(() => {
    let result = displayMemories
    if (categoryFilter) {
      result = result.filter((m) => m.category === categoryFilter)
    }
    if (search) {
      const s = search.toLowerCase()
      result = result.filter(
        (m) =>
          m.title.toLowerCase().includes(s) ||
          m.content.toLowerCase().includes(s),
      )
    }
    return result
  }, [displayMemories, categoryFilter, search])

  // Category counts
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: displayMemories.length }
    for (const cat of CATEGORIES) {
      counts[cat] = displayMemories.filter((m) => m.category === cat).length
    }
    return counts
  }, [displayMemories])

  const handleSave = useCallback(
    (id: string, title: string, content: string, category: MemoryCategory) => {
      updateMutation.mutate({ id, title, content, category })
    },
    [updateMutation],
  )

  const handleArchive = useCallback(
    (id: string) => {
      updateMutation.mutate({ id, isArchived: true })
      setExpandedId(null)
    },
    [updateMutation],
  )

  const handleDelete = useCallback(
    (id: string) => {
      deleteMutation.mutate({ id })
    },
    [deleteMutation],
  )

  const hasMemories = displayMemories.length > 0

  return (
    <PipelineSection
      title="Memory Context"
      icon={Brain}
      badge={stats ? `${stats.total} memories` : undefined}
    >
      <div className="pt-2 space-y-2">
        {/* Stats bar */}
        {stats && (
          <div className="flex gap-3 text-xs text-muted-foreground mb-1">
            <span>{stats.total} total</span>
            {stats.staleCount > 0 && (
              <span className="text-yellow-500">{stats.staleCount} stale</span>
            )}
            <span>~{stats.estimatedTokens} tokens</span>
          </div>
        )}

        {hasMemories ? (
          <>
            {/* Search + Add */}
            <div className="flex items-center gap-2">
              <div className="flex-1 relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-600" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search memories..."
                  className="w-full pl-7 pr-2 py-1.5 rounded-md border border-zinc-800 bg-zinc-900/50 text-xs text-zinc-300 placeholder:text-zinc-600"
                />
              </div>
              <button
                onClick={() => setShowAdd(!showAdd)}
                className={cn(
                  "p-1.5 rounded-md transition-colors",
                  showAdd
                    ? "bg-blue-600 text-white"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800",
                )}
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Category filter pills */}
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => setCategoryFilter(null)}
                className={cn(
                  "px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors",
                  !categoryFilter
                    ? "bg-foreground/15 text-foreground"
                    : "bg-zinc-800/50 text-zinc-500 hover:bg-zinc-800",
                )}
              >
                All {categoryCounts.all}
              </button>
              {CATEGORIES.map((cat) => {
                const count = categoryCounts[cat] ?? 0
                if (count === 0) return null
                const m = CATEGORY_META[cat]
                return (
                  <button
                    key={cat}
                    onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
                    className={cn(
                      "px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors",
                      categoryFilter === cat
                        ? `${m.badgeBg} ${m.badgeText}`
                        : "bg-zinc-800/50 text-zinc-500 hover:bg-zinc-800",
                    )}
                  >
                    {m.label} {count}
                  </button>
                )
              })}
            </div>

            {/* Add form */}
            <AnimatePresence>
              {showAdd && selectedProject && (
                <AddMemoryInline
                  projectId={selectedProject.id}
                  onCreated={() => {
                    setShowAdd(false)
                    refetchList()
                  }}
                  onCancel={() => setShowAdd(false)}
                />
              )}
            </AnimatePresence>

            {/* Swipeable memory list */}
            <div className="max-h-[420px] overflow-y-auto pr-0.5 space-y-0">
              <AnimatePresence>
                {filtered.length === 0 ? (
                  <p className="text-xs text-zinc-600 text-center py-4">
                    {search ? "No matching memories" : "No memories in this category"}
                  </p>
                ) : (
                  filtered.map((memory) => (
                    <motion.div
                      key={memory.id}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, x: -200, height: 0 }}
                      transition={{ duration: 0.25 }}
                    >
                      <SwipeableMemoryCard
                        memory={memory}
                        isExpanded={expandedId === memory.id}
                        isEditing={editingId === memory.id}
                        onToggle={() => setExpandedId(expandedId === memory.id ? null : memory.id)}
                        onEdit={() => setEditingId(memory.id)}
                        onSave={(title, content, category) => handleSave(memory.id, title, content, category)}
                        onCancel={() => setEditingId(null)}
                        onDelete={() => handleDelete(memory.id)}
                        onArchive={() => handleArchive(memory.id)}
                      />
                    </motion.div>
                  ))
                )}
              </AnimatePresence>
            </div>

            {/* Footer stats */}
            <div className="flex items-center gap-3 text-[10px] text-zinc-600 pt-1">
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                {displayMemories.filter((m) => m.state === "active").length} active
              </span>
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                {displayMemories.filter((m) => m.state === "cold").length} cold
              </span>
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
                {displayMemories.filter((m) => m.state === "dead").length} dead
              </span>
              <span className="ml-auto text-zinc-700">
                swipe left on cards for actions
              </span>
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-col items-center gap-2 py-6">
              <Brain className="w-8 h-8 text-zinc-700" />
              <p className="text-xs text-muted-foreground text-center max-w-[280px]">
                No memories yet. Build the brain from your project, or they'll auto-capture from conversations.
              </p>
            </div>
            {selectedProject && (
              <button
                onClick={() =>
                  buildBrainMutation.mutate({
                    projectId: selectedProject.id,
                    projectPath: selectedProject.path,
                  })
                }
                disabled={buildBrainMutation.isPending}
                className={cn(
                  "w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md",
                  "border border-dashed border-purple-500/40 bg-purple-500/5",
                  "text-xs text-purple-400 hover:bg-purple-500/10 transition-colors",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                )}
              >
                {buildBrainMutation.isPending ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span>Building...</span>
                  </>
                ) : (
                  <>
                    <Zap className="w-3 h-3" />
                    <span>Build Brain from Project</span>
                  </>
                )}
              </button>
            )}

            {/* Add button even when empty */}
            <AnimatePresence>
              {showAdd && selectedProject ? (
                <AddMemoryInline
                  projectId={selectedProject.id}
                  onCreated={() => {
                    setShowAdd(false)
                    refetchList()
                  }}
                  onCancel={() => setShowAdd(false)}
                />
              ) : selectedProject && (
                <button
                  onClick={() => setShowAdd(true)}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-dashed border-zinc-700 text-xs text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  Add Memory Manually
                </button>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
    </PipelineSection>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Reasoning section
// ═══════════════════════════════════════════════════════════════════════════

function ReasoningSection({
  userGoal,
  decomposedPlan,
}: {
  userGoal: string
  decomposedPlan: string
}) {
  let planData: any = {}
  try {
    planData = JSON.parse(decomposedPlan)
  } catch { /* ignore */ }

  return (
    <PipelineSection title="Reasoning" icon={Lightbulb} defaultOpen={true}>
      <div className="pt-2 space-y-2">
        <div>
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Goal
          </span>
          <p className="text-sm mt-0.5">{userGoal}</p>
        </div>
        {planData.reasoning && (
          <div>
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Approach
            </span>
            <p className="text-xs text-muted-foreground mt-0.5">
              {planData.reasoning}
            </p>
          </div>
        )}
        {planData.type === "existing-tabs" && (
          <div className="text-xs text-blue-400 bg-blue-500/10 px-2 py-1 rounded">
            Orchestrating {planData.tabs?.length ?? 0} existing tabs
          </div>
        )}
      </div>
    </PipelineSection>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Status bar
// ═══════════════════════════════════════════════════════════════════════════

function StatusBar({ run }: { run: OrchestrationRun }) {
  const completedCount = run.tasks.filter((t) => t.status === "completed").length
  const failedCount = run.tasks.filter((t) => t.status === "failed").length
  const runningCount = run.tasks.filter((t) => t.status === "running").length
  const stuckCount = run.tasks.filter((t) => t.status === "stuck").length
  const totalCount = run.tasks.length

  const [elapsed, setElapsed] = useState("")
  useEffect(() => {
    if (!run.startedAt) {
      setElapsed("")
      return
    }

    const compute = () => {
      const diff = (run.completedAt ?? new Date()).getTime() - run.startedAt!.getTime()
      const mins = Math.floor(diff / 60000)
      const secs = Math.floor((diff % 60000) / 1000)
      setElapsed(mins > 0 ? `${mins}m ${secs}s` : `${secs}s`)
    }

    compute()

    if (!run.completedAt) {
      const interval = setInterval(compute, 1000)
      return () => clearInterval(interval)
    }
  }, [run.startedAt, run.completedAt])

  const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0

  const statusLabel: Record<RunStatus, string> = {
    planning: "Planning",
    running: "Running",
    paused: "Paused",
    validating: "Validating",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  }

  const statusColor: Record<RunStatus, string> = {
    planning: "text-blue-400",
    running: "text-green-400",
    paused: "text-yellow-400",
    validating: "text-purple-400",
    completed: "text-green-500",
    failed: "text-red-500",
    cancelled: "text-muted-foreground",
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2 border border-border/50 rounded-lg bg-muted/30">
      <span className={cn("text-sm font-medium", statusColor[run.status])}>
        {run.status === "running" && <span className="inline-block animate-pulse mr-1">●</span>}
        {statusLabel[run.status]}
      </span>

      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            run.status === "completed" ? "bg-green-500" :
            run.status === "failed" ? "bg-red-500" :
            "bg-blue-500",
          )}
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
        <span>{completedCount}/{totalCount}</span>
        {runningCount > 0 && <span className="text-green-400">{runningCount} active</span>}
        {failedCount > 0 && <span className="text-red-400">{failedCount} failed</span>}
        {stuckCount > 0 && (
          <span className="text-orange-400 flex items-center gap-0.5">
            <AlertTriangle className="w-3 h-3" />
            {stuckCount}
          </span>
        )}
        {elapsed && (
          <span className="flex items-center gap-0.5">
            <Clock className="w-3 h-3" />
            {elapsed}
          </span>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Plan section
// ═══════════════════════════════════════════════════════════════════════════

function PlanSection({
  run,
  onAutonomyChange,
  onNavigateToTab,
  onRetryTask,
  onSkipTask,
}: {
  run: OrchestrationRun
  onAutonomyChange: (taskId: string, autonomy: Autonomy) => void
  onNavigateToTab: (subChatId: string) => void
  onRetryTask?: (taskId: string) => void
  onSkipTask?: (taskId: string) => void
}) {
  const completedCount = run.tasks.filter((t) => t.status === "completed").length
  const queuedTasks = run.tasks.filter((t) => t.status === "queued")

  return (
    <PipelineSection
      title="Plan"
      icon={ListTodo}
      badge={`${completedCount}/${run.tasks.length} done`}
    >
      <div className="pt-2 space-y-2">
        {run.tasks
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              allTasks={run.tasks}
              onAutonomyChange={onAutonomyChange}
              onNavigateToTab={onNavigateToTab}
              onRetryTask={onRetryTask}
              onSkipTask={onSkipTask}
              queuePosition={
                task.status === "queued"
                  ? queuedTasks.indexOf(task) + 1
                  : undefined
              }
            />
          ))}
        {run.tasks.length === 0 && (
          <p className="text-xs text-muted-foreground">No tasks yet.</p>
        )}
      </div>
    </PipelineSection>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Outcome section
// ═══════════════════════════════════════════════════════════════════════════

function OutcomeSection({ run }: { run: OrchestrationRun }) {
  const completedTasks = run.tasks.filter(
    (t) => t.status === "completed" && t.resultSummary,
  )
  const failedTasks = run.tasks.filter(
    (t) => t.status === "failed" && t.resultSummary,
  )
  const isTerminal = ["completed", "failed", "cancelled"].includes(run.status)

  if (!isTerminal && completedTasks.length === 0 && failedTasks.length === 0) return null

  return (
    <PipelineSection
      title={isTerminal ? "Outcome" : "Progress"}
      icon={CheckCircle2}
      defaultOpen={true}
    >
      <div className="pt-2 space-y-2">
        {isTerminal && run.summary && (
          <div className="text-sm whitespace-pre-wrap">{run.summary}</div>
        )}

        {isTerminal && !run.summary && (
          <p className={cn("text-xs", run.status === "completed" ? "text-green-500" : "text-red-500")}>
            {run.status === "completed"
              ? "All tasks completed successfully."
              : run.status === "cancelled"
                ? "Orchestration was cancelled."
                : "Orchestration failed. Check individual task statuses."}
          </p>
        )}

        {(!isTerminal || !run.summary) && completedTasks.length > 0 && (
          <div className="space-y-1">
            {!isTerminal && (
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Completed
              </span>
            )}
            {completedTasks.map((t) => (
              <div key={t.id} className="text-xs bg-green-500/5 border border-green-500/20 rounded p-2">
                <span className="font-medium text-green-500">{t.name}:</span>{" "}
                <span className="text-muted-foreground">{t.resultSummary}</span>
              </div>
            ))}
          </div>
        )}

        {failedTasks.length > 0 && (
          <div className="space-y-1">
            <span className="text-[10px] font-medium text-red-400 uppercase tracking-wider">
              Failed
            </span>
            {failedTasks.map((t) => (
              <div key={t.id} className="text-xs bg-red-500/5 border border-red-500/20 rounded p-2">
                <span className="font-medium text-red-400">{t.name}:</span>{" "}
                <span className="text-muted-foreground">{t.resultSummary}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </PipelineSection>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Main PipelineView
// ═══════════════════════════════════════════════════════════════════════════

interface PipelineViewProps {
  run: OrchestrationRun | null
  projectId: string | null
  onAutonomyChange: (taskId: string, autonomy: Autonomy) => void
  onNavigateToTab: (subChatId: string) => void
  onRetryTask?: (taskId: string) => void
  onSkipTask?: (taskId: string) => void
}

export const PipelineView = memo(function PipelineView({
  run,
  projectId,
  onAutonomyChange,
  onNavigateToTab,
  onRetryTask,
  onSkipTask,
}: PipelineViewProps) {
  return (
    <div className="space-y-3 p-4">
      {/* Status bar — only during active/completed runs */}
      {run && <StatusBar run={run} />}

      {/* Memory always shows */}
      <MemorySection projectId={projectId} />

      {/* Reasoning + Plan + Outcome only when there's an active run */}
      {run && (
        <>
          <ReasoningSection
            userGoal={run.userGoal}
            decomposedPlan={run.decomposedPlan}
          />
          <PlanSection
            run={run}
            onAutonomyChange={onAutonomyChange}
            onNavigateToTab={onNavigateToTab}
            onRetryTask={onRetryTask}
            onSkipTask={onSkipTask}
          />
          <OutcomeSection run={run} />
        </>
      )}
    </div>
  )
})
