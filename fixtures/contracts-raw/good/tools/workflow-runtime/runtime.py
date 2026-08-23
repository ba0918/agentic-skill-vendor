"""The runtime every workflow skill drives its steps through."""

from lib.helpers import step


def run(plan):
    for name in plan:
        step(name)
