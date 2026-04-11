import { z } from "zod"
import { router, publicProcedure } from "../index"
import { readFile, readdir, stat } from "node:fs/promises"
import { join, relative } from "node:path"
import { createConnection } from "node:net"
import http from "node:http"

// Framework → default port mapping (shared with renderer constants)
const FRAMEWORK_PORT_MAP: Record<string, number> = {
  vite: 5173,
  next: 3000,
  "react-scripts": 3000,
  nuxt: 3000,
  angular: 4200,
  astro: 4321,
  svelte: 5173,
  remix: 5173,
  gatsby: 8000,
}

const COMMON_DEV_PORTS = [3000, 3001, 5173, 5174, 8080, 8081, 8000, 4200, 4321]

// Route scanning exclusions
const NEXT_EXCLUDED_FILES = new Set([
  "layout.tsx",
  "layout.ts",
  "layout.jsx",
  "layout.js",
  "loading.tsx",
  "loading.ts",
  "loading.jsx",
  "loading.js",
  "error.tsx",
  "error.ts",
  "error.jsx",
  "error.js",
  "not-found.tsx",
  "not-found.ts",
  "not-found.jsx",
  "not-found.js",
  "template.tsx",
  "template.ts",
  "template.jsx",
  "template.js",
  "route.ts",
  "route.js",
  "_app.tsx",
  "_app.ts",
  "_app.jsx",
  "_app.js",
  "_document.tsx",
  "_document.ts",
  "_document.jsx",
  "_document.js",
  "_error.tsx",
  "_error.ts",
  "_error.jsx",
  "_error.js",
])

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  "dist",
  "build",
  ".svelte-kit",
  "__pycache__",
])

// Route scan cache keyed by projectPath
const routeCache = new Map<string, { routes: ScannedRoute[]; framework: string | null; timestamp: number }>()
const ROUTE_CACHE_TTL = 5000

interface ScannedRoute {
  path: string
  name: string
  type: "page" | "api" | "layout"
  sourceFile: string
  isDynamic: boolean
}

interface DetectedServer {
  port: number
  url: string
  framework: string | null
  status: "running"
}

/**
 * Check if a TCP port is open on 127.0.0.1
 */
function isPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    socket.setTimeout(300)
    socket.on("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.on("timeout", () => {
      socket.destroy()
      resolve(false)
    })
    socket.on("error", () => {
      socket.destroy()
      resolve(false)
    })
  })
}

/**
 * Check if a port is serving HTTP content
 */
function isHttpServer(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 1000 }, (res) => {
      res.resume()
      resolve(res.statusCode !== undefined && res.statusCode < 500)
    })
    req.on("error", () => resolve(false))
    req.on("timeout", () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * Detect framework from package.json
 */
async function detectFramework(projectPath: string): Promise<{ framework: string | null; expectedPort: number | null }> {
  try {
    const pkgPath = join(projectPath, "package.json")
    const pkgData = await readFile(pkgPath, "utf-8")
    const pkg = JSON.parse(pkgData)

    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    const scripts = pkg.scripts || {}
    const devScript = scripts.dev || scripts.start || ""

    // Check for framework indicators
    if (deps.next) return { framework: "next", expectedPort: 3000 }
    if (deps.vite || devScript.includes("vite")) return { framework: "vite", expectedPort: 5173 }
    if (deps["react-scripts"]) return { framework: "react-scripts", expectedPort: 3000 }
    if (deps.nuxt) return { framework: "nuxt", expectedPort: 3000 }
    if (deps["@angular/core"]) return { framework: "angular", expectedPort: 4200 }
    if (deps.astro) return { framework: "astro", expectedPort: 4321 }
    if (deps.svelte || deps["@sveltejs/kit"]) return { framework: "svelte", expectedPort: 5173 }
    if (deps.remix || deps["@remix-run/react"]) return { framework: "remix", expectedPort: 5173 }
    if (deps.gatsby) return { framework: "gatsby", expectedPort: 8000 }

    // Check dev script for port hints
    const portMatch = devScript.match(/--port\s+(\d+)|-p\s+(\d+)|PORT=(\d+)/)
    if (portMatch) {
      const port = parseInt(portMatch[1] || portMatch[2] || portMatch[3], 10)
      return { framework: null, expectedPort: port }
    }

    return { framework: null, expectedPort: null }
  } catch {
    return { framework: null, expectedPort: null }
  }
}

/**
 * Walk directory for Next.js App Router pages
 */
async function scanNextAppRouter(appDir: string, basePath: string, maxDepth: number): Promise<ScannedRoute[]> {
  if (maxDepth <= 0) return []
  const routes: ScannedRoute[] = []

  let entries
  try {
    entries = await readdir(appDir, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue

    if (entry.isDirectory()) {
      // Skip private folders and parallel routes
      if (entry.name.startsWith("_") || entry.name.startsWith("@")) continue
      // Skip intercepting routes
      if (entry.name.startsWith("(.)") || entry.name.startsWith("(..)")) continue

      let segment = entry.name
      // Route groups — strip parens, don't add to path
      if (segment.startsWith("(") && segment.endsWith(")")) {
        const subRoutes = await scanNextAppRouter(join(appDir, entry.name), basePath, maxDepth - 1)
        routes.push(...subRoutes)
        continue
      }
      // Dynamic segments
      const isDynamic = segment.startsWith("[")
      if (isDynamic) {
        segment = ":" + segment.replace(/^\[\.{0,3}/, "").replace(/\]$/, "")
      }

      const newPath = basePath === "/" ? `/${segment}` : `${basePath}/${segment}`
      const subRoutes = await scanNextAppRouter(join(appDir, entry.name), newPath, maxDepth - 1)
      routes.push(...subRoutes)
    } else if (entry.isFile()) {
      if (NEXT_EXCLUDED_FILES.has(entry.name)) continue

      const isPage = entry.name.match(/^page\.(tsx?|jsx?|mdx?)$/)
      if (isPage) {
        routes.push({
          path: basePath || "/",
          name: basePath === "/" ? "Home" : basePath.split("/").pop() || basePath,
          type: "page",
          sourceFile: join(appDir, entry.name),
          isDynamic: basePath.includes(":"),
        })
      }
    }
  }

  return routes
}

/**
 * Walk directory for Next.js Pages Router
 */
async function scanNextPagesRouter(pagesDir: string, basePath: string, maxDepth: number): Promise<ScannedRoute[]> {
  if (maxDepth <= 0) return []
  const routes: ScannedRoute[] = []

  let entries
  try {
    entries = await readdir(pagesDir, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue

    if (entry.isDirectory()) {
      if (entry.name === "api") continue
      const newPath = basePath === "/" ? `/${entry.name}` : `${basePath}/${entry.name}`
      const subRoutes = await scanNextPagesRouter(join(pagesDir, entry.name), newPath, maxDepth - 1)
      routes.push(...subRoutes)
    } else if (entry.isFile()) {
      if (NEXT_EXCLUDED_FILES.has(entry.name)) continue
      if (!entry.name.match(/\.(tsx?|jsx?|mdx?)$/)) continue

      let segment = entry.name.replace(/\.(tsx?|jsx?|mdx?)$/, "")
      if (segment === "index") segment = ""

      const isDynamic = segment.startsWith("[")
      if (isDynamic) {
        segment = ":" + segment.replace(/^\[\.{0,3}/, "").replace(/\]$/, "")
      }

      const routePath = segment ? (basePath === "/" ? `/${segment}` : `${basePath}/${segment}`) : basePath || "/"

      routes.push({
        path: routePath,
        name: segment || "Home",
        type: "page",
        sourceFile: join(pagesDir, entry.name),
        isDynamic,
      })
    }
  }

  return routes
}

/**
 * Scan generic file-based routes (src/pages, src/views, src/routes)
 */
async function scanGenericRoutes(dir: string, basePath: string, maxDepth: number): Promise<ScannedRoute[]> {
  if (maxDepth <= 0) return []
  const routes: ScannedRoute[] = []

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue

    if (entry.isDirectory()) {
      const newPath = basePath === "/" ? `/${entry.name}` : `${basePath}/${entry.name}`
      const subRoutes = await scanGenericRoutes(join(dir, entry.name), newPath, maxDepth - 1)
      routes.push(...subRoutes)
    } else if (entry.isFile()) {
      if (!entry.name.match(/\.(tsx?|jsx?|vue|svelte)$/)) continue
      // Skip test files, stories, etc.
      if (entry.name.includes(".test.") || entry.name.includes(".spec.") || entry.name.includes(".stories.")) continue

      let segment = entry.name.replace(/\.(tsx?|jsx?|vue|svelte)$/, "")
      if (segment === "index" || segment === "+page") segment = ""

      const isDynamic = segment.startsWith("[") || segment.startsWith("$")
      if (isDynamic) {
        segment = ":" + segment.replace(/^\[\.{0,3}/, "").replace(/\]$/, "").replace(/^\$/, "")
      }

      const routePath = segment ? (basePath === "/" ? `/${segment}` : `${basePath}/${segment}`) : basePath || "/"

      routes.push({
        path: routePath,
        name: segment || basePath.split("/").pop() || "Home",
        type: "page",
        sourceFile: join(dir, entry.name),
        isDynamic,
      })
    }
  }

  return routes
}

/**
 * Try scanning from multiple possible root directories (monorepo support)
 */
async function findRoutesDir(projectPath: string): Promise<{ dir: string; type: "next-app" | "next-pages" | "generic" } | null> {
  const candidates = [
    // Next.js App Router
    { path: join(projectPath, "app"), type: "next-app" as const },
    { path: join(projectPath, "src", "app"), type: "next-app" as const },
    // Next.js Pages Router
    { path: join(projectPath, "pages"), type: "next-pages" as const },
    { path: join(projectPath, "src", "pages"), type: "next-pages" as const },
    // Generic file-based routing
    { path: join(projectPath, "src", "routes"), type: "generic" as const },
    { path: join(projectPath, "src", "views"), type: "generic" as const },
    { path: join(projectPath, "src", "pages"), type: "generic" as const },
    // Monorepo candidates
    { path: join(projectPath, "apps", "web", "app"), type: "next-app" as const },
    { path: join(projectPath, "apps", "web", "src", "app"), type: "next-app" as const },
    { path: join(projectPath, "apps", "web", "pages"), type: "next-pages" as const },
  ]

  for (const candidate of candidates) {
    try {
      const s = await stat(candidate.path)
      if (s.isDirectory()) return { dir: candidate.path, type: candidate.type }
    } catch {
      // Directory doesn't exist
    }
  }

  return null
}

export const devServerRouter = router({
  /**
   * Detect running dev servers for a project
   */
  detectServers: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(async ({ input }): Promise<DetectedServer[]> => {
      const { projectPath } = input
      const { framework, expectedPort } = await detectFramework(projectPath)

      // Build port list — expected port first, then common ports
      const portsToCheck = new Set<number>()
      if (expectedPort) portsToCheck.add(expectedPort)
      for (const port of COMMON_DEV_PORTS) portsToCheck.add(port)

      const servers: DetectedServer[] = []

      // Probe all ports in parallel
      const results = await Promise.all(
        Array.from(portsToCheck).map(async (port) => {
          // Try IPv4 first (127.0.0.1), then IPv6 (::1)
          let open = await isPortOpen(port, "127.0.0.1")
          if (!open) open = await isPortOpen(port, "::1")
          if (!open) return null

          // Verify it's an HTTP server
          const isHttp = await isHttpServer(port)
          if (!isHttp) return null

          return {
            port,
            url: `http://localhost:${port}`,
            framework: port === expectedPort ? framework : null,
            status: "running" as const,
          }
        }),
      )

      for (const result of results) {
        if (result) servers.push(result)
      }

      return servers
    }),

  /**
   * Scan project for route definitions
   */
  scanRoutes: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(async ({ input }): Promise<{ routes: ScannedRoute[]; framework: string | null }> => {
      const { projectPath } = input

      // Check cache
      const cached = routeCache.get(projectPath)
      if (cached && Date.now() - cached.timestamp < ROUTE_CACHE_TTL) {
        return { routes: cached.routes, framework: cached.framework }
      }

      const { framework } = await detectFramework(projectPath)
      const routesDir = await findRoutesDir(projectPath)

      let routes: ScannedRoute[] = []

      if (routesDir) {
        const maxDepth = 5
        switch (routesDir.type) {
          case "next-app":
            routes = await scanNextAppRouter(routesDir.dir, "/", maxDepth)
            break
          case "next-pages":
            routes = await scanNextPagesRouter(routesDir.dir, "/", maxDepth)
            break
          case "generic":
            routes = await scanGenericRoutes(routesDir.dir, "/", maxDepth)
            break
        }
      }

      // Sort: / first, then alphabetically
      routes.sort((a, b) => {
        if (a.path === "/") return -1
        if (b.path === "/") return 1
        return a.path.localeCompare(b.path)
      })

      // Make sourceFile relative for display
      routes = routes.map((r) => ({
        ...r,
        sourceFile: relative(projectPath, r.sourceFile),
      }))

      // Cache
      routeCache.set(projectPath, { routes, framework, timestamp: Date.now() })

      return { routes, framework }
    }),
})
