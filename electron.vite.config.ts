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
          "@prisma/client",
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
      react({
        // In dev mode, use WDYR as JSX import source to track ALL component re-renders
        jsxImportSource: isDev
          ? "@welldone-software/why-did-you-render"
          : undefined,
      }),
    ],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer"),
      },
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
