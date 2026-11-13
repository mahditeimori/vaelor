"""First-run seeding for the strategy registry."""

from __future__ import annotations

from .store import Store
from .strategies import seed_strategies


def seed(store: Store) -> int:
    created = 0
    existing = {row["id"] for row in store.list_strategies()}
    for manifest in seed_strategies():
        if manifest.id in existing:
            continue
        store.upsert_strategy(manifest.model_dump(), source="seed")
        created += 1
    if created:
        store.audit("strategies.seeded", {"count": created})
    return created
