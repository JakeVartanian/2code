import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import { resolve } from "path"
import react from "@vitejs/plugin-react"
import tailwindcss from "tailwindcss"
import autoprefixer from "autoprefixer"

const isDev = process.env.NODE_ENV !== "production"

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        // Don't externalize these - bundle them instead
        exclude: ["superjson", "trpc-electron", "gray-matter", "async-mutex"],
      }),
    ],
    build: {
      lib: {
        entry: resolve(__dirname, "src/main/index.ts"),
      },
      rollupOptions: {
        external: [
          "electron",
          "better-sqlite3",
          "@anthropic-ai/claude-agent-sdk", // ESM module - must use dynamic import
        ],
        output: {
          format: "cjs",
        },
      },
    },
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["trpc-electron"],
      }),
    ],
    build: {
      lib: {
        entry: resolve(__dirname, "src/preload/index.ts"),
      },
      rollupOptions: {
        external: ["electron"],
        output: {
          format: "cjs",
        },
      },
    },
  },
  renderer: {
    plugins: [
      react(),
      // Prevent streamdown's unused code-block and mermaid components from pulling
      // in all 213 shiki grammar chunks + full mermaid bundle. We override both
      // the `code` component (using our own CodeBlock + shiki-theme-loader with
      // only 12 languages) and handle mermaid rendering ourselves.
      {
        name: "exclude-streamdown-heavy-chunks",
        enforce: "pre",
        resolveId(source, importer) {
          // Block streamdown's lazy imports of code-block (pulls in full shiki)
          // and mermaid (we have our own mermaid-block.tsx)
          if (
            importer?.includes("node_modules/streamdown") &&
            (source.includes("code-block") || source.includes("mermaid"))
          ) {
            return { id: `\0streamdown-stub:${source}`, moduleSideEffects: false }
          }
          return null
        },
        load(id) {
          if (id.startsWith("\0streamdown-stub:")) {
            return "export const CodeBlock = () => null; export const Mermaid = () => null;"
          }
          return null
        },
      },
    ],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer"),
      },
      dedupe: ["shiki", "@shikijs/core", "@shikijs/engine-javascript"],
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          login: resolve(__dirname, "src/renderer/login.html"),
        },
        output: {
          manualChunks(id) {
            // Monaco editor (~2-3MB) - only loaded when file viewer opens
            if (id.includes("monaco-editor") || id.includes("@monaco-editor")) {
              return "vendor-monaco"
            }
            // xterm (~1.5MB) - only loaded when terminal opens
            if (id.includes("xterm") || id.includes("@xterm")) {
              return "vendor-xterm"
            }
            // Diff viewer (~500KB-1MB) - only loaded when diff view opens
            if (id.includes("@pierre/diffs") || (id.includes("node_modules/diff") && !id.includes("diff-match-patch"))) {
              return "vendor-diff"
            }
            // Motion/framer-motion (~150KB) - animations, can load async
            if (id.includes("framer-motion") || id.includes("motion")) {
              return "vendor-motion"
            }
          },
        },
      },
    },
    css: {
      postcss: {
        plugins: [tailwindcss, autoprefixer],
      },
    },
  },
})
