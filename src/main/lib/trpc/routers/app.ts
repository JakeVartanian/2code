import { publicProcedure, router } from "../index"

let appReady = false

/** Called from main index.ts after DB + window are fully initialized */
export function setAppReady(): void {
  appReady = true
}

export const appStatusRouter = router({
  /** Renderer polls this until true before making any DB-touching calls */
  status: publicProcedure.query(() => ({
    ready: appReady,
  })),
})
