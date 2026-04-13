/**
 * Crash Recovery tRPC Router
 *
 * Provides endpoints for the renderer to query crash state
 * and trigger session restoration.
 */

import { z } from "zod"
import { eq } from "drizzle-orm"
import { publicProcedure, router } from "../index"
import { getDatabase, subChats } from "../../db"

/**
 * Get crash recovery information for the renderer
 */
export const crashRecoveryRouter = router({
  /**
   * Get information about crashed sessions that can be restored
   */
  getCrashInfo: publicProcedure.query(async () => {
    // Check if crash recovery data was stored during startup
    // This is populated by initCrashRecovery() in main/index.ts
    const crashInfo = (global as any).__crashRecoveryInfo as
      | { didCrash: boolean; crashedSubChatIds: string[] }
      | undefined

    if (!crashInfo || !crashInfo.didCrash) {
      return {
        didCrash: false,
        recoverableSessions: [],
      }
    }

    // Get details about the crashed sub-chats
    const db = getDatabase()
    const crashedSubChats = db
      .select({
        id: subChats.id,
        name: subChats.name,
        chatId: subChats.chatId,
        sessionId: subChats.sessionId,
        mode: subChats.mode,
        updatedAt: subChats.updatedAt,
      })
      .from(subChats)
      .where(
        eq(subChats.id, crashInfo.crashedSubChatIds[0] || ""),
      )
      .all()

    // Get all if there were multiple
    const allCrashedSubChats = crashInfo.crashedSubChatIds.flatMap((id) => {
      return db
        .select({
          id: subChats.id,
          name: subChats.name,
          chatId: subChats.chatId,
          sessionId: subChats.sessionId,
          mode: subChats.mode,
          updatedAt: subChats.updatedAt,
        })
        .from(subChats)
        .where(eq(subChats.id, id))
        .all()
    })

    // Filter out any that no longer exist in the database
    const validSessions = allCrashedSubChats.filter(
      (sc) => sc.sessionId !== null,
    )

    return {
      didCrash: true,
      recoverableSessions: validSessions.map((sc) => ({
        subChatId: sc.id,
        chatId: sc.chatId,
        name: sc.name || "Untitled",
        sessionId: sc.sessionId!,
        mode: sc.mode,
        lastActive: sc.updatedAt?.toISOString() || new Date().toISOString(),
      })),
    }
  }),

  /**
   * Dismiss the crash recovery notification
   * (user chose not to restore sessions)
   */
  dismissCrashRecovery: publicProcedure.mutation(() => {
    // Clear the global crash info so it doesn't show again this session
    delete (global as any).__crashRecoveryInfo
    return { success: true }
  }),

  /**
   * Mark a specific session as restored
   * (called after renderer successfully restores a session)
   */
  markSessionRestored: publicProcedure
    .input(z.object({ subChatId: z.string() }))
    .mutation(({ input }) => {
      const crashInfo = (global as any).__crashRecoveryInfo as
        | { didCrash: boolean; crashedSubChatIds: string[] }
        | undefined

      if (crashInfo) {
        // Remove this subChatId from the crashed list
        crashInfo.crashedSubChatIds = crashInfo.crashedSubChatIds.filter(
          (id) => id !== input.subChatId,
        )

        // If all sessions have been restored, clear the crash info
        if (crashInfo.crashedSubChatIds.length === 0) {
          delete (global as any).__crashRecoveryInfo
        }
      }

      return { success: true }
    }),
})
