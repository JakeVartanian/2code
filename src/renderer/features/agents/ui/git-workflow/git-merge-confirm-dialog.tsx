import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../../../components/ui/dialog"
import { Button } from "../../../../components/ui/button"
import { Input } from "../../../../components/ui/input"
import { trpc } from "../../../../lib/trpc"
import { toast } from "sonner"
import { useQueryClient } from "@tanstack/react-query"

interface GitMergeConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  chatId: string
  branch: string
  baseBranch: string
}

export function GitMergeConfirmDialog({
  open,
  onOpenChange,
  chatId,
  branch,
  baseBranch,
}: GitMergeConfirmDialogProps) {
  const [typed, setTyped] = useState("")
  const queryClient = useQueryClient()
  const isConfirmed = typed.trim() === branch

  const mergeMutation = trpc.chats.mergePr.useMutation({
    onSuccess: () => {
      toast.success("PR merged successfully!", { position: "top-center" })
      queryClient.invalidateQueries({ queryKey: [["chats", "getPrStatus"]] })
      queryClient.invalidateQueries({ queryKey: [["changes", "getWorkflowState"]] })
      onOpenChange(false)
    },
    onError: (err) => {
      toast.error(err.message || "Merge failed", { position: "top-center" })
    },
  })

  const handleMerge = () => {
    if (!isConfirmed) return
    mergeMutation.mutate({ chatId, method: "squash" })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">Confirm merge</DialogTitle>
          <DialogDescription className="text-xs">
            This will merge <span className="font-mono text-foreground/80">{branch}</span> into{" "}
            <span className="font-mono text-foreground/80">{baseBranch}</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2 space-y-4">
          {/* Visual branch arrow */}
          <div className="flex items-center gap-2 rounded-md bg-muted/30 border border-border/40 px-3 py-2 text-sm font-mono">
            <span className="text-blue-400 truncate">{branch}</span>
            <span className="text-muted-foreground/50 flex-shrink-0">→</span>
            <span className="text-muted-foreground truncate">{baseBranch}</span>
          </div>

          {/* Typed confirmation */}
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              Type <span className="font-mono text-foreground/70">{branch}</span> to confirm
            </p>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && isConfirmed && handleMerge()}
              placeholder={branch}
              className="font-mono text-xs h-8"
              autoFocus
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setTyped("")
              onOpenChange(false)
            }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!isConfirmed || mergeMutation.isPending}
            onClick={handleMerge}
            className="bg-purple-600 hover:bg-purple-700 text-white disabled:opacity-40"
          >
            {mergeMutation.isPending ? "Merging…" : "Merge pull request"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
