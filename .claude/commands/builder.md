---
description: Run the 2Code builder agent - audits build process, database migrations, packaging, and build scripts for accuracy
---

Run the @[skill:builder] skill now. Launch all 4 builder agents in parallel, wait for all results, then produce the unified build health report with concrete fixes prioritized by impact.

Focus on the 2Code Electron desktop app codebase in the current working directory. Analyze real code, not hypotheticals. Every finding must include a file path, line number, and ready-to-apply fix. Pay special attention to:

1. **Build correctness** — will `bun run build` succeed with the current state of the code?
2. **Database integrity** — do migrations match the schema? Are there missing migrations for recent changes?
3. **Packaging accuracy** — will `bun run package:mac` produce a working app with all resources?
4. **Script reliability** — are all build/release scripts in sync with the current project structure?
