import { useState } from "react"
import { Button } from "../../../components/ui/button"
import { trpc } from "../../../lib/trpc"
import type { MemoryCategory, MemoryConfidence } from "../../../../main/lib/memory/types"

const CATEGORIES: { value: MemoryCategory; label: string }[] = [
  { value: "architecture-decision", label: "Architecture Decision" },
  { value: "rejected-approach", label: "Rejected Approach" },
  { value: "convention", label: "Convention" },
  { value: "debugging-pattern", label: "Debugging Pattern" },
  { value: "operational-knowledge", label: "Operational Knowledge" },
  { value: "project-identity", label: "Project Identity" },
  { value: "current-context", label: "Current Context" },
]

const CONFIDENCES: { value: MemoryConfidence; label: string }[] = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
]

interface MemoryEntryEditorProps {
  projectPath: string
  onClose: () => void
  onSaved: () => void
}

export function MemoryEntryEditor({ projectPath, onClose, onSaved }: MemoryEntryEditorProps) {
  const [category, setCategory] = useState<MemoryCategory>("convention")
  const [confidence, setConfidence] = useState<MemoryConfidence>("medium")
  const [body, setBody] = useState("")
  const [tags, setTags] = useState("")

  const utils = trpc.useUtils()
  const upsertMutation = trpc.memory.upsertEntry.useMutation({
    onSuccess: () => {
      utils.memory.getVault.invalidate()
      utils.memory.getAllEntries.invalidate()
      onSaved()
      onClose()
    },
  })

  const handleSubmit = () => {
    if (!body.trim()) return
    upsertMutation.mutate({
      projectPath,
      category,
      confidence,
      body: body.trim(),
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      source: "user",
    })
  }

  return (
    <div className="space-y-3 p-3 border rounded-lg bg-background">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">Add Memory</span>
        <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px]" onClick={onClose}>
          Cancel
        </Button>
      </div>

      <div className="flex gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as MemoryCategory)}
          className="flex-1 h-7 rounded-md border bg-transparent px-2 text-xs"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>

        <select
          value={confidence}
          onChange={(e) => setConfidence(e.target.value as MemoryConfidence)}
          className="w-20 h-7 rounded-md border bg-transparent px-2 text-xs"
        >
          {CONFIDENCES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="What should the AI remember about this project?"
        className="w-full h-24 rounded-md border bg-transparent px-2 py-1.5 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring"
      />

      <input
        type="text"
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        placeholder="Tags (comma-separated)"
        className="w-full h-7 rounded-md border bg-transparent px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
      />

      <Button
        size="sm"
        className="w-full h-7 text-xs"
        onClick={handleSubmit}
        disabled={!body.trim() || upsertMutation.isPending}
      >
        {upsertMutation.isPending ? "Saving..." : "Save Memory"}
      </Button>
    </div>
  )
}
