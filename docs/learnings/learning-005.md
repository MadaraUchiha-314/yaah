# Learning 005: the-loop critic rounds over two minutes need THE_LOOP_SERVICE_LOCAL=1

- **Date:** 2026-11-15
- **Source:** system-feedback
- **Work item:** #3

## What happened

Three critic rounds (Codex) ended after exactly 120 s with only "timed out", whatever `--timeout` said. Routed through the-loop's background service, `the-loop critic run` waits at most 120 s for the HTTP reply; the runner's own limit never applies. Run in-process it completed in 3½ minutes.

## Learning

For a critic round longer than two minutes, run `THE_LOOP_SERVICE_LOCAL=1 the-loop critic run …`, detached from the agent's shell tool (which has its own limit), and scope the prompt: a 69,000-line diff does not fit one round.

## Action

Recorded in `evidence/critic-review.md`. Worth fixing upstream in the-loop: the client timeout should follow the round's timeout.
