import { useState } from "react"
import { Puzzle, Database, ChevronDown, ChevronRight } from "lucide-react"
import { Badge } from "../../../components/ui/badge"
import { trpc } from "../../../lib/trpc"

interface SkillsPanelProps {
  cwd?: string
}

export function SkillsPanel({ cwd }: SkillsPanelProps) {
  const { data: agents, isLoading } = trpc.agents.list.useQuery(
    { cwd },
    { staleTime: 30_000 },
  )

  // Filter to agents that have memory declarations
  const skillAgents = agents?.filter(
    (a) =>
      (a.memoryReads && a.memoryReads.length > 0) ||
      (a.memoryWrites && a.memoryWrites.length > 0),
  )

  if (isLoading) {
    return (
      <div className="text-xs text-muted-foreground text-center py-6">
        Loading skills...
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Puzzle className="h-3.5 w-3.5 text-foreground" />
        <span className="text-xs font-medium">Skills with Memory</span>
        {skillAgents && skillAgents.length > 0 && (
          <Badge variant="outline" className="text-[9px] px-1.5 py-0">
            {skillAgents.length}
          </Badge>
        )}
      </div>

      {!skillAgents || skillAgents.length === 0 ? (
        <div className="text-[11px] text-muted-foreground py-4 text-center">
          No skills with memory declarations found.
          <br />
          <span className="text-[10px]">
            Add <code className="bg-muted px-1 rounded">memory_reads</code> or{" "}
            <code className="bg-muted px-1 rounded">memory_writes</code> to
            agent YAML frontmatter.
          </span>
        </div>
      ) : (
        <div className="space-y-1">
          {skillAgents.map((agent) => (
            <SkillCard key={`${agent.source}:${agent.name}`} agent={agent} />
          ))}
        </div>
      )}

      {/* All agents section */}
      {agents && agents.length > 0 && (
        <div className="pt-2 border-t">
          <div className="text-[10px] text-muted-foreground mb-2">
            All Agents ({agents.length})
          </div>
          <div className="space-y-0.5">
            {agents.map((agent) => (
              <div
                key={`${agent.source}:${agent.name}`}
                className="flex items-center gap-2 px-2 py-1 rounded text-[11px]"
              >
                <span className="truncate flex-1">{agent.name}</span>
                <SourceBadge source={agent.source} />
                {((agent.memoryReads && agent.memoryReads.length > 0) ||
                  (agent.memoryWrites && agent.memoryWrites.length > 0)) && (
                  <Database className="h-2.5 w-2.5 text-blue-400" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function SkillCard({
  agent,
}: {
  agent: {
    name: string
    description: string
    source: string
    model?: string
    tools?: string[]
    memoryReads?: string[]
    memoryWrites?: string[]
  }
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border rounded-md overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <span className="text-xs font-medium truncate flex-1">
          {agent.name}
        </span>
        <SourceBadge source={agent.source} />
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t bg-muted/30 space-y-2">
          {agent.description && (
            <p className="text-[11px] text-muted-foreground">
              {agent.description}
            </p>
          )}

          {agent.model && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">Model:</span>
              <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                {agent.model}
              </Badge>
            </div>
          )}

          {agent.tools && agent.tools.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] text-muted-foreground">Tools:</span>
              <div className="flex flex-wrap gap-1">
                {agent.tools.map((tool) => (
                  <Badge
                    key={tool}
                    variant="outline"
                    className="text-[9px] px-1 py-0"
                  >
                    {tool}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {agent.memoryReads && agent.memoryReads.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] text-blue-400">Memory Reads:</span>
              <div className="flex flex-wrap gap-1">
                {agent.memoryReads.map((file) => (
                  <Badge
                    key={file}
                    className="text-[9px] px-1 py-0 bg-blue-500/10 text-blue-400"
                  >
                    {file}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {agent.memoryWrites && agent.memoryWrites.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] text-green-400">
                Memory Writes:
              </span>
              <div className="flex flex-wrap gap-1">
                {agent.memoryWrites.map((file) => (
                  <Badge
                    key={file}
                    className="text-[9px] px-1 py-0 bg-green-500/10 text-green-400"
                  >
                    {file}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SourceBadge({ source }: { source: string }) {
  const colors: Record<string, string> = {
    user: "bg-blue-500/10 text-blue-500",
    project: "bg-green-500/10 text-green-500",
    plugin: "bg-purple-500/10 text-purple-500",
    bundled: "bg-muted text-muted-foreground",
  }

  return (
    <Badge
      className={`text-[9px] px-1 py-0 ${colors[source] || colors.bundled}`}
    >
      {source}
    </Badge>
  )
}
