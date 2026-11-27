---
name: coding
description: Implement, debug, or review code in a repository. Use for build/fix/refactor work.
---

# Coding skill

1. Read the files you will touch before editing. Grep for callers of any function you change.
2. Make the smallest complete change. Match the surrounding style.
3. Run the project check after editing (tests, typecheck, or a direct smoke run).
4. Never claim something works without seeing it work. Report exact commands and outcomes.
5. Leave the workspace clean: no stray debug files or backups.

When a mission spans many edits, commit progress in `JARVIS.md` or a goal note so the next autonomous run can resume.