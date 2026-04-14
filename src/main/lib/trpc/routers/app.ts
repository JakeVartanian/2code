import { publicProcedure, router } from "../index"
import { getCrashDumps, getLatestCrashDump } from "../../crash-dump"

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

  /** Get the most recent crash dump for debugging */
  getLatestCrash: publicProcedure.query(() => ({
    crash: getLatestCrashDump(),
  })),

  /** Get list of all crash dumps */
  getCrashDumpList: publicProcedure.query(() => ({
    crashes: getCrashDumps(),
  })),
})
