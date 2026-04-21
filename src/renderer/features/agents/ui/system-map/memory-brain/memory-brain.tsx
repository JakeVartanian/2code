/**
 * MemoryBrain — interactive memory list with category filtering,
 * inline editing, and full CRUD operations. Replaces the visual-only
 * galaxy visualization with a functional, usable interface.
 */

import { memo, useMemo, useState, useCallback } from "react"
import {
  Brain,
  Search,
  Plus,
  Trash2,
  Archive,
  ChevronDown,
  ChevronRight,
  Pencil,
  X,
  Check,
  AlertTriangle,
} from "lucide-react"
import { useAtomValue } from "jotai"
import { toast } from "sonner"

import { cn } from "../../../../../lib/utils"
import { trpc } from "../../../../../lib/trpc"
import { selectedProjectAtom } from "../../../../../lib/atoms"
import { CATEGORIES, CATEGORY_META, type Category } from "./constants"

// ─── Types ──────────────────────────────────────────────────────────────────

interface Memory {
  id: string
  category: string
  title: string
  content: string
  relevanceScore: number
  state: "active" | "cold" | "dead"
  updatedAt: string
}

interface MemoryBrainProps {
  memories: Memory[]
}

// ─── State dot color ────────────────────────────────────────────────────────

const STATE_DOT: Record<string, string> = {
  active: "bg-emerald-400",
  cold: "bg-amber-400",
  dead: "bg-zinc-500",
}

// ─── Category pill ──────────────────────────────────────────────────────────

function CategoryPill({
  category,
  selected,
  count,
  onClick,
}: {
  category: Category | null
  selected: boolean
  count: number
  onClick: () => void
}) {
  const meta = category ? CATEGORY_META[category] : null
  const label = category ? meta!.label : "All"

  return (
    <button
      onClick={onClick}
      className={cn(
        "px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors flex items-center gap-1",
        selected
          ? category
            ? `${meta!.badgeBg} ${meta!.badgeText}`
            : "bg-foreground/15 text-foreground"
          : "bg-zinc-800/50 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-400",
      )}
    >
      {label}
      <span className="text-[10px] opacity-70">{count}</span>
    </button>
  )
}

// ─── Memory row ─────────────────────────────────────────────────────────────

function MemoryRow({
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
  memory: Memory
  isExpanded: boolean
  isEditing: boolean
  onToggle: () => void
  onEdit: () => void
  onSave: (title: string, content: string, category: Category) => void
  onCancel: () => void
  onDelete: () => void
  onArchive: () => void
}) {
  const meta = CATEGORY_META[memory.category as Category] ?? CATEGORY_META.preference
  const Icon = meta.icon
  const [editTitle, setEditTitle] = useState(memory.title)
  const [editContent, setEditContent] = useState(memory.content)
  const [editCategory, setEditCategory] = useState(memory.category as Category)

  // Reset edit state when starting to edit
  const handleStartEdit = useCallback(() => {
    setEditTitle(memory.title)
    setEditContent(memory.content)
    setEditCategory(memory.category as Category)
    onEdit()
  }, [memory, onEdit])

  return (
    <div
      className={cn(
        "border-b border-zinc-800/50 last:border-b-0 transition-colors",
        isExpanded ? "bg-zinc-900/30" : "hover:bg-zinc-900/20",
      )}
    >
      {/* Row header — always visible, clickable */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        {isExpanded ? (
          <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-zinc-500 shrink-0" />
        )}
        <Icon className={cn("w-3.5 h-3.5 shrink-0", meta.textColor)} />
        <span
          className={cn(
            "inline-block w-1.5 h-1.5 rounded-full shrink-0",
            STATE_DOT[memory.state],
          )}
        />
        <span className="text-[13px] text-zinc-200 flex-1 truncate">
          {memory.title}
        </span>
        <span className="text-[10px] font-mono text-zinc-600 shrink-0">
          {memory.relevanceScore}
        </span>
      </button>

      {/* Expanded detail */}
      {isExpanded && !isEditing && (
        <div className="px-3 pb-3 pl-[42px] space-y-2">
          <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap">
            {memory.content}
          </p>
          <div className="flex items-center gap-3 text-[10px] text-zinc-600">
            <span className={cn("px-1.5 py-0.5 rounded", meta.badgeBg, meta.badgeText)}>
              {meta.label}
            </span>
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
      )}

      {/* Edit mode */}
      {isExpanded && isEditing && (
        <div className="px-3 pb-3 pl-[42px] space-y-2">
          <input
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            className="w-full px-2 py-1 rounded border border-zinc-700 bg-zinc-900 text-sm text-zinc-200"
            placeholder="Title"
            autoFocus
          />
          <select
            value={editCategory}
            onChange={(e) => setEditCategory(e.target.value as Category)}
            className="w-full px-2 py-1 rounded border border-zinc-700 bg-zinc-900 text-xs text-zinc-300 capitalize"
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
          />
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => onSave(editTitle, editContent, editCategory)}
              disabled={!editTitle.trim() || !editContent.trim()}
              className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-40"
            >
              <Check className="w-3 h-3" />
              Save
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
      )}
    </div>
  )
}

// ─── Add Memory Inline ──────────────────────────────────────────────────────

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
  const [category, setCategory] = useState<Category>("preference")

  const createMutation = trpc.memory.create.useMutation({
    onSuccess: () => {
      toast.success("Memory added")
      onCreated()
    },
    onError: (err) => toast.error(err.message),
  })

  return (
    <div className="border-b border-zinc-800/50 bg-zinc-900/30 px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-zinc-300">
        <Plus className="w-3.5 h-3.5" />
        Add Memory
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
        onChange={(e) => setCategory(e.target.value as Category)}
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
  )
}

// ─── Empty State ────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 px-8">
      <div className="w-10 h-10 rounded-xl border border-zinc-800 bg-zinc-900/50 flex items-center justify-center">
        <Brain className="w-5 h-5 text-zinc-600" />
      </div>
      <div className="text-center space-y-1">
        <p className="text-sm font-medium text-zinc-300">No Memories</p>
        <p className="text-xs text-zinc-600 max-w-[280px] leading-relaxed">
          Memories are auto-captured from conversations, or you can add them manually.
          Build the brain from Settings to bootstrap from your codebase.
        </p>
      </div>
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export const MemoryBrain = memo(function MemoryBrain({
  memories,
}: MemoryBrainProps) {
  const selectedProject = useAtomValue(selectedProjectAtom)
  const [search, setSearch] = useState("")
  const [categoryFilter, setCategoryFilter] = useState<Category | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  // tRPC mutations
  const utils = trpc.useUtils()
  const updateMutation = trpc.memory.update.useMutation({
    onSuccess: () => {
      toast.success("Memory updated")
      setEditingId(null)
      if (selectedProject?.id) utils.memory.list.invalidate()
    },
    onError: (err) => toast.error(err.message),
  })

  const deleteMutation = trpc.memory.delete.useMutation({
    onSuccess: () => {
      toast.success("Memory deleted")
      setExpandedId(null)
      if (selectedProject?.id) utils.memory.list.invalidate()
    },
    onError: (err) => toast.error(err.message),
  })

  // Filter memories
  const filtered = useMemo(() => {
    let result = memories
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
  }, [memories, categoryFilter, search])

  // Category counts
  const categoryCounts = useMemo(() => {
    const counts = new Map<Category | null, number>()
    counts.set(null, memories.length)
    for (const cat of CATEGORIES) {
      counts.set(cat, memories.filter((m) => m.category === cat).length)
    }
    return counts
  }, [memories])

  const handleSave = useCallback(
    (id: string, title: string, content: string, category: Category) => {
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

  if (memories.length === 0 && !showAdd) {
    return (
      <div>
        <EmptyState />
        {selectedProject && (
          <div className="px-3 pb-2">
            <button
              onClick={() => setShowAdd(true)}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-dashed border-zinc-700 text-xs text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 transition-colors"
            >
              <Plus className="w-3 h-3" />
              Add Memory
            </button>
          </div>
        )}
        {showAdd && selectedProject && (
          <AddMemoryInline
            projectId={selectedProject.id}
            onCreated={() => {
              setShowAdd(false)
              utils.memory.list.invalidate()
            }}
            onCancel={() => setShowAdd(false)}
          />
        )}
      </div>
    )
  }

  return (
    <div>
      {/* Search + add button */}
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="flex-1 relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-600" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search memories..."
            className="w-full pl-7 pr-2 py-1 rounded border border-zinc-800 bg-zinc-900/50 text-xs text-zinc-300 placeholder:text-zinc-600"
          />
        </div>
        {selectedProject && (
          <button
            onClick={() => setShowAdd(!showAdd)}
            className={cn(
              "p-1.5 rounded transition-colors",
              showAdd
                ? "bg-zinc-700 text-zinc-200"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800",
            )}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Category filters */}
      <div className="flex flex-wrap gap-1 px-3 pb-2">
        <CategoryPill
          category={null}
          selected={categoryFilter === null}
          count={categoryCounts.get(null) ?? 0}
          onClick={() => setCategoryFilter(null)}
        />
        {CATEGORIES.map((cat) => {
          const count = categoryCounts.get(cat) ?? 0
          if (count === 0) return null
          return (
            <CategoryPill
              key={cat}
              category={cat}
              selected={categoryFilter === cat}
              count={count}
              onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
            />
          )
        })}
      </div>

      {/* Add memory form */}
      {showAdd && selectedProject && (
        <AddMemoryInline
          projectId={selectedProject.id}
          onCreated={() => {
            setShowAdd(false)
            utils.memory.list.invalidate()
          }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {/* Memory list */}
      <div className="max-h-[400px] overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="py-6 text-center text-xs text-zinc-600">
            {search ? "No matching memories" : "No memories in this category"}
          </div>
        ) : (
          filtered.map((memory) => (
            <MemoryRow
              key={memory.id}
              memory={memory}
              isExpanded={expandedId === memory.id}
              isEditing={editingId === memory.id}
              onToggle={() =>
                setExpandedId(expandedId === memory.id ? null : memory.id)
              }
              onEdit={() => setEditingId(memory.id)}
              onSave={(title, content, category) =>
                handleSave(memory.id, title, content, category)
              }
              onCancel={() => setEditingId(null)}
              onDelete={() => handleDelete(memory.id)}
              onArchive={() => handleArchive(memory.id)}
            />
          ))
        )}
      </div>

      {/* Footer stats */}
      <div className="flex items-center gap-3 px-3 py-1.5 text-[10px] text-zinc-600 border-t border-zinc-800/50">
        <span>{memories.filter((m) => m.state === "active").length} active</span>
        <span>{memories.filter((m) => m.state === "cold").length} cold</span>
        <span>{memories.filter((m) => m.state === "dead").length} dead</span>
        <span className="ml-auto">
          avg relevance: {memories.length > 0 ? Math.round(memories.reduce((s, m) => s + m.relevanceScore, 0) / memories.length) : 0}
        </span>
      </div>
    </div>
  )
})
