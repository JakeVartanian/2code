import { GitCommit } from "lucide-react"

interface GitLocalCommitsProps {
  commits: Array<{ sha: string; shortSha: string; message: string }>
  targetRemote: string
}

export function GitLocalCommits({ commits, targetRemote }: GitLocalCommitsProps) {
  if (commits.length === 0) return null

  return (
    <div className="mx-3 mb-2">
      <p className="text-[10px] text-muted-foreground/50 mb-1.5 flex items-center gap-1">
        <GitCommit className="h-3 w-3" />
        {commits.length} commit{commits.length !== 1 ? "s" : ""} not yet on{" "}
        <span className="font-mono">{targetRemote}</span>
      </p>
      <div className="rounded-md border border-border/40 bg-muted/20 overflow-hidden">
        <div className="max-h-32 overflow-y-auto">
          {commits.map((c) => (
            <div
              key={c.sha}
              className="flex items-start gap-2 px-2.5 py-1.5 border-b border-border/20 last:border-b-0"
            >
              <span className="font-mono text-[10px] text-muted-foreground/40 flex-shrink-0 mt-px">
                {c.shortSha}
              </span>
              <span className="text-xs text-foreground/70 truncate">{c.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
