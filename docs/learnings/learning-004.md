# Learning 004: Stale exported keys in the shell override the keyring

- **Date:** 2026-11-15
- **Source:** system-feedback
- **Work item:** #3

## What happened

The live suite, the demo and crash recovery on Temporal Cloud failed with expired or unauthorised keys although the keyring held working ones: the shell exported old `OPENAI_API_KEY` and `TEMPORAL_API_KEY`, and `test/live/keys.ts` prefers the environment.

## Learning

When a live run fails on credentials, check whether the environment shadows the keyring before suspecting the key or the code.

## Action

Run live, demo and chaos suites with `env -u OPENAI_API_KEY -u TEMPORAL_API_KEY …` on this machine until the shell profile is cleaned up.
