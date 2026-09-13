# yaah

**Yet Another Agent Harness** — a Python package that develops itself through
[the-loop](https://github.com/MadaraUchiha-314/the-loop).

📖 **[Documentation](https://madarauchiha-314.github.io/yaah/)** · the tech stack, local
development, architecture, decisions and every checked-in spec.

## Install

```bash
pip install yaah
```

```python
from yaah import hello_world

hello_world()  # 'Hello, World!'
```

That is the whole public surface today. What exists in full is the machinery around it —
see [What is yaah?](https://madarauchiha-314.github.io/yaah/guide/what-is-yaah).

## Develop

```bash
uv sync      # create .venv/ and install from uv.lock
make hooks   # install the git hooks — once per clone
make check   # lint, format, types, unit + integration tests
```

If `make check` is green, CI will be too: the checks are defined once in
`.pre-commit-config.yaml`, and your hooks, `make` and CI all run that one definition. Full
instructions — prerequisites, the everyday commands, commit-message rules —
are in
[Local development](https://madarauchiha-314.github.io/yaah/guide/local-development).

## Contributing

Every change is a work item with a ticket and a checked-in spec chain under `docs/specs/`.
Read [`AGENTS.md`](AGENTS.md) for the operating model and
[Contributing](https://madarauchiha-314.github.io/yaah/guide/contributing) for the short
version.

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
