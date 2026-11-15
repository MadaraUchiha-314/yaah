# Learning 001: A value fixed when the listener starts goes stale as plugins come up

- **Date:** 2026-11-15
- **Source:** system-feedback
- **Work item:** #3

## What happened

The agent card was built once, when the HTTP plugin started. cordis starts plugins concurrently, so an extension or a command a plugin registered a moment later (A2UI, `/model`) was missing from the card. It never failed locally; it failed on a slower CI runner (Node 24), which is how it was found.

## Learning

Anything a plugin can add to — the card, the command list, the tool set — is read when it is used, never captured when another plugin starts. In a cordis composition, start-up order is not a contract.

## Action

The card is now built when it is served (`AdmittingRequestHandler.getAgentCard`), with a scenario that adds an extension after start. Apply the same rule to any new registry-backed view.
