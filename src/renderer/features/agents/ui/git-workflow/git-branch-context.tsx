import { useState, useRef, useEffect } from "react"
import { GitBranch, Pencil, Check, X, ChevronDown, AlertTriangle } from "lucide-react"
import { cn } from "../../../../lib/utils"
import type { WorkflowMode } from "./use-git-workflow"

const BRANCH_NAME_REGEX = /^[a-zA-Z0-9._/-]+$/
const INVALID_BRANCH_PATTERNS = [/^-/, /\.\./, /\.$/, /^\./, /@\{/, /\\/, /\s/]

function validateBranchName(name: string): string | null {
  if (!name.trim()) return "Branch name is required"
  if (!BRANCH_NAME_REGEX.test(name)) return "Only letters, numbers, dots, hyphens, underscores, slashes"
  for (const pattern of INVALID_BRANCH_PATTERNS) {
    if (pattern.test(name)) return "Invalid branch name"
  }
  if (name.length > 250) return "Too long (max 250 chars)"
  return null
}

interface GitBranchContextProps {
  mode: WorkflowMode
  branch: string | null
  baseBranch: string | null
  worktreePath: string | null
  behindCount: number
  // Interactive props (only provided in worktree mode)
  chatId?: string
  hasRemote?: boolean
  prState?: string | null
  remoteBranches?: string[]
  isMutating?: boolean
  isBranchDropdownOpen?: boolean
  onRenameBranch?: (newName: string) => Promise<void>
  onUpdateBaseBranch?: (newBase: string) => Promise<void>
  onBranchDropdownOpen?: (open: boolean) => void
}

export function GitBranchContext({
  mode,
  branch,
  baseBranch,
  worktreePath,
  behindCount,
  hasRemote = false,
  prState = null,
  remoteBranches = [],
  isMutating = false,
  isBranchDropdownOpen = false,
  onRenameBranch,
  onUpdateBaseBranch,
  onBranchDropdownOpen,
}: GitBranchContextProps) {
  const displayBranch = branch || "unknown"

  // ── Feature branch rename state ──────────────────────────────────────────
  const [isRenamingBranch, setIsRenamingBranch] = useState(false)
  const [renameValue, setRenameValue] = useState("")
  const [renameError, setRenameError] = useState<string | null>(null)
  const [isRenaming, setIsRenaming] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isRenamingBranch) {
      setRenameValue(displayBranch)
      setRenameError(null)
      setTimeout(() => renameInputRef.current?.select(), 0)
    }
  }, [isRenamingBranch, displayBranch])

  const handleRenameStart = () => {
    if (!onRenameBranch || isMutating) return
    setIsRenamingBranch(true)
  }

  const handleRenameCancel = () => {
    setIsRenamingBranch(false)
    setRenameError(null)
  }

  const handleRenameChange = (val: string) => {
    setRenameValue(val)
    setRenameError(validateBranchName(val))
  }

  const handleRenameSave = async () => {
    const trimmed = renameValue.trim()
    const err = validateBranchName(trimmed)
    if (err) { setRenameError(err); return }
    if (trimmed === displayBranch) { setIsRenamingBranch(false); return }
    setIsRenaming(true)
    try {
      await onRenameBranch!(trimmed)
      setIsRenamingBranch(false)
    } catch {
      // error toast already shown in hook
    } finally {
      setIsRenaming(false)
    }
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleRenameSave()
    if (e.key === "Escape") handleRenameCancel()
  }

  // ── Base branch dropdown state ────────────────────────────────────────────
  const [isSelectingBase, setIsSelectingBase] = useState(false)
  const [baseSearch, setBaseSearch] = useState("")
  const [isUpdatingBase, setIsUpdatingBase] = useState(false)
  const baseDropdownRef = useRef<HTMLDivElement>(null)
  const baseSearchRef = useRef<HTMLInputElement>(null)

  const openBaseDropdown = () => {
    if (!onUpdateBaseBranch || isMutating) return
    setBaseSearch("")
    setIsSelectingBase(true)
    onBranchDropdownOpen?.(true)
    setTimeout(() => baseSearchRef.current?.focus(), 0)
  }

  const closeBaseDropdown = () => {
    setIsSelectingBase(false)
    onBranchDropdownOpen?.(false)
  }

  const handleBaseSelect = async (newBase: string) => {
    if (newBase === baseBranch) { closeBaseDropdown(); return }
    setIsUpdatingBase(true)
    try {
      await onUpdateBaseBranch!(newBase)
    } catch {
      // error toast shown in hook
    } finally {
      setIsUpdatingBase(false)
      closeBaseDropdown()
    }
  }

  // Close base dropdown on outside click
  useEffect(() => {
    if (!isSelectingBase) return
    const handler = (e: MouseEvent) => {
      if (baseDropdownRef.current && !baseDropdownRef.current.contains(e.target as Node)) {
        closeBaseDropdown()
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [isSelectingBase])

  const filteredBranches = remoteBranches.filter(
    (b) => b.toLowerCase().includes(baseSearch.toLowerCase()) && b !== baseBranch
  )

  // ── Render helpers ────────────────────────────────────────────────────────

  const canEdit = !!onRenameBranch && mode === "worktree"

  const renameWarning =
    isRenamingBranch && renameValue.trim() !== displayBranch
      ? prState === "open" || prState === "draft"
        ? { level: "error" as const, text: "A PR is open — renaming will close it on GitHub" }
        : hasRemote
          ? { level: "warn" as const, text: `Will delete origin/${displayBranch} and push as ${renameValue.trim() || "…"}` }
          : null
      : null

  return (
    <div className="px-3 pt-2.5 pb-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        <GitBranch className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />

        {/* ── Feature branch ── */}
        {isRenamingBranch ? (
          <div className="flex items-center gap-1">
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => handleRenameChange(e.target.value)}
              onKeyDown={handleRenameKeyDown}
              disabled={isRenaming}
              className={cn(
                "font-mono text-sm bg-muted/30 border rounded px-1.5 py-0.5 outline-none focus:border-border w-40",
                renameError ? "border-red-500/60" : "border-border/60 focus:border-blue-400/60",
              )}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              onClick={handleRenameSave}
              disabled={!!renameError || isRenaming}
              className="p-0.5 text-green-400 hover:text-green-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Save"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={handleRenameCancel}
              disabled={isRenaming}
              className="p-0.5 text-muted-foreground/60 hover:text-muted-foreground transition-colors"
              title="Cancel"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <button
            onClick={canEdit ? handleRenameStart : undefined}
            className={cn(
              "group flex items-center gap-1 font-mono text-sm font-medium",
              behindCount > 0 ? "text-amber-400" : "text-foreground",
              canEdit && "hover:text-blue-300 transition-colors cursor-pointer",
              !canEdit && "cursor-default",
            )}
            title={canEdit ? "Click to rename branch" : undefined}
          >
            {displayBranch}
            {canEdit && (
              <Pencil className="h-2.5 w-2.5 opacity-0 group-hover:opacity-60 transition-opacity flex-shrink-0" />
            )}
          </button>
        )}

        {/* ── Arrow + base branch ── */}
        {mode === "worktree" && baseBranch !== undefined && (
          <>
            <span className="text-muted-foreground/50 text-xs">→</span>

            {isSelectingBase ? (
              <div ref={baseDropdownRef} className="relative">
                <div className="flex items-center gap-1 border border-border/60 rounded bg-background shadow-lg">
                  <input
                    ref={baseSearchRef}
                    value={baseSearch}
                    onChange={(e) => setBaseSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") closeBaseDropdown() }}
                    placeholder="Filter branches…"
                    className="font-mono text-xs bg-transparent px-2 py-1 outline-none w-32"
                    spellCheck={false}
                  />
                </div>
                <div className="absolute top-full left-0 mt-1 bg-popover border border-border rounded shadow-xl z-50 min-w-[160px] max-h-[160px] overflow-y-auto">
                  {baseBranch && (
                    <div className="px-2.5 py-1.5 text-xs font-mono text-muted-foreground/60 border-b border-border/30 flex items-center gap-1.5">
                      <Check className="h-3 w-3 text-blue-400" />
                      {baseBranch}
                    </div>
                  )}
                  {filteredBranches.length === 0 ? (
                    <div className="px-2.5 py-2 text-xs text-muted-foreground/50 text-center">
                      {remoteBranches.length === 0 ? "Loading…" : "No branches match"}
                    </div>
                  ) : (
                    filteredBranches.map((b) => (
                      <button
                        key={b}
                        onClick={() => handleBaseSelect(b)}
                        disabled={isUpdatingBase}
                        className="w-full text-left px-2.5 py-1.5 text-xs font-mono hover:bg-muted/50 transition-colors disabled:opacity-50"
                      >
                        {b}
                      </button>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <button
                onClick={onUpdateBaseBranch ? openBaseDropdown : undefined}
                className={cn(
                  "group flex items-center gap-0.5 font-mono text-sm text-muted-foreground",
                  onUpdateBaseBranch && "hover:text-blue-300 transition-colors cursor-pointer",
                  !onUpdateBaseBranch && "cursor-default",
                )}
                title={onUpdateBaseBranch ? "Click to change PR target branch" : undefined}
              >
                {baseBranch || "main"}
                {onUpdateBaseBranch && (
                  <ChevronDown className="h-2.5 w-2.5 opacity-0 group-hover:opacity-60 transition-opacity flex-shrink-0" />
                )}
              </button>
            )}

            <span className="ml-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
              isolated
            </span>
          </>
        )}

        {mode === "direct" && (
          <span className="ml-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border/60">
            direct
          </span>
        )}
      </div>

      {/* ── Rename warnings ── */}
      {renameWarning && (
        <div
          className={cn(
            "mt-1.5 pl-5 flex items-start gap-1.5 text-[10px]",
            renameWarning.level === "error" ? "text-red-400" : "text-amber-400/80",
          )}
        >
          <AlertTriangle className="h-3 w-3 flex-shrink-0 mt-0.5" />
          <span>{renameWarning.text}</span>
        </div>
      )}
      {renameError && isRenamingBranch && (
        <p className="mt-1 pl-5 text-[10px] text-red-400">{renameError}</p>
      )}

      {/* ── PR open note after base change ── */}
      {isSelectingBase && (prState === "open" || prState === "draft") && (
        <p className="mt-1.5 pl-5 text-[10px] text-blue-400/70">
          A PR is open — update its base on GitHub too
        </p>
      )}

      {worktreePath && !isRenamingBranch && (
        <p className="mt-0.5 text-[10px] text-muted-foreground/40 font-mono truncate pl-5">
          {worktreePath}
        </p>
      )}
    </div>
  )
}
