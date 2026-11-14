# Capability: Models

> Which models the agent can think with, and how one is chosen.

## What it is

A model is an `llm` entity. Provider plugins register them from configuration; a conversation picks one with `/model`. **System One** is a second, small kind of model for fast classification.

## Current behaviour

- The system SHALL register one `llm` entity per configured model of OpenAI (Responses API), Anthropic (Messages API) and every `[[providers.compatible]]` endpoint (Chat Completions), with ids `<provider>/<model>`.
- IF the environment variable a provider's `api_key_env` names is not set THEN that provider SHALL register nothing, and IF `model.llm` names one of its models THEN start-up SHALL fail naming the variable and the key. An endpoint with no `api_key_env` is called without a credential.
- WHEN `/model <id>` or `/effort <level>` is sent THEN the system SHALL use that model or reasoning effort for the rest of the conversation's context, and SHALL reject an id or a level that is not offered, listing what is.
- WHEN a model call fails with a rate limit, a timeout or a server error THEN the system SHALL treat it as retryable; a bad request or an authentication failure is final.
- The system SHALL provide a `system-one` entity kind — `decide(input, questions)` returning one answer per question (predicate, choice, score, or refusal) — with an OpenAI implementation on the Decisions API (`gpt-6-luna`).
- WHEN `inbox.triage = "system-one"` and an unmarked message arrives for a working task THEN the system SHALL ask System One whether it should interrupt, and on any failure or after 2 s SHALL NOT interrupt. Triage is off by default.
- Every provider key SHALL be registered with the redactor.

## Design

- [design.md — Models](../specs/issue-3/design.md#models)
- Contract suites: `llmContract`, `systemOneContract` in `src/testing/`
- Not yet verified against the live OpenAI API: see the work item's verification results.

## History

| Work item | What changed | Links                                  |
| --------- | ------------ | -------------------------------------- |
| issue-3   | Introduced.  | [spec](../specs/issue-3/), PR #10, #13 |
