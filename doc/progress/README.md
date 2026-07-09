# Task progress

This directory is for short-lived checkpoint files during active non-trivial tasks.

Rules:
- create one file per task, named `doc/progress/<task>.md`;
- keep it short: goal, checkpoints, decisions, blockers, and verification;
- update it when checkpoints are completed or before switching context;
- delete it when the task is finished;
- keep durable history elsewhere: `doc/changes/<version>.md` for publishable changes,
  `ROADMAP` / `RECOMMENDATIONS` / `doc/target` for long-lived project direction,
  and the commit message or final response for the immediate summary.

Progress files are working notes, not API docs or release notes.