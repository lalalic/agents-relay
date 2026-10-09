# Scenario catalog

Run `001-happy-path` first. Only after it passes should recovery/failure scenarios be exercised. Shared-runtime fault injection scenarios run last.

Recommended order: `001`, `002`, `003`, `005`, `007`, `008`, `009`, `010`, `011`, then `004`, `006`.

Every scenario has the same round rule: one fresh Job per attempt. Never mutate a failed round into a passing round.
