/**
 * Category balance tracking for the memory system.
 * Monitors distribution across all 9 categories and identifies gaps.
 */

import { getCategoryDistribution, MEMORY_CATEGORIES, type MemoryCategory } from "./extraction"

export interface CategoryStatus {
  name: MemoryCategory
  count: number
  percentage: number
  status: "healthy" | "sparse" | "empty"
}

export interface CategoryHealthReport {
  categories: CategoryStatus[]
  overallBalance: number // 0-100, higher = more balanced
  totalMemories: number
  sparseCategories: MemoryCategory[]
}

/**
 * Get a health report of category distribution for a project.
 * Uses Shannon entropy normalized to max entropy (uniform distribution)
 * to produce a 0-100 balance score.
 */
export function getCategoryHealthReport(projectId: string): CategoryHealthReport {
  const dist = getCategoryDistribution(projectId)
  const total = Object.values(dist).reduce((a, b) => a + b, 0)

  const categories: CategoryStatus[] = MEMORY_CATEGORIES.map(cat => {
    const count = dist[cat]
    const percentage = total > 0 ? Math.round((count / total) * 100) : 0
    const status: CategoryStatus["status"] =
      count === 0 ? "empty" :
      count < Math.max(2, Math.floor(total / MEMORY_CATEGORIES.length * 0.5)) ? "sparse" :
      "healthy"

    return { name: cat, count, percentage, status }
  })

  // Shannon entropy normalized to [0, 100]
  let overallBalance = 0
  if (total > 0) {
    const maxEntropy = Math.log2(MEMORY_CATEGORIES.length) // ~3.17 for 9 categories
    let entropy = 0
    for (const cat of MEMORY_CATEGORIES) {
      const p = dist[cat] / total
      if (p > 0) {
        entropy -= p * Math.log2(p)
      }
    }
    overallBalance = Math.round((entropy / maxEntropy) * 100)
  }

  const sparseCategories = categories
    .filter(c => c.status === "sparse" || c.status === "empty")
    .map(c => c.name)

  return {
    categories,
    overallBalance,
    totalMemories: total,
    sparseCategories,
  }
}

/**
 * Get categories that are significantly underrepresented.
 * A category is underrepresented if it has fewer than half its "fair share"
 * of the total memory count.
 */
export function getUnderrepresentedCategories(projectId: string): MemoryCategory[] {
  const dist = getCategoryDistribution(projectId)
  const total = Object.values(dist).reduce((a, b) => a + b, 0)
  if (total < 5) return [] // Not enough data to judge

  const fairShare = total / MEMORY_CATEGORIES.length
  return MEMORY_CATEGORIES.filter(cat => dist[cat] < fairShare * 0.5)
}
