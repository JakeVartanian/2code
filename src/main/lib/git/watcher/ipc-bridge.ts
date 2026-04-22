import { ipcMain, BrowserWindow } from "electron";
import { gitWatcherRegistry, type GitWatchEvent } from "./git-watcher";
import { gitCache } from "../cache";

/**
 * IPC Bridge for GitWatcher.
 * Handles subscription/unsubscription from renderer and forwards file change events.
 */

// Track active subscriptions per worktree with subscribing window ID
// This ensures events are sent to the window that subscribed, not the focused window
const activeSubscriptions: Map<string, { windowId: number; unsubscribe: () => void }> = new Map();

// Track in-flight subscription promises to prevent duplicate concurrent subscriptions.
// Without this, rapid subscribe/unsubscribe cycles (e.g. workspace switches) can
// create orphaned subscriptions that leak file watchers → EMFILE crash.
const pendingSubscriptions: Map<string, Promise<void>> = new Map();

/**
 * Register IPC handlers for git watcher.
 * Call this once during app initialization.
 */
export function registerGitWatcherIPC(): void {
	// Handle subscription requests from renderer
	ipcMain.handle(
		"git:subscribe-watcher",
		async (event, worktreePath: string) => {
			if (!worktreePath) return;

			// Already subscribed or subscription in-flight?
			if (activeSubscriptions.has(worktreePath) || pendingSubscriptions.has(worktreePath)) {
				return;
			}

			// Get the window that made the subscription request
			const subscribingWindow = BrowserWindow.fromWebContents(event.sender);
			if (!subscribingWindow || subscribingWindow.isDestroyed()) return;

			const windowId = subscribingWindow.id;

			// Mark as pending BEFORE the async call to prevent duplicate subscriptions
			const subscribePromise = (async () => {
				try {
					// Subscribe to file changes (await to ensure watcher is ready)
					const unsubscribe = await gitWatcherRegistry.subscribe(
						worktreePath,
						(watchEvent: GitWatchEvent) => {
							// Send to the subscribing window, not the focused window
							const subscription = activeSubscriptions.get(worktreePath);
							if (!subscription) return;

							const targetWindow = BrowserWindow.fromId(subscription.windowId);
							if (!targetWindow || targetWindow.isDestroyed()) return;

							gitCache.invalidateStatus(worktreePath);
							gitCache.invalidateParsedDiff(worktreePath);

							try {
								targetWindow.webContents.send("git:status-changed", {
									worktreePath: watchEvent.worktreePath,
									changes: watchEvent.changes,
								});
							} catch {
								// Window may have been destroyed between check and send
							}
						},
					);

					// Check if unsubscribe was requested while we were awaiting
					if (!pendingSubscriptions.has(worktreePath)) {
						// Subscription was cancelled during await — clean up immediately
						unsubscribe();
						console.log(`[GitWatcher] Window ${windowId} subscription to ${worktreePath} cancelled during init — cleaned up`);
						return;
					}

					activeSubscriptions.set(worktreePath, { windowId, unsubscribe });
					console.log(`[GitWatcher] Window ${windowId} subscribed to: ${worktreePath}`);
				} finally {
					pendingSubscriptions.delete(worktreePath);
				}
			})();

			pendingSubscriptions.set(worktreePath, subscribePromise);
			await subscribePromise;
		},
	);

	// Handle unsubscription requests from renderer
	ipcMain.handle(
		"git:unsubscribe-watcher",
		async (_event, worktreePath: string) => {
			if (!worktreePath) return;

			// Cancel any in-flight subscription so it cleans up when it resolves
			pendingSubscriptions.delete(worktreePath);

			const subscription = activeSubscriptions.get(worktreePath);
			if (subscription) {
				subscription.unsubscribe();
				activeSubscriptions.delete(worktreePath);
				console.log(
					`[GitWatcher] Window ${subscription.windowId} unsubscribed from: ${worktreePath}`,
				);
			}
		},
	);
}

/**
 * Cleanup subscriptions for a specific window.
 * Call this when a window is closed to prevent memory leaks.
 */
export function cleanupWindowSubscriptions(windowId: number): void {
	for (const [path, subscription] of activeSubscriptions) {
		if (subscription.windowId === windowId) {
			subscription.unsubscribe();
			activeSubscriptions.delete(path);
			console.log(`[GitWatcher] Cleaned up subscription for closed window ${windowId}: ${path}`);
		}
	}
}

/**
 * Cleanup all watchers.
 * Call this when the app is shutting down.
 */
export async function cleanupGitWatchers(): Promise<void> {
	// Unsubscribe all
	const subscriptions = Array.from(activeSubscriptions.values());
	for (const subscription of subscriptions) {
		subscription.unsubscribe();
	}
	activeSubscriptions.clear();

	// Dispose all watchers
	await gitWatcherRegistry.disposeAll();
	console.log("[GitWatcher] All watchers cleaned up");
}
