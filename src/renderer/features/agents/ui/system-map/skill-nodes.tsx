/**
 * SkillNodes — Grid of installed skill badges showing name,
 * source provenance, and optional description.
 */

import { memo } from "react"
import { Puzzle, User, FolderGit2, Package } from "lucide-react"
import { cn } from "../../../../lib/utils"

interface Skill {
  name: string
  source: "user" | "project" | "plugin"
  description?: string
}

interface SkillNodesProps {
  skills: Skill[]
}

const SOURCE_CONFIG: Record<
  Skill["source"],
  { label: string; className: string; icon: React.ElementType }
> = {
  user: {
    label: "User",
    className: "bg-cyan-400/10 text-cyan-400 border-cyan-400/20",
    icon: User,
  },
  project: {
    label: "Project",
    className: "bg-purple-400/10 text-purple-400 border-purple-400/20",
    icon: FolderGit2,
  },
  plugin: {
    label: "Plugin",
    className: "bg-amber-400/10 text-amber-400 border-amber-400/20",
    icon: Package,
  },
}

const SkillBadge = memo(function SkillBadge({ skill }: { skill: Skill }) {
  const config = SOURCE_CONFIG[skill.source]
  const SourceIcon = config.icon

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/30 p-3 hover:bg-zinc-800/40 transition-colors duration-200">
      <div className="flex items-center gap-2">
        <Puzzle className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        <span className="text-sm font-medium text-zinc-200 truncate">
          {skill.name}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border",
            config.className,
          )}
        >
          <SourceIcon className="w-2.5 h-2.5" />
          {config.label}
        </span>
        {skill.description && (
          <span className="text-[11px] text-zinc-500 truncate">
            {skill.description}
          </span>
        )}
      </div>
    </div>
  )
})

export const SkillNodes = memo(function SkillNodes({
  skills,
}: SkillNodesProps) {
  if (skills.length === 0) {
    return (
      <p className="text-xs text-zinc-600 italic pt-3">
        No skills installed.
      </p>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-2 pt-3">
      {skills.map((skill) => (
        <SkillBadge key={`${skill.source}-${skill.name}`} skill={skill} />
      ))}
    </div>
  )
})
