/**
 * PlanEditor — editable plan review UI shown after decomposition
 * and before workers start. Users can edit, reorder, add, or remove tasks.
 */

import { memo, useState, useCallback } from "react"
import {
  GripVertical,
  Trash2,
  Plus,
  Play,
  ChevronDown,
  ChevronRight,
} from "lucide-react"
import { Button } from "../../../../components/ui/button"
import { cn } from "../../../../lib/utils"
import type { Autonomy } from "../../stores/orchestration-store"

export interface PlanTask {
  name: string
  description: string
  mode: "agent" | "plan"
  dependsOn: string[]
  allowedPaths: string[]
  acceptanceCriteria: string[]
  estimatedComplexity: "low" | "medium" | "high"
  autonomy: Autonomy
}

interface PlanEditorProps {
  reasoning: string
  tasks: PlanTask[]
  onTasksChange: (tasks: PlanTask[]) => void
  onApprove: () => void
  onCancel: () => void
  isStarting: boolean
}

/**
 * Detect circular dependencies in task graph.
 * Returns the names involved in the cycle, or null if no cycle.
 */
function detectCircularDeps(tasks: PlanTask[]): string[] | null {
  const taskByName = new Map(tasks.map((t) => [t.name, t]))
  const visited = new Set<string>()
  const inStack = new Set<string>()

  function dfs(name: string, path: string[]): string[] | null {
    if (inStack.has(name)) return [...path, name]
    if (visited.has(name)) return null

    visited.add(name)
    inStack.add(name)

    const task = taskByName.get(name)
    if (task) {
      for (const dep of task.dependsOn) {
        const cycle = dfs(dep, [...path, name])
        if (cycle) return cycle
      }
    }

    inStack.delete(name)
    return null
  }

  for (const task of tasks) {
    visited.clear()
    inStack.clear()
    const cycle = dfs(task.name, [])
    if (cycle) return cycle
  }

  return null
}

export const PlanEditor = memo(function PlanEditor({
  reasoning,
  tasks,
  onTasksChange,
  onApprove,
  onCancel,
  isStarting,
}: PlanEditorProps) {
  const [expandedTask, setExpandedTask] = useState<number | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  // Validation checks
  const circularDeps = detectCircularDeps(tasks)
  const duplicateNames = tasks
    .map((t) => t.name)
    .filter((name, i, arr) => arr.indexOf(name) !== i)
  const hasValidationErrors = !!circularDeps || duplicateNames.length > 0

  const updateTask = useCallback(
    (index: number, updates: Partial<PlanTask>) => {
      const next = [...tasks]
      next[index] = { ...next[index]!, ...updates }
      onTasksChange(next)
    },
    [tasks, onTasksChange],
  )

  const removeTask = useCallback(
    (index: number) => {
      const removedName = tasks[index]!.name
      const next = tasks
        .filter((_, i) => i !== index)
        .map((t) => ({
          ...t,
          dependsOn: t.dependsOn.filter((d) => d !== removedName),
        }))
      onTasksChange(next)
      if (expandedTask === index) setExpandedTask(null)
    },
    [tasks, onTasksChange, expandedTask],
  )

  const addTask = useCallback(() => {
    onTasksChange([
      ...tasks,
      {
        name: `New Task ${tasks.length + 1}`,
        description: "",
        mode: "agent",
        dependsOn: [],
        allowedPaths: [],
        acceptanceCriteria: [],
        estimatedComplexity: "medium",
        autonomy: "auto",
      },
    ])
    setExpandedTask(tasks.length)
  }, [tasks, onTasksChange])

  const moveTask = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (toIndex < 0 || toIndex >= tasks.length) return
      const next = [...tasks]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved!)
      onTasksChange(next)
      setExpandedTask(toIndex)
    },
    [tasks, onTasksChange],
  )

  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index)
  }, [])

  const handleDragOver = useCallback(
    (e: React.DragEvent, index: number) => {
      e.preventDefault()
      if (dragIndex !== null && dragIndex !== index) {
        moveTask(dragIndex, index)
        setDragIndex(index)
      }
    },
    [dragIndex, moveTask],
  )

  const handleDragEnd = useCallback(() => {
    setDragIndex(null)
  }, [])

  return (
    <div className="space-y-3">
      {/* Reasoning */}
      {reasoning && (
        <div className="text-xs text-muted-foreground bg-muted/30 rounded-lg p-3">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground block mb-1">
            Approach
          </span>
          {reasoning}
        </div>
      )}

      {/* Task list */}
      <div className="space-y-2">
        {tasks.map((task, index) => {
          const isExpanded = expandedTask === index
          const complexityColor =
            task.estimatedComplexity === "high"
              ? "text-red-400"
              : task.estimatedComplexity === "medium"
                ? "text-yellow-400"
                : "text-green-400"

          return (
            <div
              key={index}
              draggable
              onDragStart={() => handleDragStart(index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragEnd={handleDragEnd}
              className={cn(
                "border border-border/60 rounded-lg transition-colors",
                dragIndex === index && "opacity-50",
              )}
            >
              {/* Header row */}
              <div className="flex items-center gap-2 px-3 py-2">
                <GripVertical className="w-3.5 h-3.5 text-muted-foreground/50 cursor-grab shrink-0" />

                <button
                  onClick={() =>
                    setExpandedTask(isExpanded ? null : index)
                  }
                  className="shrink-0"
                >
                  {isExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                  )}
                </button>

                <span className="text-xs text-muted-foreground shrink-0">
                  {index + 1}.
                </span>

                {/* Inline editable name */}
                <input
                  value={task.name}
                  onChange={(e) =>
                    updateTask(index, { name: e.target.value })
                  }
                  className="flex-1 text-sm font-medium bg-transparent border-none outline-none min-w-0"
                  placeholder="Task name..."
                />

                <span className={cn("text-[10px] shrink-0", complexityColor)}>
                  {task.estimatedComplexity}
                </span>

                <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-muted shrink-0">
                  {task.mode}
                </span>

                <button
                  onClick={() => removeTask(index)}
                  className="text-muted-foreground/50 hover:text-red-400 transition-colors shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Expanded details */}
              {isExpanded && (
                <div className="px-3 pb-3 border-t border-border/30 pt-2 space-y-2">
                  {/* Description */}
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                      Description
                    </label>
                    <textarea
                      value={task.description}
                      onChange={(e) =>
                        updateTask(index, {
                          description: e.target.value,
                        })
                      }
                      rows={3}
                      className="w-full mt-1 text-xs bg-muted/30 border border-border/40 rounded p-2 resize-none outline-none focus:border-border"
                      placeholder="Detailed task instructions..."
                    />
                  </div>

                  {/* Dependencies */}
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                      Depends On
                    </label>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {tasks
                        .filter((_, i) => i !== index)
                        .map((otherTask) => {
                          const isDependent = task.dependsOn.includes(
                            otherTask.name,
                          )
                          return (
                            <button
                              key={otherTask.name}
                              onClick={() => {
                                if (isDependent) {
                                  updateTask(index, {
                                    dependsOn: task.dependsOn.filter(
                                      (d) => d !== otherTask.name,
                                    ),
                                  })
                                } else {
                                  // Check if adding this dep would create a cycle
                                  const testTasks = tasks.map((t, ti) =>
                                    ti === index
                                      ? { ...t, dependsOn: [...t.dependsOn, otherTask.name] }
                                      : t,
                                  )
                                  if (detectCircularDeps(testTasks)) {
                                    return // Would create cycle
                                  }
                                  updateTask(index, {
                                    dependsOn: [...task.dependsOn, otherTask.name],
                                  })
                                }
                              }}
                              className={cn(
                                "text-[10px] px-1.5 py-0.5 rounded transition-colors",
                                isDependent
                                  ? "bg-blue-500/20 text-blue-400 border border-blue-500/40"
                                  : "bg-muted text-muted-foreground hover:bg-muted/80",
                              )}
                            >
                              {otherTask.name}
                            </button>
                          )
                        })}
                      {tasks.length <= 1 && (
                        <span className="text-[10px] text-muted-foreground">
                          No other tasks to depend on
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Mode + Autonomy */}
                  <div className="flex gap-3">
                    <div>
                      <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                        Mode
                      </label>
                      <select
                        value={task.mode}
                        onChange={(e) =>
                          updateTask(index, {
                            mode: e.target.value as "agent" | "plan",
                          })
                        }
                        className="block mt-1 text-xs px-2 py-0.5 rounded border border-border bg-background"
                      >
                        <option value="agent">Agent</option>
                        <option value="plan">Plan</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                        Autonomy
                      </label>
                      <select
                        value={task.autonomy}
                        onChange={(e) =>
                          updateTask(index, {
                            autonomy: e.target.value as Autonomy,
                          })
                        }
                        className="block mt-1 text-xs px-2 py-0.5 rounded border border-border bg-background"
                      >
                        <option value="auto">Auto</option>
                        <option value="review">Review</option>
                        <option value="supervised">Supervised</option>
                        <option value="plan-only">Plan Only</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                        Complexity
                      </label>
                      <select
                        value={task.estimatedComplexity}
                        onChange={(e) =>
                          updateTask(index, {
                            estimatedComplexity: e.target.value as
                              | "low"
                              | "medium"
                              | "high",
                          })
                        }
                        className="block mt-1 text-xs px-2 py-0.5 rounded border border-border bg-background"
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                    </div>
                  </div>

                  {/* Acceptance criteria (comma-separated for simplicity) */}
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                      Acceptance Criteria
                    </label>
                    <textarea
                      value={task.acceptanceCriteria.join("\n")}
                      onChange={(e) =>
                        updateTask(index, {
                          acceptanceCriteria: e.target.value
                            .split("\n")
                            .filter(Boolean),
                        })
                      }
                      rows={2}
                      className="w-full mt-1 text-xs bg-muted/30 border border-border/40 rounded p-2 resize-none outline-none focus:border-border"
                      placeholder="One criterion per line..."
                    />
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Add task button */}
      <button
        onClick={addTask}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-border/60 text-xs text-muted-foreground hover:bg-accent/30 transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        Add Task
      </button>

      {/* Validation errors */}
      {circularDeps && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          Circular dependency detected: {circularDeps.join(" → ")}
        </div>
      )}
      {duplicateNames.length > 0 && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          Duplicate task names: {[...new Set(duplicateNames)].join(", ")}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-2">
        <Button
          size="sm"
          onClick={onApprove}
          disabled={tasks.length === 0 || isStarting || hasValidationErrors}
          className="flex-1"
        >
          <Play className="w-3.5 h-3.5 mr-1" />
          {isStarting ? "Starting..." : "Approve & Start"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={isStarting}
          className="text-muted-foreground"
        >
          Cancel
        </Button>
      </div>
    </div>
  )
})
