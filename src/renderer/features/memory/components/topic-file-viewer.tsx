import { ArrowLeft, Trash2 } from "lucide-react"
import { Button } from "../../../components/ui/button"
import { Badge } from "../../../components/ui/badge"
import { trpc } from "../../../lib/trpc"
import { cn } from "../../../lib/utils"

const CONFIDENCE_COLORS: Record<string, string> = {
  high: "text-green-500",
  medium: "text-yellow-500",
  low: "text-muted-foreground",
}

interface TopicFileViewerProps {
  projectPath: string
  filename: string
  onBack: () => void
}

export function TopicFileViewer({ projectPath, filename, onBack }: TopicFileViewerProps) {
  const utils = trpc.useUtils()
  const { data: entries } = trpc.memory.getTopicEntries.useQuery(
    { projectPath, filename },
    { staleTime: 10_000 },
  )

  const deleteMutation = trpc.memory.deleteEntry.useMutation({
    onSuccess: () => {
      utils.memory.getTopicEntries.invalidate()
      utils.memory.getVault.invalidate()
      utils.memory.getAllEntries.invalidate()
    },
  })

  return (
    <div className="space-y-2">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to index
      </button>

      <h3 className="text-xs font-medium text-foreground">{filename}</h3>

      {!entries || entries.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4 text-center">No entries</p>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div
              key={entry.meta.id}
              className="p-2 rounded-md border bg-background/50 space-y-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
                    {entry.meta.category}
                  </Badge>
                  <span
                    className={cn("text-[9px]", CONFIDENCE_COLORS[entry.meta.confidence])}
                  >
                    {entry.meta.confidence}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-4 w-4 p-0 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => deleteMutation.mutate({ projectPath, entryId: entry.meta.id })}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 className="h-2.5 w-2.5" />
                </Button>
              </div>

              <p className="text-[11px] text-foreground/90 whitespace-pre-wrap leading-relaxed">
                {entry.body.slice(0, 500)}
                {entry.body.length > 500 && "..."}
              </p>

              {entry.meta.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {entry.meta.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-[9px] px-1 py-0 rounded bg-foreground/5 text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
