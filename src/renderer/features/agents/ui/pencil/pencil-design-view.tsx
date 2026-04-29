/**
 * PencilDesignView — Main container for the Design (Pencil) tab.
 * The "design brain" for the project: brand kit, design voice,
 * visual references, design memories, and GAAD design insights.
 *
 * Every section is interactive — add, edit, delete — and all content
 * is persisted as project memories that get injected into Claude sessions.
 */

import { memo, useState, useCallback, useRef, useMemo } from "react"
import { useAtomValue, useSetAtom } from "jotai"
import {
  Pencil,
  Palette,
  Type,
  Image,
  MessageSquareQuote,
  Brain,
  ChevronDown,
  ChevronRight,
  Plus,
  Sparkles,
  ArrowLeft,
  Loader2,
  Send,
  X,
  Trash2,
  Edit3,
  Check,
  ImagePlus,
  Wand2,
} from "lucide-react"
import { cn } from "../../../../lib/utils"
import { selectedProjectAtom } from "../../../../lib/atoms"
import { trpc } from "../../../../lib/trpc"
import { toast } from "sonner"
import { useAmbientStore, type AmbientSuggestion } from "../../../ambient/store"
import { assessmentPanelSuggestionIdAtom } from "../../../ambient/atoms"

interface PencilDesignViewProps {
  chatId: string
  subChatId: string
}

// ─── Collapsible Section ────────────────────────────────────────────────────

function Section({
  title,
  icon,
  iconColor,
  count,
  defaultOpen = false,
  children,
  action,
}: {
  title: string
  icon: React.ReactNode
  iconColor?: string
  count?: number
  defaultOpen?: boolean
  children: React.ReactNode
  action?: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center w-full px-4 py-3 text-left hover:bg-zinc-800/30 transition-colors"
      >
        <span className={cn("mr-2", iconColor)}>{icon}</span>
        <span className="text-xs font-medium text-zinc-300 flex-1">{title}</span>
        {count !== undefined && (
          <span className="text-[10px] text-zinc-500 font-mono mr-2">{count}</span>
        )}
        {action && <span className="mr-2" onClick={e => e.stopPropagation()}>{action}</span>}
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
        )}
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  )
}

// ─── Inline Add Form ───────────────────────────────────────────────────────

function InlineAddForm({
  onSave,
  onCancel,
  titlePlaceholder = "Title",
  contentPlaceholder = "Content",
  saving = false,
}: {
  onSave: (title: string, content: string) => void
  onCancel: () => void
  titlePlaceholder?: string
  contentPlaceholder?: string
  saving?: boolean
}) {
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")

  return (
    <div className="space-y-1.5 p-2 rounded-md border border-yellow-500/20 bg-yellow-500/5">
      <input
        type="text"
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder={titlePlaceholder}
        className="w-full bg-transparent text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none border-b border-zinc-800 pb-1"
        autoFocus
      />
      <textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        placeholder={contentPlaceholder}
        rows={2}
        className="w-full bg-transparent text-[10px] text-zinc-400 placeholder:text-zinc-600 focus:outline-none resize-none"
      />
      <div className="flex items-center gap-1.5 justify-end">
        <button onClick={onCancel} className="text-[10px] text-zinc-500 hover:text-zinc-300 px-2 py-0.5">
          Cancel
        </button>
        <button
          onClick={() => { if (title.trim() && content.trim()) onSave(title.trim(), content.trim()) }}
          disabled={!title.trim() || !content.trim() || saving}
          className="flex items-center gap-1 text-[10px] text-yellow-300 bg-yellow-500/10 hover:bg-yellow-500/15 px-2 py-0.5 rounded disabled:opacity-40"
        >
          {saving ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Check className="w-2.5 h-2.5" />}
          Save
        </button>
      </div>
    </div>
  )
}

// ─── Memory Item (editable/deletable) ──────────────────────────────────────

function MemoryItem({
  id,
  title,
  content,
  color,
  onDelete,
  onUpdate,
}: {
  id: string
  title: string
  content: string
  color?: string
  onDelete: (id: string) => void
  onUpdate: (id: string, title: string, content: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(title)
  const [editContent, setEditContent] = useState(content)

  if (editing) {
    return (
      <div className="space-y-1 p-2 rounded-md border border-zinc-700 bg-zinc-800/50">
        <input
          type="text"
          value={editTitle}
          onChange={e => setEditTitle(e.target.value)}
          className="w-full bg-transparent text-[11px] text-zinc-300 focus:outline-none border-b border-zinc-700 pb-1"
          autoFocus
        />
        <textarea
          value={editContent}
          onChange={e => setEditContent(e.target.value)}
          rows={2}
          className="w-full bg-transparent text-[10px] text-zinc-400 focus:outline-none resize-none"
        />
        <div className="flex items-center gap-1.5 justify-end">
          <button onClick={() => setEditing(false)} className="text-[10px] text-zinc-500 hover:text-zinc-300 px-2 py-0.5">
            Cancel
          </button>
          <button
            onClick={() => { onUpdate(id, editTitle, editContent); setEditing(false) }}
            className="text-[10px] text-yellow-300 bg-yellow-500/10 hover:bg-yellow-500/15 px-2 py-0.5 rounded"
          >
            Save
          </button>
        </div>
      </div>
    )
  }

  // Try to extract hex colors from content for swatch rendering
  const hexColors = content.match(/#[0-9a-fA-F]{3,8}/g) ?? []

  return (
    <div className="group text-[10px] bg-zinc-800/50 px-2 py-1.5 rounded hover:bg-zinc-800/70 transition-colors">
      <div className="flex items-center gap-1.5">
        {color && (
          <span className="w-3 h-3 rounded-sm flex-shrink-0 border border-zinc-700" style={{ backgroundColor: color }} />
        )}
        <span className="font-medium text-zinc-300 truncate flex-1">{title}</span>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={() => setEditing(true)} className="p-0.5 rounded hover:bg-zinc-700/50">
            <Edit3 className="w-2.5 h-2.5 text-zinc-500" />
          </button>
          <button onClick={() => onDelete(id)} className="p-0.5 rounded hover:bg-red-500/10">
            <Trash2 className="w-2.5 h-2.5 text-zinc-500 hover:text-red-400" />
          </button>
        </div>
      </div>
      {hexColors.length > 0 && (
        <div className="flex items-center gap-1 mt-1">
          {hexColors.map((hex, i) => (
            <span
              key={i}
              className="w-5 h-5 rounded-sm border border-zinc-700 cursor-default"
              style={{ backgroundColor: hex }}
              title={hex}
            />
          ))}
        </div>
      )}
      <p className="mt-0.5 text-zinc-500 line-clamp-2">{content}</p>
    </div>
  )
}

// ─── Brand Kit Section ──────────────────────────────────────────────────────

function BrandKitSection({ projectId }: { projectId: string | null }) {
  const utils = trpc.useUtils()
  const { data: memories } = trpc.memory.list.useQuery(
    { projectId: projectId!, category: "brand" },
    { enabled: !!projectId }
  )
  const createMem = trpc.memory.create.useMutation({
    onSuccess: () => utils.memory.list.invalidate(),
  })
  const updateMem = trpc.memory.update.useMutation({
    onSuccess: () => utils.memory.list.invalidate(),
  })
  const deleteMem = trpc.memory.delete.useMutation({
    onSuccess: () => utils.memory.list.invalidate(),
  })

  const [addingTo, setAddingTo] = useState<"colors" | "typography" | "voice" | null>(null)

  const brandMemories = memories ?? []
  const colorMems = brandMemories.filter(m => /color|palette/i.test(m.title))
  const fontMems = brandMemories.filter(m => /font|typo/i.test(m.title))
  const voiceMems = brandMemories.filter(m => /voice|tone|persona/i.test(m.title))
  const otherMems = brandMemories.filter(m => !/color|palette|font|typo|voice|tone|persona/i.test(m.title))

  const handleSave = useCallback((title: string, content: string) => {
    if (!projectId) return
    createMem.mutate({
      projectId,
      category: "brand",
      title,
      content,
      source: "manual",
      relevanceScore: 80,
    })
    setAddingTo(null)
  }, [projectId, createMem])

  const handleDelete = useCallback((id: string) => {
    deleteMem.mutate({ id })
  }, [deleteMem])

  const handleUpdate = useCallback((id: string, title: string, content: string) => {
    updateMem.mutate({ id, title, content })
  }, [updateMem])

  return (
    <div className="space-y-4">
      {/* Colors */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Palette className="w-3.5 h-3.5 text-pink-400" />
          <span className="text-[11px] font-medium text-zinc-400 flex-1">Colors</span>
          <button
            onClick={() => setAddingTo(addingTo === "colors" ? null : "colors")}
            className="p-0.5 rounded hover:bg-zinc-700/50 transition-colors"
          >
            <Plus className="w-3 h-3 text-zinc-500" />
          </button>
        </div>
        {addingTo === "colors" && (
          <div className="mb-2">
            <InlineAddForm
              onSave={handleSave}
              onCancel={() => setAddingTo(null)}
              titlePlaceholder="e.g. Primary Color"
              contentPlaceholder="e.g. #6366F1 (Indigo-500) — used for buttons, links, focus rings"
              saving={createMem.isPending}
            />
          </div>
        )}
        {colorMems.length > 0 ? (
          <div className="space-y-1">
            {colorMems.map(m => (
              <MemoryItem
                key={m.id}
                id={m.id}
                title={m.title}
                content={m.content}
                onDelete={handleDelete}
                onUpdate={handleUpdate}
              />
            ))}
          </div>
        ) : !addingTo && (
          <p className="text-[10px] text-zinc-600 italic">No brand colors defined yet</p>
        )}
      </div>

      {/* Typography */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Type className="w-3.5 h-3.5 text-pink-400" />
          <span className="text-[11px] font-medium text-zinc-400 flex-1">Typography</span>
          <button
            onClick={() => setAddingTo(addingTo === "typography" ? null : "typography")}
            className="p-0.5 rounded hover:bg-zinc-700/50 transition-colors"
          >
            <Plus className="w-3 h-3 text-zinc-500" />
          </button>
        </div>
        {addingTo === "typography" && (
          <div className="mb-2">
            <InlineAddForm
              onSave={handleSave}
              onCancel={() => setAddingTo(null)}
              titlePlaceholder="e.g. Body Font"
              contentPlaceholder="e.g. Inter 400/500/600 — clean, developer-friendly"
              saving={createMem.isPending}
            />
          </div>
        )}
        {fontMems.length > 0 ? (
          <div className="space-y-1">
            {fontMems.map(m => (
              <MemoryItem
                key={m.id}
                id={m.id}
                title={m.title}
                content={m.content}
                onDelete={handleDelete}
                onUpdate={handleUpdate}
              />
            ))}
          </div>
        ) : !addingTo && (
          <p className="text-[10px] text-zinc-600 italic">No typography defined yet</p>
        )}
      </div>

      {/* Voice / Tone */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <MessageSquareQuote className="w-3.5 h-3.5 text-pink-400" />
          <span className="text-[11px] font-medium text-zinc-400 flex-1">Voice & Tone</span>
          <button
            onClick={() => setAddingTo(addingTo === "voice" ? null : "voice")}
            className="p-0.5 rounded hover:bg-zinc-700/50 transition-colors"
          >
            <Plus className="w-3 h-3 text-zinc-500" />
          </button>
        </div>
        {addingTo === "voice" && (
          <div className="mb-2">
            <InlineAddForm
              onSave={handleSave}
              onCancel={() => setAddingTo(null)}
              titlePlaceholder="e.g. Brand Voice"
              contentPlaceholder="e.g. Professional, developer-focused, minimal. No fluff."
              saving={createMem.isPending}
            />
          </div>
        )}
        {voiceMems.length > 0 ? (
          <div className="space-y-1">
            {voiceMems.map(m => (
              <MemoryItem
                key={m.id}
                id={m.id}
                title={m.title}
                content={m.content}
                onDelete={handleDelete}
                onUpdate={handleUpdate}
              />
            ))}
          </div>
        ) : !addingTo && (
          <p className="text-[10px] text-zinc-600 italic">No voice & tone defined yet</p>
        )}
      </div>

      {/* Other brand memories */}
      {otherMems.length > 0 && (
        <div className="space-y-1 pt-2 border-t border-zinc-800/60">
          {otherMems.map(m => (
            <MemoryItem
              key={m.id}
              id={m.id}
              title={m.title}
              content={m.content}
              onDelete={handleDelete}
              onUpdate={handleUpdate}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Design Voice Section ───────────────────────────────────────────────────

function DesignVoiceSection({ projectId }: { projectId: string | null }) {
  const utils = trpc.useUtils()
  const { data: memories } = trpc.memory.list.useQuery(
    { projectId: projectId!, category: "design" },
    { enabled: !!projectId }
  )
  const createMem = trpc.memory.create.useMutation({
    onSuccess: () => utils.memory.list.invalidate(),
  })
  const updateMem = trpc.memory.update.useMutation({
    onSuccess: () => utils.memory.list.invalidate(),
  })

  const voiceMemory = memories?.find(m => /design voice|design direction|design philosophy/i.test(m.title))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")

  const startEditing = useCallback(() => {
    setDraft(voiceMemory?.content ?? "")
    setEditing(true)
  }, [voiceMemory])

  const save = useCallback(() => {
    if (!draft.trim() || !projectId) return
    if (voiceMemory) {
      updateMem.mutate({ id: voiceMemory.id, content: draft.trim() })
    } else {
      createMem.mutate({
        projectId,
        category: "design",
        title: "Design Voice",
        content: draft.trim(),
        source: "manual",
        relevanceScore: 80,
      })
    }
    setEditing(false)
  }, [draft, projectId, voiceMemory, updateMem, createMem])

  if (editing) {
    return (
      <div className="space-y-2">
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={4}
          placeholder="Describe your design philosophy. What should your UI feel like? What aesthetic are you going for? What should Claude prioritize when designing for this project?"
          className="w-full bg-zinc-800/50 rounded-md border border-zinc-700 px-3 py-2 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-yellow-500/40 resize-none"
          autoFocus
        />
        <div className="flex items-center gap-1.5 justify-end">
          <button onClick={() => setEditing(false)} className="text-[10px] text-zinc-500 hover:text-zinc-300 px-2 py-0.5">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!draft.trim() || createMem.isPending || updateMem.isPending}
            className="flex items-center gap-1 text-[10px] text-yellow-300 bg-yellow-500/10 hover:bg-yellow-500/15 px-2 py-1 rounded disabled:opacity-40"
          >
            <Check className="w-2.5 h-2.5" />
            Save
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      onClick={startEditing}
      className="cursor-pointer group hover:bg-zinc-800/30 rounded-md px-1 py-0.5 -mx-1 transition-colors"
    >
      {voiceMemory ? (
        <div className="flex items-start gap-2">
          <div className="text-xs text-zinc-400 leading-relaxed flex-1">
            {voiceMemory.content}
          </div>
          <Edit3 className="w-3 h-3 text-zinc-600 opacity-0 group-hover:opacity-100 flex-shrink-0 mt-0.5" />
        </div>
      ) : (
        <p className="text-[10px] text-zinc-600 italic">
          Click to describe your design philosophy. What should your UI feel like?
        </p>
      )}
    </div>
  )
}

// ─── References Section ────────────────────────────────────────────────────

function ReferencesSection({ projectId }: { projectId: string | null }) {
  const utils = trpc.useUtils()
  const { data: refs } = trpc.design.listReferences.useQuery(
    { projectId: projectId! },
    { enabled: !!projectId }
  )

  const pickAndAddMutation = trpc.design.pickAndAddReferences.useMutation({
    onSuccess: (data) => {
      utils.design.listReferences.invalidate()
      utils.memory.list.invalidate()
      if (data.length > 0) {
        toast.success(`Added ${data.length} reference${data.length > 1 ? "s" : ""}`)
      }
    },
    onError: () => toast.error("Failed to add references"),
  })

  const removeMutation = trpc.design.removeReference.useMutation({
    onSuccess: () => {
      utils.design.listReferences.invalidate()
      utils.memory.list.invalidate()
    },
  })

  const handleAdd = useCallback(() => {
    if (!projectId) return
    pickAndAddMutation.mutate({ projectId })
  }, [projectId, pickAndAddMutation])

  const references = refs ?? []

  return (
    <div>
      {references.length > 0 ? (
        <div className="grid grid-cols-3 gap-2">
          {references.map(ref => (
            <ReferenceThumb
              key={ref.id}
              imagePath={ref.imagePath}
              tags={ref.tags}
              onDelete={() => removeMutation.mutate({ referenceId: ref.id })}
            />
          ))}
          {/* Add more button */}
          <button
            onClick={handleAdd}
            disabled={pickAndAddMutation.isPending}
            className="aspect-[4/3] rounded-md border border-dashed border-zinc-700 flex flex-col items-center justify-center gap-1 hover:border-zinc-600 hover:bg-zinc-800/30 transition-colors"
          >
            {pickAndAddMutation.isPending ? (
              <Loader2 className="w-4 h-4 text-zinc-600 animate-spin" />
            ) : (
              <ImagePlus className="w-4 h-4 text-zinc-600" />
            )}
            <span className="text-[9px] text-zinc-600">Add</span>
          </button>
        </div>
      ) : (
        <button
          onClick={handleAdd}
          disabled={pickAndAddMutation.isPending}
          className="w-full py-6 rounded-md border border-dashed border-zinc-700 flex flex-col items-center justify-center gap-2 hover:border-zinc-600 hover:bg-zinc-800/30 transition-colors"
        >
          {pickAndAddMutation.isPending ? (
            <Loader2 className="w-5 h-5 text-zinc-500 animate-spin" />
          ) : (
            <>
              <ImagePlus className="w-5 h-5 text-zinc-500" />
              <span className="text-[10px] text-zinc-500">
                Drop screenshots of designs you admire
              </span>
              <span className="text-[9px] text-zinc-600">
                Claude will reference them when designing
              </span>
            </>
          )}
        </button>
      )}
    </div>
  )
}

function ReferenceThumb({
  imagePath,
  tags,
  onDelete,
}: {
  imagePath: string
  tags: string[]
  onDelete: () => void
}) {
  const { data: dataUrl } = trpc.design.readReferenceImage.useQuery(
    { imagePath },
    { enabled: !!imagePath, staleTime: Infinity }
  )

  return (
    <div className="group relative aspect-[4/3] rounded-md border border-zinc-800 overflow-hidden bg-zinc-950">
      {dataUrl ? (
        <img src={dataUrl} alt="Design reference" className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <Image className="w-4 h-4 text-zinc-700" />
        </div>
      )}
      {/* Delete overlay */}
      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
        <button
          onClick={onDelete}
          className="p-1.5 rounded-md bg-red-500/20 hover:bg-red-500/30 text-red-400"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {/* Tags */}
      {tags.length > 0 && tags[0] !== "general" && (
        <div className="absolute bottom-0 left-0 right-0 px-1 py-0.5 bg-gradient-to-t from-black/70">
          <span className="text-[8px] text-zinc-400 truncate">{tags.join(", ")}</span>
        </div>
      )}
    </div>
  )
}

// ─── Design Memories Section ────────────────────────────────────────────────

function DesignMemoriesSection({ projectId }: { projectId: string | null }) {
  const utils = trpc.useUtils()
  const { data: designMems } = trpc.memory.list.useQuery(
    { projectId: projectId!, category: "design" },
    { enabled: !!projectId }
  )
  const { data: strategyMems } = trpc.memory.list.useQuery(
    { projectId: projectId!, category: "strategy" },
    { enabled: !!projectId }
  )
  const deleteMem = trpc.memory.delete.useMutation({
    onSuccess: () => utils.memory.list.invalidate(),
  })
  const updateMem = trpc.memory.update.useMutation({
    onSuccess: () => utils.memory.list.invalidate(),
  })

  // Filter out the "Design Voice" memory — that's shown in its own section
  const allMems = [...(designMems ?? []), ...(strategyMems ?? [])]
    .filter(m => !/design voice|design direction|design philosophy/i.test(m.title))
    .filter(m => m.source !== "reference") // References shown in their own section

  if (allMems.length === 0) {
    return <p className="text-[10px] text-zinc-600 italic">No design or strategy memories yet. Chat about design to start building context.</p>
  }

  return (
    <div className="space-y-1.5">
      {allMems.map(m => (
        <MemoryItem
          key={m.id}
          id={m.id}
          title={m.title}
          content={m.content}
          onDelete={id => deleteMem.mutate({ id })}
          onUpdate={(id, title, content) => updateMem.mutate({ id, title, content })}
        />
      ))}
    </div>
  )
}

// ─── GAAD Design Insights ──────────────────────────────────────────────────

const CATEGORY_DOT: Record<string, string> = {
  design: "bg-yellow-400",
  "next-step": "bg-teal-400",
  bug: "bg-rose-400",
  security: "bg-amber-400",
  performance: "bg-blue-400",
}

function GAADDesignInsightsSection() {
  const { suggestions } = useAmbientStore()
  const setAssessmentId = useSetAtom(assessmentPanelSuggestionIdAtom)

  // Filter to design-related suggestions
  const designSuggestions = useMemo(
    () => suggestions.filter(s =>
      s.category === "design" ||
      (s.category === "next-step" && /\.pen|pencil|design|brand/i.test(s.title + " " + s.description))
    ),
    [suggestions],
  )

  if (designSuggestions.length === 0) {
    return (
      <p className="text-[10px] text-zinc-600 italic">
        No design insights yet. GAAD will surface brand drift, consistency issues, and design suggestions as you work.
      </p>
    )
  }

  return (
    <div className="space-y-1.5">
      {designSuggestions.map(s => (
        <button
          key={s.id}
          onClick={() => setAssessmentId(s.id)}
          className="w-full text-left p-2 rounded-md bg-zinc-800/50 hover:bg-zinc-800/70 transition-colors"
        >
          <div className="flex items-center gap-1.5">
            <span className={cn("h-1.5 w-1.5 rounded-full flex-shrink-0", CATEGORY_DOT[s.category] ?? "bg-slate-400")} />
            <span className="text-[10px] font-medium text-zinc-300 truncate">{s.title}</span>
          </div>
          <p className="text-[9px] text-zinc-500 line-clamp-2 mt-0.5 ml-3">{s.description}</p>
          <div className="flex items-center gap-2 mt-1 ml-3">
            <span className="text-[8px] text-zinc-600 font-mono">{s.confidence}% conf</span>
            <span className="text-[8px] text-zinc-600">{s.severity}</span>
          </div>
        </button>
      ))}
    </div>
  )
}

// ─── Templates ─────────────────────────────────────────────────────────────

const TEMPLATES = [
  {
    id: "saas",
    name: "SaaS App",
    description: "Clean, professional, data-focused",
    colors: "Primary: #6366F1 (Indigo), Secondary: #EC4899 (Pink), Neutral: #18181B (Zinc-900)",
    typography: "Body: Inter 400/500/600, Mono: JetBrains Mono 400",
    voice: "Professional, developer-focused, minimal. Prefer clarity over personality. Dark-first design.",
  },
  {
    id: "marketing",
    name: "Marketing Site",
    description: "Bold, expressive, conversion-optimized",
    colors: "Primary: #2563EB (Blue-600), Accent: #F59E0B (Amber-500), Neutral: #111827 (Gray-900)",
    typography: "Headings: Cal Sans 700, Body: Inter 400/500",
    voice: "Confident, warm, action-oriented. Hero sections with strong CTAs. Light mode preferred.",
  },
  {
    id: "dashboard",
    name: "Dashboard",
    description: "Dense, information-rich, dark-first",
    colors: "Primary: #14B8A6 (Teal-500), Accent: #F97316 (Orange-500), Surface: #09090B (Zinc-950)",
    typography: "Body: Inter 400/500, Mono: Fira Code 400, Numbers: Tabular",
    voice: "Data-dense, compact, functional. Prefer tables and charts over decorative elements. Dark mode only.",
  },
  {
    id: "mobile",
    name: "Mobile App",
    description: "Touch-friendly, rounded, lively",
    colors: "Primary: #8B5CF6 (Violet-500), Secondary: #06B6D4 (Cyan-500), Background: #FAFAFA",
    typography: "Body: SF Pro / Inter 400/600, Large touch targets (min 44px)",
    voice: "Friendly, approachable, playful. Rounded corners (12-16px). Bottom navigation. Light mode default.",
  },
  {
    id: "ecommerce",
    name: "E-commerce",
    description: "Product-focused, trust-building, clean",
    colors: "Primary: #059669 (Emerald-600), Accent: #DC2626 (Sale Red), Neutral: #FFFFFF / #1F2937",
    typography: "Headings: DM Sans 700, Body: Inter 400/500, Prices: Tabular Mono",
    voice: "Clean, trustworthy, product-focused. Large product images. Clear pricing. White space is premium.",
  },
  {
    id: "minimal",
    name: "Minimal / Blank",
    description: "Start from scratch",
    colors: "Primary: #3B82F6 (Blue-500), Neutral: #09090B (Zinc-950)",
    typography: "Body: Inter 400/500/600",
    voice: "Minimal, clean, modern. Let the content speak.",
  },
]

// ─── Template Picker ───────────────────────────────────────────────────────

function TemplatePicker({
  projectId,
  onBack,
  onDone,
}: {
  projectId: string
  onBack: () => void
  onDone: () => void
}) {
  const utils = trpc.useUtils()
  const createMemory = trpc.memory.create.useMutation({
    onSuccess: () => utils.memory.list.invalidate(),
  })
  const [applying, setApplying] = useState<string | null>(null)

  const applyTemplate = useCallback(async (template: typeof TEMPLATES[number]) => {
    setApplying(template.id)
    try {
      await Promise.all([
        createMemory.mutateAsync({
          projectId,
          category: "brand",
          title: "Color Palette",
          content: template.colors,
          source: "manual",
        }),
        createMemory.mutateAsync({
          projectId,
          category: "brand",
          title: "Typography",
          content: template.typography,
          source: "manual",
        }),
        createMemory.mutateAsync({
          projectId,
          category: "brand",
          title: "Voice & Tone",
          content: template.voice,
          source: "manual",
        }),
      ])
      toast.success(`Applied "${template.name}" template`)
      onDone()
    } catch {
      toast.error("Failed to apply template")
    } finally {
      setApplying(null)
    }
  }, [projectId, createMemory, onDone])

  return (
    <div className="space-y-3">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        <ArrowLeft className="w-3 h-3" />
        Back
      </button>
      <h3 className="text-xs font-medium text-zinc-300">Choose a starting point</h3>
      <div className="grid grid-cols-2 gap-2">
        {TEMPLATES.map(t => (
          <button
            key={t.id}
            onClick={() => applyTemplate(t)}
            disabled={applying !== null}
            className={cn(
              "text-left p-3 rounded-lg border transition-all",
              applying === t.id
                ? "border-yellow-500/40 bg-yellow-500/5"
                : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 hover:bg-zinc-800/30",
              applying !== null && applying !== t.id && "opacity-50",
            )}
          >
            <div className="text-[11px] font-medium text-zinc-300 mb-0.5">{t.name}</div>
            <div className="text-[10px] text-zinc-600 leading-relaxed">{t.description}</div>
            {applying === t.id && (
              <Loader2 className="w-3 h-3 text-yellow-400 animate-spin mt-1.5" />
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Describe Your Brand ───────────────────────────────────────────────────

function DescribeBrandFlow({
  projectId,
  onBack,
  onDone,
}: {
  projectId: string
  onBack: () => void
  onDone: () => void
}) {
  const [description, setDescription] = useState("")
  const [saving, setSaving] = useState(false)
  const utils = trpc.useUtils()
  const createMemory = trpc.memory.create.useMutation({
    onSuccess: () => utils.memory.list.invalidate(),
  })

  const handleSubmit = useCallback(async () => {
    const text = description.trim()
    if (!text) return
    setSaving(true)

    try {
      const colorMatch = text.match(/(?:colors?|palette|primary|secondary|accent)[\s:]*([^.!?\n]+)/i)
      const fontMatch = text.match(/(?:fonts?|typeface|typography)[\s:]*([^.!?\n]+)/i)

      const memories: Array<{ title: string; content: string; category: "brand" | "design" }> = []

      if (colorMatch) {
        memories.push({ title: "Color Palette", content: colorMatch[1].trim(), category: "brand" })
      }
      if (fontMatch) {
        memories.push({ title: "Typography", content: fontMatch[1].trim(), category: "brand" })
      }

      memories.push({ title: "Design Voice", content: text, category: "design" })

      if (!colorMatch && !fontMatch) {
        memories.push({ title: "Brand Description", content: text, category: "brand" })
      }

      await Promise.all(
        memories.map(m =>
          createMemory.mutateAsync({
            projectId,
            category: m.category,
            title: m.title,
            content: m.content,
            source: "manual",
          })
        )
      )

      toast.success(`Saved ${memories.length} design memories`)
      onDone()
    } catch {
      toast.error("Failed to save brand description")
    } finally {
      setSaving(false)
    }
  }, [description, projectId, createMemory, onDone])

  return (
    <div className="space-y-3">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        <ArrowLeft className="w-3 h-3" />
        Back
      </button>
      <h3 className="text-xs font-medium text-zinc-300">Describe your brand</h3>
      <p className="text-[10px] text-zinc-500 leading-relaxed">
        Tell us about your product's look and feel. Mention colors, fonts, mood, target audience — anything that defines the aesthetic.
      </p>
      <div className="relative rounded-lg border border-zinc-700 bg-zinc-900/80 focus-within:border-yellow-500/40 focus-within:ring-1 focus-within:ring-yellow-500/20 transition-colors">
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              handleSubmit()
            }
          }}
          placeholder="e.g. We're building a developer tool. Dark mode first, minimal UI inspired by Linear. Primary color is indigo (#6366F1). Body font is Inter. The vibe should feel precise, fast, professional — no fluff."
          rows={5}
          disabled={saving}
          className="block w-full resize-none bg-transparent px-3 py-2.5 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none disabled:opacity-50 leading-relaxed"
          autoFocus
        />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-zinc-600">
          {description.length > 0 ? `${description.length} chars` : "Cmd+Enter to save"}
        </span>
        <button
          onClick={handleSubmit}
          disabled={!description.trim() || saving}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-md bg-yellow-500/10 border border-yellow-500/30 text-yellow-300 hover:bg-yellow-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
          Save
        </button>
      </div>
    </div>
  )
}

// ─── Empty State ────────────────────────────────────────────────────────────

type SetupView = "empty" | "describe" | "template"

function EmptyState({
  onDismiss,
  projectId,
  onDone,
}: {
  onDismiss: () => void
  projectId: string
  onDone: () => void
}) {
  const [view, setView] = useState<SetupView>("empty")
  const utils = trpc.useUtils()

  const autoFill = trpc.design.autoFillDesign.useMutation({
    onSuccess: (data) => {
      if (data.created.length === 0) {
        toast.info("No design info found in project")
      } else {
        toast.success(`Auto-filled ${data.created.length} design memories`)
      }
      utils.memory.list.invalidate()
      utils.design.getDesignConfidence.invalidate()
      onDone()
    },
    onError: (err) => {
      toast.error(`Auto-fill failed: ${err.message}`)
    },
  })

  if (view === "describe") {
    return (
      <div className="px-4">
        <DescribeBrandFlow projectId={projectId} onBack={() => setView("empty")} onDone={onDone} />
      </div>
    )
  }

  if (view === "template") {
    return (
      <div className="px-4">
        <TemplatePicker projectId={projectId} onBack={() => setView("empty")} onDone={onDone} />
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center py-16 px-8">
      <div className="flex items-center justify-center w-16 h-16 rounded-xl border border-yellow-500/15 bg-yellow-500/5 mb-4">
        <Pencil className="w-10 h-10 text-yellow-400/40" />
      </div>
      <h3 className="text-sm font-medium text-zinc-300 mb-1.5">Design brain is empty</h3>
      <p className="text-xs text-zinc-500 max-w-[280px] text-center leading-relaxed mb-6">
        Add brand colors, typography, and design direction so Claude knows your aesthetic before it builds anything.
      </p>
      <div className="flex flex-col gap-2 w-full max-w-[220px]">
        <button
          onClick={() => autoFill.mutate({ projectId })}
          disabled={autoFill.isPending}
          className="flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-violet-500/15 border border-violet-500/30 text-violet-300 hover:bg-violet-500/20 transition-colors disabled:opacity-50"
        >
          {autoFill.isPending ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Wand2 className="w-3 h-3" />
          )}
          {autoFill.isPending ? "Analyzing project…" : "Auto-fill from project"}
        </button>
        <button
          onClick={() => setView("describe")}
          className="px-4 py-2 text-xs font-medium rounded-md bg-yellow-500/10 border border-yellow-500/30 text-yellow-300 hover:bg-yellow-500/15 transition-colors"
        >
          Describe your brand
        </button>
        <button
          onClick={() => setView("template")}
          className="px-4 py-2 text-xs font-medium rounded-md border border-zinc-700 text-zinc-400 hover:bg-zinc-800/50 transition-colors"
        >
          Use a template
        </button>
        <button
          onClick={onDismiss}
          className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors mt-1"
        >
          I'll set it up later
        </button>
      </div>
    </div>
  )
}

// ─── Confidence Pill ───────────────────────────────────────────────────────

function ConfidencePill({ projectId }: { projectId: string }) {
  const { data } = trpc.design.getDesignConfidence.useQuery(
    { projectId },
    { staleTime: 30_000 }
  )

  if (!data) return null

  const colorMap: Record<string, string> = {
    low: "text-amber-400 bg-amber-500/10",
    fair: "text-amber-400/70 bg-amber-500/5",
    ready: "text-teal-400 bg-teal-500/10",
  }

  return (
    <span
      className={cn("text-[9px] font-semibold px-1.5 py-0.5 rounded cursor-default", colorMap[data.level])}
      title={data.missing.length > 0 ? `Missing:\n${data.missing.join("\n")}` : "Design context is complete"}
    >
      {data.score}%
    </span>
  )
}

// ─── Main View ──────────────────────────────────────────────────────────────

function PencilDesignView({ chatId, subChatId }: PencilDesignViewProps) {
  const selectedProject = useAtomValue(selectedProjectAtom)
  const projectId = selectedProject?.id ?? null
  const utils = trpc.useUtils()

  const { data: brandMems } = trpc.memory.list.useQuery(
    { projectId: projectId!, category: "brand" },
    { enabled: !!projectId }
  )
  const { data: designMems } = trpc.memory.list.useQuery(
    { projectId: projectId!, category: "design" },
    { enabled: !!projectId }
  )
  const { data: strategyMems } = trpc.memory.list.useQuery(
    { projectId: projectId!, category: "strategy" },
    { enabled: !!projectId }
  )

  const autoFill = trpc.design.autoFillDesign.useMutation({
    onSuccess: (data) => {
      if (data.created.length === 0) {
        toast.info("No new design info found")
      } else {
        toast.success(`Added ${data.created.length} design memories`)
      }
      utils.memory.list.invalidate()
      utils.design.getDesignConfidence.invalidate()
    },
    onError: (err) => {
      toast.error(`Auto-fill failed: ${err.message}`)
    },
  })

  const totalDesignMemories = (brandMems?.length ?? 0) + (designMems?.length ?? 0) + (strategyMems?.length ?? 0)
  const [setupDismissed, setSetupDismissed] = useState(false)
  const showEmptyState = totalDesignMemories === 0 && !setupDismissed

  return (
    <div className="relative h-full overflow-y-auto overflow-x-hidden">
      <div className="relative z-10 p-4 space-y-3">
        {/* Header */}
        <div className="flex items-center gap-2 mb-2">
          <Pencil className="w-4 h-4 text-yellow-400" />
          <h2 className="text-sm font-medium text-zinc-200">Design</h2>
          {totalDesignMemories > 0 && (
            <span className="text-[10px] text-zinc-500 font-mono">{totalDesignMemories} memories</span>
          )}
          {projectId && totalDesignMemories > 0 && <ConfidencePill projectId={projectId} />}
          <div className="flex-1" />
          {projectId && totalDesignMemories > 0 && (
            <button
              onClick={() => autoFill.mutate({ projectId })}
              disabled={autoFill.isPending}
              className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-md text-violet-400 hover:bg-violet-500/10 transition-colors disabled:opacity-50"
              title="Scan project and auto-fill missing design info"
            >
              {autoFill.isPending ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Wand2 className="w-3 h-3" />
              )}
              {autoFill.isPending ? "Analyzing…" : "Auto-fill"}
            </button>
          )}
        </div>

        {showEmptyState ? (
          <EmptyState
            onDismiss={() => setSetupDismissed(true)}
            projectId={projectId!}
            onDone={() => setSetupDismissed(false)}
          />
        ) : (
          <>
            {/* Brand Kit */}
            <Section
              title="Brand Kit"
              icon={<Palette className="w-3.5 h-3.5" />}
              iconColor="text-pink-400"
              count={brandMems?.length ?? 0}
              defaultOpen={true}
            >
              <BrandKitSection projectId={projectId} />
            </Section>

            {/* Design Voice */}
            <Section
              title="Design Voice"
              icon={<MessageSquareQuote className="w-3.5 h-3.5" />}
              iconColor="text-yellow-400"
              defaultOpen={true}
            >
              <DesignVoiceSection projectId={projectId} />
            </Section>

            {/* Visual References */}
            <Section
              title="References"
              icon={<Image className="w-3.5 h-3.5" />}
              iconColor="text-zinc-400"
              defaultOpen={false}
            >
              <ReferencesSection projectId={projectId} />
            </Section>

            {/* Design Memories */}
            <Section
              title="Design Memories"
              icon={<Brain className="w-3.5 h-3.5" />}
              iconColor="text-yellow-400"
              count={(designMems?.length ?? 0) + (strategyMems?.length ?? 0)}
            >
              <DesignMemoriesSection projectId={projectId} />
            </Section>

            {/* GAAD Design Insights */}
            <Section
              title="GAAD Design Insights"
              icon={<Sparkles className="w-3.5 h-3.5" />}
              iconColor="text-teal-400"
            >
              <GAADDesignInsightsSection />
            </Section>
          </>
        )}
      </div>
    </div>
  )
}

export default memo(PencilDesignView)
