"""The one thing yaah does today: greet.

`hello_world` exists so that the toolchain issue #3 wires up carries real code from the
first commit — something for the tests to test, the type checker to check, and the wheel
to contain.
"""

__all__ = ["hello_world"]


def hello_world(name: str = "World") -> str:
    """Return a greeting addressed to ``name``.

    Args:
        name: Who to greet. Defaults to ``"World"``.

    Returns:
        The greeting, as ``"Hello, {name}!"``.

    Raises:
        TypeError: If ``name`` is not a :class:`str`. The value is deliberately not
            coerced with ``str()`` — a greeting addressed to ``None`` reads as valid
            output and hides the caller's bug.
        ValueError: If ``name`` is empty or only whitespace.

    Examples:
        >>> hello_world()
        'Hello, World!'
        >>> hello_world("yaah")
        'Hello, yaah!'
    """
    # The annotation says `str`, so a type checker calls this redundant — and it is,
    # for callers it checks. R3.4 is about the ones it does not: untyped call sites,
    # deserialised config, a REPL. The suppression is narrow on purpose; strict mode
    # stays on everywhere else.
    if not isinstance(name, str):  # pyright: ignore[reportUnnecessaryIsInstance]
        raise TypeError(f"name must be a str, got {type(name).__name__}")
    if not name.strip():
        raise ValueError("name must not be empty or only whitespace")
    return f"Hello, {name}!"
