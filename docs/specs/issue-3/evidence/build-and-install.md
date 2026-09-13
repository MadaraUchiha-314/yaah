# Evidence — T4 · the distribution builds, installs and imports

Requirements R1.3 and R7.5 — the artifact the release workflow would publish. Run on
2026-09-13. This stops short of uploading: nothing is published during verification.

**Outcome: `yaah-0.1.0` builds as both an sdist and a wheel; the wheel installs into a
clean interpreter and imports.** The import assertion checks `yaah.__file__` points into
the clean environment's `site-packages` rather than the working tree — otherwise the test
would pass by importing the source it was meant to prove shippable.

## `uv build`

```text
Building source distribution...
Building wheel from source distribution...
Successfully built dist/yaah-0.1.0.tar.gz
Successfully built dist/yaah-0.1.0-py3-none-any.whl
```

## `uv venv --python 3.13 <scratch>/cleanenv && uv pip install dist/yaah-0.1.0-py3-none-any.whl && python -c 'import yaah; ...'`

```text
Using CPython 3.13.12 interpreter at: /usr/bin/python3.13
Creating virtual environment at: <scratch>/cleanenv
Activate with: source <scratch>/cleanenv/bin/activate
Using Python 3.13.12 environment at: <scratch>/cleanenv
Resolved 1 package in 2ms
Installed 1 package in 1ms
 + yaah==0.1.0 (from file://dist/yaah-0.1.0-py3-none-any.whl)
imported from: <scratch>/cleanenv/lib/python3.13/site-packages/yaah/__init__.py
Hello, clean venv!
py.typed shipped: True
```
