import os

# Pin the clock before analyst.server builds its store, so period answers
# don't drift with the real date.
os.environ.setdefault("DEMO_TODAY", "2026-10-08")
