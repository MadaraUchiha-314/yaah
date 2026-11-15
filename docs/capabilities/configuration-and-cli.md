# Capability: Configuration, the `yaah` command and the SDK

> One file configures a harness; the command and the library are the same code.

## What it is

`yaah` is a command and a package. The command loads a TOML file and calls the package's own `createHarness`; an application does the same in code. A build is a YAML composition of plugins.

## Current behaviour

- WHEN `yaah` is run with no arguments THEN the system SHALL start a harness on `127.0.0.1` at the configured port, or the next free one, and open the terminal chat against it over HTTP.
- WHEN `yaah serve` is run THEN the system SHALL run the `server` composition, serving the A2A API and the web chat, until interrupted. `yaah tui --url <harness>` opens the terminal chat against a running harness.
- WHEN `~/.yaah/config.toml` does not exist THEN the system SHALL create it with every default, commented, mode `0600`, and no secret. `--config <path>` uses that file instead and never creates it.
- IF the file is unreadable, is not TOML, has an unknown key or an invalid value THEN the system SHALL exit non-zero naming the file, the key and the reason. A usage error exits 2.
- The system SHALL read credentials only from environment variables the configuration names.
- The composition named by `composition` (`cli`, `server`, or a path) decides which plugins run; an `[[overrides]]` entry disables, reconfigures or replaces one by id. IF a plugin of the composition fails to load, or an override names an entry the composition does not have, THEN start-up SHALL fail naming the entry. A harness that fails after start-up stops every plugin it started.
- The package SHALL export everything the command uses; each source directory is a subpath. The export list is `specs/api/exports.json` and the configuration schema `specs/config/config.schema.json`, both held by contract tests.
- The built package SHALL run on Node and on Bun.

## Design

- [README](../../README.md)
- [design.md — Composition; CLI and SDK; Configuration](../specs/issue-3/design.md#composition)

## History

| Work item | What changed | Links                                                                                                                             |
| --------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| issue-3   | Introduced.  | [spec](../specs/issue-3/), [decision-006](../decisions/decision-006.md), [decision-007](../decisions/decision-007.md), PR #7, #12 |
