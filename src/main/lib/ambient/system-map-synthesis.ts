/**
 * System Map Synthesis — reads architecture memories and produces
 * structured SystemZone[] data via a Sonnet call.
 */

import { eq, and } from "drizzle-orm"
import { getDatabase, projectMemories, projects } from "../db"
import type { AmbientProvider } from "./provider"
import {
  type SystemZone,
  ZONE_ICON_NAMES,
  POSITION_HINTS,
} from "../../../shared/system-map-types"

const SYNTHESIS_PROMPT = `You are analyzing a software project's architecture to produce a visual system map.

Given the architecture and integration memories below, produce a JSON array of 4-8 "system zones" — the major logical components of this application. Every project is different, so the zones should be unique to THIS codebase.

Examples of zones (adapt to what you see):
- For a web app: "Frontend", "API Layer", "Database", "Auth", "Background Jobs"
- For a DeFi project: "Smart Contracts", "ABI/Interfaces", "Frontend", "Subgraph", "Oracle"
- For a mobile app: "React Native UI", "Navigation", "API Client", "Push Notifications"
- For a CLI tool: "CLI Parser", "Core Engine", "Plugin System", "Config"

Rules:
1. Output ONLY a valid JSON array of zone objects
2. Each zone must have: id, name, icon, description, linkedFiles, connections, positionHint
3. Zone names should be human-readable, specific to this project (not generic)
4. description = 1-2 lines summarizing the tech stack and purpose
5. linkedFiles = key file paths from the memories (2-6 per zone)
6. connections = how this zone talks to other zones, with protocol labels
7. positionHint = where to place this zone in the diagram layout
8. icon must be one of: ${ZONE_ICON_NAMES.join(", ")}
9. positionHint must be one of: ${POSITION_HINTS.join(", ")}
10. Aim for the most connected/central zone to have positionHint "center"
11. Place zones logically: user-facing at top, infrastructure at bottom, data on sides

Example output:
[
  {
    "id": "frontend",
    "name": "Frontend",
    "icon": "monitor",
    "description": "React 19 with Tailwind CSS and Radix UI components. State via Jotai + Zustand.",
    "linkedFiles": ["src/renderer/App.tsx", "src/renderer/features/"],
    "connections": [
      { "targetZoneId": "api", "protocol": "tRPC", "direction": "bidirectional" }
    ],
    "positionHint": "top"
  },
  {
    "id": "api",
    "name": "Backend API",
    "icon": "server",
    "description": "tRPC routers in Electron main process. Handles IPC, file ops, Claude SDK.",
    "linkedFiles": ["src/main/lib/trpc/"],
    "connections": [
      { "targetZoneId": "database", "protocol": "Drizzle ORM", "direction": "outgoing" }
    ],
    "positionHint": "center"
  }
]`

/**
 * Synthesize a system map from existing architecture memories.
 * Calls Sonnet to produce structured zone data.
 */
export async function synthesizeSystemMap(
  projectId: string,
  projectPath: string,
  provider: AmbientProvider,
): Promise<SystemZone[]> {
  const db = getDatabase()

  // Read architecture + integrations memories
  const memories = db
    .select()
    .from(projectMemories)
    .where(
      and(
        eq(projectMemories.projectId, projectId),
        eq(projectMemories.isArchived, false),
      ),
    )
    .all()
    .filter(
      (m) =>
        m.category === "architecture" ||
        m.category === "deployment" ||
        m.category === "convention" ||
        m.category === "design", // UI/UX zones deserve map representation
    )

  if (memories.length === 0) {
    console.warn("[SystemMap] No architecture memories found, skipping synthesis")
    return []
  }

  // Build context from memories
  let context = `# Architecture Memories for: ${projectPath.split("/").pop()}\n\n`
  for (const m of memories) {
    context += `## [${m.category}] ${m.title}\n${m.content}\n`
    if (m.linkedFiles) {
      try {
        const files = JSON.parse(m.linkedFiles)
        if (Array.isArray(files) && files.length > 0) {
          context += `Files: ${files.join(", ")}\n`
        }
      } catch { /* skip */ }
    }
    context += "\n"
  }

  // Call Sonnet for structured synthesis
  const result = await provider.callSonnet(SYNTHESIS_PROMPT, context.slice(0, 20000))

  // Parse zones from response
  const zones = parseZones(result.text)

  if (zones.length === 0) {
    console.warn("[SystemMap] Synthesis produced no valid zones")
    return []
  }

  // Store in projects table
  db.update(projects)
    .set({
      systemMap: JSON.stringify(zones),
      systemMapBuiltAt: new Date(),
    })
    .where(eq(projects.id, projectId))
    .run()

  console.log(`[SystemMap] Synthesized ${zones.length} zones for project ${projectId}`)
  return zones
}

/**
 * Parse and validate SystemZone[] from AI response text.
 */
function parseZones(text: string): SystemZone[] {
  try {
    // Strip markdown fences before extracting JSON
    const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "")
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []

    const parsed = JSON.parse(jsonMatch[0])
    if (!Array.isArray(parsed)) return []

    const validIcons = new Set(ZONE_ICON_NAMES)
    const validPositions = new Set(POSITION_HINTS)

    return parsed
      .filter(
        (z: any) =>
          z.id &&
          z.name &&
          z.description &&
          typeof z.id === "string" &&
          typeof z.name === "string",
      )
      .slice(0, 10) // max 10 zones
      .map((z: any): SystemZone => ({
        id: String(z.id),
        name: String(z.name).slice(0, 50),
        icon: validIcons.has(z.icon) ? z.icon : "code",
        description: String(z.description).slice(0, 200),
        linkedFiles: Array.isArray(z.linkedFiles)
          ? z.linkedFiles.filter((f: any) => typeof f === "string").slice(0, 10)
          : [],
        connections: Array.isArray(z.connections)
          ? z.connections
              .filter(
                (c: any) =>
                  c.targetZoneId && c.protocol && typeof c.targetZoneId === "string",
              )
              .map((c: any) => ({
                targetZoneId: String(c.targetZoneId),
                protocol: String(c.protocol).slice(0, 30),
                direction: c.direction === "bidirectional" ? "bidirectional" : "outgoing",
              }))
          : [],
        positionHint: validPositions.has(z.positionHint) ? z.positionHint : "center",
      }))
  } catch (err) {
    console.warn("[SystemMap] Failed to parse zones from AI response:", err)
    return []
  }
}
