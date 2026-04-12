export {
	GitWatcher,
	gitWatcherRegistry,
	type FileChange,
	type FileChangeType,
	type GitWatchEvent,
} from "./git-watcher";

export {
	registerGitWatcherIPC,
	cleanupGitWatchers,
	cleanupWindowSubscriptions,
} from "./ipc-bridge";
