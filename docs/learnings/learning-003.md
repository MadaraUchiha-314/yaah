# Learning 003: Flaky tests here were real timing assumptions, worth fixing by cause

- **Date:** 2026-11-15
- **Source:** system-feedback
- **Work item:** #3

## What happened

Five tests were intermittent under load: an axe contrast check caught a button mid-fade, a pty test pressed a key mid-turn, a terminal test read the screen after a fixed 20 ms pause, durable contract tests ran under a 5 s limit while waiting up to 20 s, and an attach test asserted before a follow-up read. Two of them pointed at product issues (reduced motion not honoured; the agent card race of learning-001).

## Learning

In this codebase an intermittent test is a claim about timing. Find which wait is missing or which state is not awaited; never retry or raise a global timeout.

## Action

Tests wait for the state they assert (`shows`, `screen(page, …expected)`), contract tests take a timeout matching their own waits, and the web chat honours reduced motion everywhere.
