# Crash Recovery System

## Overview

A comprehensive crash recovery system that detects unexpected app termination (like the c-ares DNS crash) and enables automatic session restoration on restart.

## The Problem We're Solving

**DNS Library Crash**: 2Code is experiencing `EXC_BREAKPOINT` crashes in Electron's bundled c-ares DNS library:
- Crash location: `ares_dns_rr_get_ttl` (DNS Time-To-Live parsing)
- Affects Electron 39.8.7 (current version in 2Code)
- Also present in Electron 40.x (no fix available)
- Appears to be macOS 26.x specific ([Issue #49522](https://github.com/electron/electron/issues/49522))
- Catastrophic: kills all windows, terminates active Claude sessions

## What We Built

### 1. **Crash Detection System** (`src/main/lib/crash-recovery.ts`)

Tracks app state and detects crashes by monitoring clean shutdown:

- **On app start**: Writes `cleanShutdown: false` to disk
- **During runtime**: Periodically saves list of streaming sub-chats (every 5s)
- **On clean shutdown**: Writes `cleanShutdown: true`
- **On next start**: If previous state was `cleanShutdown: false`, we know it crashed

**State file**: `{userData}/crash-state.json`

```json
{
  "cleanShutdown": false,
  "lastActiveSubChatIds": ["abc123", "def456"],
  "timestamp": 1713063244000,
  "version": "0.1.2"
}
```

### 2. **Backend Integration** (`src/main/index.ts`)

Integrated into app lifecycle:

```typescript
// On startup (after database init):
const crashRecoveryInfo = initCrashRecovery()
startCrashRecoveryTracking() // Every 5 seconds

// On shutdown (before quit):
stopCrashRecoveryTracking()
abortAllClaudeSessions()
markCleanShutdown() // Sets cleanShutdown: true
```

### 3. **tRPC API** (`src/main/lib/trpc/routers/crash-recovery.ts`)

Exposes crash recovery state to the renderer:

- `crashRecovery.getCrashInfo`: Get crashed sessions
- `crashRecovery.dismissCrashRecovery`: User chose not to restore
- `crashRecovery.markSessionRestored`: Track restoration progress

### 4. **UI Banner** (`src/renderer/features/crash-recovery/crash-recovery-banner.tsx`)

Prominent crash recovery UI that shows on startup if a crash was detected:

- **Auto-detect**: Queries crash state on app load
- **Restore all**: Re-opens all crashed sub-chat tabs
- **Dismiss**: Ignore crash and start fresh
- **Session tracking**: Uses Claude SDK's `sessionId` for continuity

## How Session Restoration Works

1. **Crash detected** → Banner appears at top of window
2. **User clicks "Restore All"** →
   - Navigate to each crashed chat (`chatId` + `subChatId`)
   - Re-open sub-chat tabs
   - Claude SDK resumes using stored `sessionId`
3. **Sessions restored** → User can continue where they left off

## Testing the System

### Simulate a Crash

```bash
# Start the app in dev mode
bun run dev

# In another terminal, kill the renderer process
pkill -9 "2Code Helper"

# Restart the app - you should see the crash recovery banner
```

### Verify Crash State

```bash
# Check the crash state file
cat ~/Library/Application\ Support/2Code\ Dev/crash-state.json

# Should show:
# {
#   "cleanShutdown": false,  # Indicates crash
#   "lastActiveSubChatIds": [...],
#   "timestamp": ...
# }
```

### Test Clean Shutdown

```bash
# Start app
bun run dev

# Quit normally (Cmd+Q or File > Quit)

# Check crash state - should show clean shutdown
cat ~/Library/Application\ Support/2Code\ Dev/crash-state.json

# Should show:
# {
#   "cleanShutdown": true,  # Clean exit
#   ...
# }
```

## Electron Upgrade Recommendations

### Current State
- **2Code**: Electron 39.8.0
- **Latest Stable**: Electron 41.0.2
- **Crash status**: Unfixed (exists in 39.x and 40.x)

### Upgrade Path

```bash
# Update package.json
"electron": "~41.0.0"

# Reinstall
bun install

# Rebuild native modules
bun run postinstall

# Test
bun run dev
```

**Benefits of upgrading:**
- Security patches (Chromium 146, Node 24.14.0)
- Performance improvements
- New features (ASAR integrity, notification enhancements)

**Note**: Upgrading to Electron 41 may NOT fix the c-ares crash (it appears to be macOS 26.x specific). However, it's still recommended for other improvements.

## Architecture Details

### Main Process Flow

```
App Start
  ↓
initDatabase()
  ↓
initCrashRecovery()  ← Checks previous state
  ↓
  ├─ didCrash = false → Mark running, start tracking
  └─ didCrash = true  → Clear stale streamIds, store crash info
  ↓
startCrashRecoveryTracking()  ← Every 5s: update active sessions
  ↓
(App runs...)
  ↓
before-quit event
  ↓
stopCrashRecoveryTracking()
abortAllClaudeSessions()
closeDatabase()
markCleanShutdown()  ← Sets cleanShutdown: true
  ↓
App Quit
```

### Renderer Flow

```
App Loads
  ↓
<CrashRecoveryBanner>
  ↓
trpc.crashRecovery.getCrashInfo.useQuery()
  ↓
  ├─ didCrash = false → No banner
  └─ didCrash = true  → Show banner
       ↓
       User clicks "Restore All"
       ↓
       For each crashed session:
         - navigate({ chatId, subChatId })
         - markSessionRestored({ subChatId })
       ↓
       Toast: "Restored N sessions"
       Banner disappears
```

## Files Created/Modified

### New Files
- `src/main/lib/crash-recovery.ts` - Core crash detection logic
- `src/main/lib/trpc/routers/crash-recovery.ts` - tRPC API
- `src/renderer/features/crash-recovery/crash-recovery-banner.tsx` - UI banner

### Modified Files
- `src/main/index.ts` - Integrated crash recovery into app lifecycle
- `src/main/lib/trpc/routers/index.ts` - Added crash recovery router
- `src/renderer/App.tsx` - Added crash recovery banner to UI

## Monitoring & Debugging

### Logs to Watch

```bash
# On startup
[App] Database initialized
[App] ⚠️  Previous session crashed - 2 sessions available for recovery

# During runtime (every 5s)
[CrashRecovery] Updated active sessions: ["abc123", "def456"]

# On shutdown
[App] Shutting down...
[CrashRecovery] Marking clean shutdown
```

### Console Commands

```javascript
// In DevTools console (renderer):

// Check crash state
window.desktopApi.trpc.crashRecovery.getCrashInfo.query()

// Dismiss crash recovery
window.desktopApi.trpc.crashRecovery.dismissCrashRecovery.mutate()
```

## Future Enhancements

### Potential Improvements
1. **Auto-restore on crash**: Automatically restore sessions without user prompt
2. **Crash reporting**: Send crash reports to analytics
3. **Electron 41+ testing**: Verify if newer Electron versions fix the c-ares issue
4. **Renderer crash recovery**: Extend to handle renderer process crashes separately
5. **Session persistence**: Save more session state (scroll position, open files, etc.)

### Known Limitations
- Only tracks sub-chats with active `streamId` (actively streaming)
- Doesn't track UI state beyond chat/sub-chat navigation
- Requires manual "Restore All" click (could auto-restore)
- No crash report sending (all local)

## Support

For issues or questions about crash recovery:
1. Check logs in Console.app (search for "2Code" or "CrashRecovery")
2. Inspect `~/Library/Application Support/2Code Dev/crash-state.json`
3. Review crash reports in `~/Library/Logs/DiagnosticReports/`
4. Report issues at [GitHub Issues](https://github.com/JakeVartanian/2code/issues)

## References

- [Electron Issue #49522](https://github.com/electron/electron/issues/49522) - Similar crash on macOS 26.2
- [Electron 41 Release Notes](https://www.electronjs.org/blog/electron-41-0)
- [c-ares Documentation](https://c-ares.org/docs.html)
