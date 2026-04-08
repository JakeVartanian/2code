## ADDED Requirements

### Requirement: GitHub Workflow Panel
The system SHALL display a collapsible GitHub workflow panel at the top of each chat view that shows the current git state and guides the user through the commit → push → PR → merge workflow.

#### Scenario: Worktree mode shows 5-stage stepper
- **WHEN** a chat has a worktree (`worktreePath` is non-null)
- **THEN** the panel shows a 5-node stepper (Local Changes, Commit, Push, PR Open, Merged) with the current stage highlighted

#### Scenario: Direct mode shows simple commit/push panel
- **WHEN** a chat has no worktree (`worktreePath` is null, `branch` is null)
- **THEN** the panel shows a simplified view with the current branch name, changed files, and commit + push actions

#### Scenario: Panel hidden for non-git chats
- **WHEN** a chat has no `worktreePath` and no detectable local project path
- **THEN** the panel renders nothing and no errors occur

### Requirement: Real-Time State Updates
The panel SHALL reflect git state changes within 2 seconds of any git operation completing (commit, push, PR creation).

#### Scenario: Claude bash tool commits
- **WHEN** Claude runs a bash tool that executes `git commit`
- **THEN** the panel advances from LOCAL_CHANGES to COMMITTED stage within 2 seconds

#### Scenario: External git operation
- **WHEN** the user runs a git command in the terminal outside the app
- **THEN** the panel reflects the new state within 2 seconds

### Requirement: Pre-Flight Action Previews
The action area SHALL always display the exact details of what will happen before the user clicks any action button.

#### Scenario: Commit preview
- **WHEN** the stage is LOCAL_CHANGES
- **THEN** the action area shows each file (M/A/D status + path) that will be committed

#### Scenario: Push preview
- **WHEN** the stage is COMMITTED
- **THEN** the action area shows each unpushed commit (short SHA + message) and the exact remote branch it will push to

#### Scenario: Merge confirmation
- **WHEN** the user clicks Merge
- **THEN** a dialog appears requiring the user to type the source branch name before the merge button is enabled

### Requirement: Sequential Stage Enforcement
Action buttons SHALL be disabled (not hidden) when their prerequisite stage is not complete.

#### Scenario: Push disabled before commit
- **WHEN** no commits exist ahead of the remote
- **THEN** the Push button is rendered but disabled with a tooltip explaining the prerequisite

#### Scenario: PR disabled before push
- **WHEN** the branch has not been pushed to origin
- **THEN** the Open PR button is disabled

#### Scenario: Merge disabled before checks pass
- **WHEN** CI checks are pending or failing
- **THEN** the Merge button is disabled with a label showing the blocking reason

### Requirement: Branch Divergence Warning
The panel SHALL display a warning when the base branch has commits not present in the current branch.

#### Scenario: Base branch ahead
- **WHEN** `behindCount > 0` (base branch has new commits)
- **THEN** a yellow banner appears above the stepper with the count of new commits and a "Rebase" action

### Requirement: Mode Badge Visibility
The panel header SHALL always display a badge indicating whether the chat is in worktree (isolated) or direct mode.

#### Scenario: Worktree mode badge
- **WHEN** `worktreePath` is non-null
- **THEN** the header shows `⎇ branch-name → base-branch [isolated]`

#### Scenario: Direct mode badge
- **WHEN** `worktreePath` is null
- **THEN** the header shows `⎇ branch-name [direct]`
