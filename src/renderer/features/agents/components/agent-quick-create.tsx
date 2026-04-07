import { useState, useCallback } from "react"
import { Plus } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover"
import { Button } from "../../../components/ui/button"
import { Textarea } from "../../../components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select"
import { trpc } from "../../../lib/trpc"
import { cn } from "../../../lib/utils"
import { toast } from "sonner"
import { IconSpinner } from "../../../components/ui/icons"
import { useAtomValue } from "jotai"
import { selectedProjectAtom } from "../atoms"

interface AgentQuickCreateProps {
  className?: string
}

export function AgentQuickCreate({ className }: AgentQuickCreateProps) {
  const [open, setOpen] = useState(false)
  const [description, setDescription] = useState("")
  const [source, setSource] = useState<"user" | "project">("user")
  const [isGenerating, setIsGenerating] = useState(false)
  const selectedProject = useAtomValue(selectedProjectAtom)

  const generateMutation = trpc.agents.generateFromDescription.useMutation()
  const createMutation = trpc.agents.create.useMutation()
  const trpcUtils = trpc.useUtils()

  const handleSubmit = useCallback(async () => {
    if (!description.trim() || description.trim().length < 10) {
      toast.error("Description too short", {
        description: "Please provide at least 10 characters",
      })
      return
    }

    setIsGenerating(true)
    try {
      // Step 1: Generate agent definition from description
      const generated = await generateMutation.mutateAsync({
        description: description.trim(),
      })

      // Step 2: Create agent file
      const result = await createMutation.mutateAsync({
        name: generated.name,
        description: generated.description,
        prompt: generated.prompt,
        model: generated.model,
        source,
        cwd: selectedProject?.path,
      })

      // Step 3: Invalidate agents query cache
      await trpcUtils.agents.list.invalidate()
      await trpcUtils.agents.listEnabled.invalidate()

      toast.success("Agent created", {
        description: `"${result.name}" is ready in @ mentions`,
      })

      setOpen(false)
      setDescription("")
      setSource("user")
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create agent"
      toast.error("Failed to create agent", { description: message })
    } finally {
      setIsGenerating(false)
    }
  }, [
    description,
    source,
    generateMutation,
    createMutation,
    trpcUtils,
    selectedProject,
  ])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex items-center justify-center h-7 w-7 rounded-md",
            "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            "transition-[background-color,color] duration-150 ease-out",
            "outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70",
            className,
          )}
          title="Create agent with AI"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-3"
        align="end"
        sideOffset={6}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium text-foreground">
              Create Agent with AI
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Describe what you want the agent to do
            </p>
          </div>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. A senior code reviewer that focuses on security vulnerabilities and performance..."
            rows={4}
            className="resize-none text-sm"
            disabled={isGenerating}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                handleSubmit()
              }
            }}
          />
          {selectedProject?.path && (
            <Select
              value={source}
              onValueChange={(v) => setSource(v as "user" | "project")}
              disabled={isGenerating}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">
                  User (all projects)
                </SelectItem>
                <SelectItem value="project">
                  Project only
                </SelectItem>
              </SelectContent>
            </Select>
          )}
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-muted-foreground">
              {navigator.platform.includes("Mac") ? "Cmd" : "Ctrl"}+Enter to
              create
            </p>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={isGenerating || description.trim().length < 10}
            >
              {isGenerating ? (
                <>
                  <IconSpinner className="h-3.5 w-3.5 mr-1.5" />
                  Generating...
                </>
              ) : (
                "Create"
              )}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
