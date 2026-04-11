import { shell } from "electron";
import simpleGit from "simple-git";
import { z } from "zod";
import { publicProcedure, router } from "../trpc";
import { isUpstreamMissingError } from "./git-utils";
import { assertRegisteredWorktree } from "./security";
import { fetchGitHubPRStatus } from "./github";
import { gitCache } from "./cache";
import {
	createGit,
	createGitForNetwork,
	withGitLock,
	withLockRetry,
	hasUncommittedChanges,
	getRepositoryState,
	GIT_TIMEOUTS,
} from "./git-factory";

export { isUpstreamMissingError };

async function hasUpstreamBranch(
	git: ReturnType<typeof simpleGit>,
): Promise<boolean> {
	try {
		await git.raw(["rev-parse", "--abbrev-ref", "@{upstream}"]);
		return true;
	} catch {
		return false;
	}
}

/** Protected branches that should not be force-pushed to */
const PROTECTED_BRANCHES = ["main", "master", "develop", "production", "staging"];

function invalidateGitStateCaches(worktreePath: string): void {
	gitCache.invalidateStatus(worktreePath);
	gitCache.invalidateParsedDiff(worktreePath);
	gitCache.invalidateAllFileContents(worktreePath);
}

export const createGitOperationsRouter = () => {
	return router({
		// NOTE: saveFile is defined in file-contents.ts with hardened path validation
		// Do NOT add saveFile here - it would overwrite the secure version

		fetch: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
				}),
			)
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				assertRegisteredWorktree(input.worktreePath);

				return withGitLock(input.worktreePath, async () => {
					const git = createGitForNetwork(input.worktreePath);
					await withLockRetry(input.worktreePath, () =>
						git.fetch(["--all", "--prune"])
					);
					invalidateGitStateCaches(input.worktreePath);
					return { success: true };
				});
			}),

		checkout: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					branch: z.string(),
				}),
			)
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				assertRegisteredWorktree(input.worktreePath);

				return withGitLock(input.worktreePath, async () => {
					// Check for uncommitted changes before checkout
					if (await hasUncommittedChanges(input.worktreePath)) {
						throw new Error(
							"Cannot switch branches: you have uncommitted changes. Please commit or stash your changes first."
						);
					}

					const git = createGit(input.worktreePath);
					await withLockRetry(input.worktreePath, () =>
						git.checkout(input.branch)
					);
					invalidateGitStateCaches(input.worktreePath);
					return { success: true };
				});
			}),

		getHistory: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					limit: z.number().optional().default(50),
				}),
			)
			.query(
				async ({
					input,
				}): Promise<
					Array<{
						hash: string;
						shortHash: string;
						message: string;
						author: string;
						email: string;
						date: Date;
						tags: string[];
					}>
				> => {
					assertRegisteredWorktree(input.worktreePath);

					const git = createGit(input.worktreePath);
					const logOutput = await git.raw([
						"log",
						`-${input.limit}`,
						"--format=%H%x1e%h%x1e%s%x1e%an%x1e%ae%x1e%aI%x1e%D",
					]);

					if (!logOutput.trim()) return [];

					return logOutput
						.trim()
						.split("\n")
						.map((line) => {
							const [hash, shortHash, message, author, email, dateStr, refs] =
								line.split("\x1e");
							// Extract tags from ref names (format: "HEAD -> main, tag: v1.0.0, origin/main")
							const tags = (refs || "")
								.split(",")
								.map((r) => r.trim())
								.filter((r) => r.startsWith("tag: "))
								.map((r) => r.replace("tag: ", ""));
							return {
								hash: hash || "",
								shortHash: shortHash || "",
								message: message || "",
								author: author || "",
								email: email || "",
								date: new Date(dateStr || ""),
								tags,
							};
						});
				},
			),

		commit: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					message: z.string(),
				}),
			)
			.mutation(
				async ({ input }): Promise<{ success: boolean; hash: string }> => {
					assertRegisteredWorktree(input.worktreePath);

					// Validate message
					if (!input.message.trim()) {
						throw new Error("Commit message cannot be empty");
					}

					return withGitLock(input.worktreePath, async () => {
						const git = createGit(input.worktreePath);

						// Check that there are staged changes
						const status = await git.status();
						if (status.staged.length === 0) {
							throw new Error("No files staged for commit");
						}

						const result = await withLockRetry(input.worktreePath, () =>
							git.commit(input.message)
						);
						invalidateGitStateCaches(input.worktreePath);
						return { success: true, hash: result.commit };
					});
				},
			),

		// Atomic commit: stage specific files and commit in one operation
		atomicCommit: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					filePaths: z.array(z.string()),
					message: z.string(),
				}),
			)
			.mutation(
				async ({ input }): Promise<{ success: boolean; hash: string }> => {
					assertRegisteredWorktree(input.worktreePath);

					// Validate message
					if (!input.message.trim()) {
						throw new Error("Commit message cannot be empty");
					}

					// Validate files
					if (input.filePaths.length === 0) {
						throw new Error("No files selected for commit");
					}

					return withGitLock(input.worktreePath, async () => {
						const git = createGit(input.worktreePath);

						// First, unstage everything to start fresh
						await withLockRetry(input.worktreePath, () =>
							git.reset(["HEAD"])
						);

						// Stage only the selected files
						await withLockRetry(input.worktreePath, () =>
							git.add(["--", ...input.filePaths])
						);

						// Verify files were staged
						const status = await git.status();
						if (status.staged.length === 0) {
							throw new Error("Failed to stage files for commit");
						}

						// Commit
						const result = await withLockRetry(input.worktreePath, () =>
							git.commit(input.message)
						);

						invalidateGitStateCaches(input.worktreePath);
						return { success: true, hash: result.commit };
					});
				},
			),

		push: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					setUpstream: z.boolean().optional(),
				}),
			)
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				assertRegisteredWorktree(input.worktreePath);

				return withGitLock(input.worktreePath, async () => {
					const git = createGitForNetwork(input.worktreePath);
					const hasUpstream = await hasUpstreamBranch(git);

					if (input.setUpstream && !hasUpstream) {
						const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
						await withLockRetry(input.worktreePath, () =>
							git.push(["--set-upstream", "origin", branch.trim()])
						);
					} else {
						await withLockRetry(input.worktreePath, () => git.push());
					}
					await git.fetch();
					invalidateGitStateCaches(input.worktreePath);
					return { success: true };
				});
			}),

		pull: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					autoStash: z.boolean().optional().default(false),
				}),
			)
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				assertRegisteredWorktree(input.worktreePath);

				return withGitLock(input.worktreePath, async () => {
					const git = createGitForNetwork(input.worktreePath);

					// Safety check: prevent pull with uncommitted changes (data loss risk)
					const hasChanges = await hasUncommittedChanges(input.worktreePath);
					if (hasChanges && !input.autoStash) {
						throw new Error(
							"Cannot pull with uncommitted changes. Please commit or stash your changes first, or enable auto-stash."
						);
					}

					// Check for ongoing rebase/merge
					const repoState = await getRepositoryState(input.worktreePath);
					if (repoState.isRebasing || repoState.isMerging) {
						throw new Error(
							"Cannot pull: a rebase or merge is in progress. Please complete or abort it first."
						);
					}

					try {
						if (input.autoStash && hasChanges) {
							// Stash changes before pull
							await git.stash(["push", "-m", "Auto-stash before pull"]);
						}

						await withLockRetry(input.worktreePath, () =>
							git.pull(["--rebase"])
						);

						if (input.autoStash && hasChanges) {
							// Pop stashed changes
							try {
								await git.stash(["pop"]);
							} catch (stashError) {
								// Stash pop failed (likely conflict)
								throw new Error(
									"Pull succeeded but failed to restore your stashed changes. Your changes are saved in git stash. Run 'git stash pop' to restore them."
								);
							}
						}
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						if (isUpstreamMissingError(message)) {
							throw new Error(
								"No upstream branch to pull from. The remote branch may have been deleted.",
							);
						}
						// Check for rebase conflicts
						if (message.includes("CONFLICT") || message.includes("could not apply")) {
							// Abort the rebase
							await git.rebase(["--abort"]).catch(() => {});
							throw new Error(
								"Pull failed due to conflicts. The operation has been aborted. Please resolve conflicts manually or try a different approach."
							);
						}
						throw error;
					}
					invalidateGitStateCaches(input.worktreePath);
					return { success: true };
				});
			}),

		sync: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					autoStash: z.boolean().optional().default(false),
				}),
			)
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				assertRegisteredWorktree(input.worktreePath);

				return withGitLock(input.worktreePath, async () => {
					const git = createGitForNetwork(input.worktreePath);

					// Safety check: prevent sync with uncommitted changes
					const hasChanges = await hasUncommittedChanges(input.worktreePath);
					if (hasChanges && !input.autoStash) {
						throw new Error(
							"Cannot sync with uncommitted changes. Please commit or stash your changes first."
						);
					}

					// Check for ongoing rebase/merge
					const repoState = await getRepositoryState(input.worktreePath);
					if (repoState.isRebasing || repoState.isMerging) {
						throw new Error(
							"Cannot sync: a rebase or merge is in progress. Please complete or abort it first."
						);
					}

					try {
						if (input.autoStash && hasChanges) {
							await git.stash(["push", "-m", "Auto-stash before sync"]);
						}

						await withLockRetry(input.worktreePath, () =>
							git.pull(["--rebase"])
						);

						if (input.autoStash && hasChanges) {
							try {
								await git.stash(["pop"]);
							} catch {
								throw new Error(
									"Sync pull succeeded but failed to restore your stashed changes. Your changes are saved in git stash."
								);
							}
						}
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						if (isUpstreamMissingError(message)) {
							const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
							await withLockRetry(input.worktreePath, () =>
								git.push(["--set-upstream", "origin", branch.trim()])
							);
							await git.fetch();
							invalidateGitStateCaches(input.worktreePath);
							return { success: true };
						}
						// Check for rebase conflicts
						if (message.includes("CONFLICT") || message.includes("could not apply")) {
							await git.rebase(["--abort"]).catch(() => {});
							throw new Error(
								"Sync failed due to conflicts. The operation has been aborted. Please resolve conflicts manually."
							);
						}
						throw error;
					}
					await withLockRetry(input.worktreePath, () => git.push());
					await git.fetch();
					invalidateGitStateCaches(input.worktreePath);
					return { success: true };
				});
			}),

		forcePush: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					confirmProtectedBranch: z.boolean().optional().default(false),
				}),
			)
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				assertRegisteredWorktree(input.worktreePath);

				return withGitLock(input.worktreePath, async () => {
					const git = createGitForNetwork(input.worktreePath);

					// Get current branch
					const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();

					// Check if it's a protected branch
					if (PROTECTED_BRANCHES.includes(branch) && !input.confirmProtectedBranch) {
						throw new Error(
							`Cannot force push to protected branch '${branch}'. This action requires explicit confirmation.`
						);
					}

					await withLockRetry(input.worktreePath, () =>
						git.push(["--force-with-lease"])
					);
					await git.fetch();
					invalidateGitStateCaches(input.worktreePath);
					return { success: true };
				});
			}),

		mergeFromDefault: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					useRebase: z.boolean().optional().default(false),
				}),
			)
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				assertRegisteredWorktree(input.worktreePath);

				return withGitLock(input.worktreePath, async () => {
					const git = createGitForNetwork(input.worktreePath);

					// Safety check: prevent merge/rebase with uncommitted changes
					if (await hasUncommittedChanges(input.worktreePath)) {
						throw new Error(
							"Cannot merge/rebase with uncommitted changes. Please commit or stash your changes first."
						);
					}

					// Check for ongoing rebase/merge
					const repoState = await getRepositoryState(input.worktreePath);
					if (repoState.isRebasing || repoState.isMerging) {
						throw new Error(
							"Cannot merge/rebase: another merge or rebase is in progress. Please complete or abort it first."
						);
					}

					// Fetch latest from remote first
					await withLockRetry(input.worktreePath, () =>
						git.fetch(["--all"])
					);

					// Determine default branch (main or master)
					let defaultBranch = "main";
					try {
						await git.raw(["rev-parse", "--verify", "origin/main"]);
					} catch {
						try {
							await git.raw(["rev-parse", "--verify", "origin/master"]);
							defaultBranch = "master";
						} catch {
							throw new Error("Could not find default branch (main or master)");
						}
					}

					try {
						if (input.useRebase) {
							await withLockRetry(input.worktreePath, () =>
								git.rebase([`origin/${defaultBranch}`])
							);
						} else {
							await withLockRetry(input.worktreePath, () =>
								git.merge([`origin/${defaultBranch}`, "--no-edit"])
							);
						}
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);

						// Check for conflicts
						if (
							message.includes("CONFLICT") ||
							message.includes("could not apply") ||
							message.includes("merge failed")
						) {
							// Abort the operation
							if (input.useRebase) {
								await git.rebase(["--abort"]).catch(() => {});
							} else {
								await git.merge(["--abort"]).catch(() => {});
							}
							throw new Error(
								`${input.useRebase ? "Rebase" : "Merge"} failed due to conflicts. The operation has been aborted. Please resolve conflicts manually or use a different strategy.`
							);
						}
						throw error;
					}

					invalidateGitStateCaches(input.worktreePath);
					return { success: true };
				});
			}),

		// Abort an ongoing rebase
		abortRebase: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
				}),
			)
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				assertRegisteredWorktree(input.worktreePath);

				return withGitLock(input.worktreePath, async () => {
					const git = createGit(input.worktreePath);
					await git.rebase(["--abort"]);
					invalidateGitStateCaches(input.worktreePath);
					return { success: true };
				});
			}),

		// Abort an ongoing merge
		abortMerge: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
				}),
			)
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				assertRegisteredWorktree(input.worktreePath);

				return withGitLock(input.worktreePath, async () => {
					const git = createGit(input.worktreePath);
					await git.merge(["--abort"]);
					invalidateGitStateCaches(input.worktreePath);
					return { success: true };
				});
			}),

		// Get repository state (rebase/merge in progress, conflicts)
		getRepositoryState: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
				}),
			)
			.query(async ({ input }) => {
				assertRegisteredWorktree(input.worktreePath);
				return getRepositoryState(input.worktreePath);
			}),

		createPR: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
				}),
			)
			.mutation(
				async ({ input }): Promise<{ success: boolean; url: string }> => {
					assertRegisteredWorktree(input.worktreePath);

					return withGitLock(input.worktreePath, async () => {
						const git = createGitForNetwork(input.worktreePath);
						const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
						const hasUpstream = await hasUpstreamBranch(git);

						// Ensure branch is pushed first
						if (!hasUpstream) {
							await withLockRetry(input.worktreePath, () =>
								git.push(["--set-upstream", "origin", branch])
							);
						} else {
							// Push any unpushed commits
							await withLockRetry(input.worktreePath, () => git.push());
						}

						// Get the remote URL to construct the GitHub compare URL
						const remoteUrl = (await git.remote(["get-url", "origin"])) || "";
						const repoMatch = remoteUrl
							.trim()
							.match(/github\.com[:/](.+?)(?:\.git)?$/);

						if (!repoMatch) {
							throw new Error("Could not determine GitHub repository URL");
						}

						const repo = repoMatch[1].replace(/\.git$/, "");
						const url = `https://github.com/${repo}/compare/${branch}?expand=1`;

						await shell.openExternal(url);
						await git.fetch();
						invalidateGitStateCaches(input.worktreePath);

						return { success: true, url };
					});
				},
			),

		getGitHubStatus: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
				}),
			)
			.query(async ({ input }) => {
				assertRegisteredWorktree(input.worktreePath);
				return await fetchGitHubPRStatus(input.worktreePath);
			}),

		// Aggregate workflow state: uncommitted files, unpushed commits, ahead/behind counts.
		// Fast local-only query (no network). Used by GitWorkflowPanel.
		getWorkflowState: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					baseBranch: z.string().optional(),
				}),
			)
			.query(async ({ input }) => {
				assertRegisteredWorktree(input.worktreePath);

				const git = createGit(input.worktreePath);

				// Run all local queries in parallel for speed
				const [status, repoState] = await Promise.all([
					git.status(),
					getRepositoryState(input.worktreePath),
				]);

				// Uncommitted files with their status character
				const uncommittedFiles = [
					...status.modified.map((f) => ({ path: f, status: "M" as const })),
					...status.not_added.map((f) => ({ path: f, status: "?" as const })),
					...status.created.map((f) => ({ path: f, status: "A" as const })),
					...status.deleted.map((f) => ({ path: f, status: "D" as const })),
					...status.renamed.map((f) => ({ path: f.to, status: "R" as const })),
					...status.staged.filter(
						(f) =>
							!status.modified.includes(f) &&
							!status.created.includes(f) &&
							!status.deleted.includes(f),
					).map((f) => ({ path: f, status: "M" as const })),
				];

				// Unique by path
				const seen = new Set<string>();
				const uniqueUncommitted = uncommittedFiles.filter((f) => {
					if (seen.has(f.path)) return false;
					seen.add(f.path);
					return true;
				});

				// Unpushed commits (commits ahead of remote tracking branch)
				let unpushedCommits: Array<{ sha: string; shortSha: string; message: string }> = [];
				let aheadCount = 0;
				try {
					const aheadLog = await git.log({ from: "origin/HEAD", to: "HEAD" }).catch(async () => {
						// Fallback: try to get commits since upstream
						const upstream = await git.raw(["rev-parse", "--abbrev-ref", "@{upstream}"]).catch(() => null);
						if (!upstream) return { all: [] };
						return git.log({ from: upstream.trim(), to: "HEAD" });
					});
					unpushedCommits = (aheadLog.all || []).map((c) => ({
						sha: c.hash,
						shortSha: c.hash.slice(0, 7),
						message: c.message,
					}));
					aheadCount = unpushedCommits.length;
				} catch {
					// Not fatal — branch may not have a remote yet
				}

				// How many commits the base branch is ahead of this branch
				let behindCount = 0;
				if (input.baseBranch) {
					try {
						const behindRaw = await git.raw([
							"rev-list",
							"--count",
							`HEAD..origin/${input.baseBranch}`,
						]);
						behindCount = parseInt(behindRaw.trim(), 10) || 0;
					} catch {
						// Base branch may not exist on remote yet
					}
				}

				// Whether the branch has been pushed at all (has a remote tracking branch)
				let hasRemote = false;
				try {
					await git.raw(["rev-parse", "--abbrev-ref", "@{upstream}"]);
					hasRemote = true;
				} catch {
					hasRemote = false;
				}

				return {
					uncommittedFiles: uniqueUncommitted,
					hasUncommittedChanges: uniqueUncommitted.length > 0,
					unpushedCommits,
					aheadCount,
					behindCount,
					hasRemote,
					isClean: status.isClean(),
					repoState,
				};
			}),

		// Stage all changes (git add -A). Used by GitWorkflowPanel commit flow.
		stageAll: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
				}),
			)
			.mutation(async ({ input }): Promise<{ success: boolean; stagedCount: number }> => {
				assertRegisteredWorktree(input.worktreePath);

				return withGitLock(input.worktreePath, async () => {
					const git = createGit(input.worktreePath);
					await withLockRetry(input.worktreePath, () => git.add(["-A"]));

					const status = await git.status();
					invalidateGitStateCaches(input.worktreePath);
					return { success: true, stagedCount: status.staged.length };
				});
			}),
	});
};
