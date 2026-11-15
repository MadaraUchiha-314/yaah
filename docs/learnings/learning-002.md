# Learning 002: A fix can reopen the defect next to it; review the fixes themselves

- **Date:** 2026-11-15
- **Source:** system-feedback
- **Work item:** #3

## What happened

Self-review round 1 found 36 defects and fixed them all. Round 2, reading those fixes against their own scenarios, found that one fix had caused a high-severity regression (stopping forwarding on client disconnect broke resubscription) and that three others had closed only the reported case (stream logs for resting tasks, a repeated `<a2ui>` tag, file-part redaction).

## Learning

A second review round is most valuable when it is pointed at the previous round's fixes and asked two questions: does this close the defect for its whole class, and what did it break nearby?

## Action

Round prompts after the first now include "review the previous round's fixes against their scenarios and for regressions" as part A. Repeat findings are escalated on the PR.
