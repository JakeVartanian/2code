import { cn } from "../../../../lib/utils"

type FileStatus = "M" | "A" | "D" | "R" | "?"

const STATUS_COLORS: Record<FileStatus, string> = {
  M: "text-amber-400",
  A: "text-green-400",
  D: "text-red-400",
  R: "text-blue-400",
  "?": "text-muted-foreground/60",
}

const STATUS_LABELS: Record<FileStatus, string> = {
  M: "M",
  A: "A",
  D: "D",
  R: "R",
  "?": "?",
}

interface GitChangedFilesProps {
  files: Array<{ path: string; status: FileStatus }>
}

export function GitChangedFiles({ files }: GitChangedFilesProps) {
  if (files.length === 0) return null

  return (
    <div className="mx-3 mb-2">
      <div className="rounded-md border border-border/40 bg-muted/20 overflow-hidden">
        <div className="max-h-32 overflow-y-auto">
          {files.map((f) => {
            const fileName = f.path.split("/").pop() || f.path
            const dirPath = f.path.includes("/") ? f.path.substring(0, f.path.lastIndexOf("/")) : ""
            return (
              <div
                key={f.path}
                className="flex items-center gap-2 px-2.5 py-1 border-b border-border/20 last:border-b-0 hover:bg-muted/30 transition-colors"
              >
                <span
                  className={cn("text-[10px] font-mono font-bold w-3 flex-shrink-0", STATUS_COLORS[f.status])}
                >
                  {STATUS_LABELS[f.status]}
                </span>
                <span className="text-xs font-mono text-muted-foreground/50 truncate min-w-0">
                  {dirPath && <span>{dirPath}/</span>}
                  <span className="text-foreground/80 font-medium">{fileName}</span>
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
