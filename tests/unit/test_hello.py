"""Unit tests for :func:`yaah.hello_world` — requirement R3 of issue #3."""

import pytest

from yaah import hello_world


def test_greets_the_world_by_default() -> None:
    # R3.2 — WHEN hello_world() is called with no argument THEN it returns
    # "Hello, World!"
    assert hello_world() == "Hello, World!"


def test_greets_the_name_it_is_given() -> None:
    # R3.3 — WHEN hello_world(name) is called with a non-empty string THEN it returns
    # "Hello, <name>!"
    assert hello_world("yaah") == "Hello, yaah!"


def test_keeps_the_name_verbatim() -> None:
    # The name is interpolated, never normalised: a greeting that silently retitles the
    # caller is a bug that only shows up in someone else's output.
    assert hello_world("Ada Lovelace") == "Hello, Ada Lovelace!"


@pytest.mark.parametrize("name", ["", "   ", "\t\n"])
def test_rejects_a_blank_name(name: str) -> None:
    # R3.4 / abuse case A7 — a blank name is rejected rather than greeted as "Hello, !".
    with pytest.raises(ValueError):
        hello_world(name)


@pytest.mark.parametrize("name", [None, 42, ["yaah"]])
def test_rejects_a_name_that_is_not_a_string(name: object) -> None:
    # R3.4 / abuse case A7 — a non-str argument raises rather than being coerced through
    # str(), which would turn a caller's bug into a plausible-looking greeting.
    with pytest.raises(TypeError):
        hello_world(name)  # pyright: ignore[reportArgumentType]
