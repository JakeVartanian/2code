import { Brain } from "lucide-react"
import { useAtom } from "jotai"
import { trpc } from "../../../lib/trpc"
import { memoryPanelOpenAtom } from "../atoms"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../../components/ui/tooltip"

interface MemoryIndicatorProps {
  projectPath?: string
}

export function MemoryIndicator({ projectPath }: MemoryIndicatorProps) {
  const [, setOpen] = useAtom(memoryPanelOpenAtom)

  const { data: vault } = trpc.memory.getVault.useQuery(
    { projectPath: projectPath! },
    { enabled: !!projectPath, staleTime: 30_000 },
  )

  if (!projectPath || !vault) return null

  const totalEntries = vault.topics.reduce((sum, t) => sum + t.entryCount, 0)
  if (totalEntries === 0) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
        >
          <Brain className="h-3 w-3" />
          <span>{totalEntries}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        Project memory — {totalEntries} {totalEntries === 1 ? "entry" : "entries"}
      </TooltipContent>
    </Tooltip>
  )
}
