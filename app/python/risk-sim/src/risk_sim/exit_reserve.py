"""R9: the ring-fenced exit reserve must cover every holder selling at the stressed value, down to the reserve floor."""

from __future__ import annotations

from .book import Book


def exit_run(book: Book, shock: float, coverage_largest: float = 1.0, coverage_total: float = 0.25) -> tuple[dict, bool]:
    """Stressed payout of a gear is the larger of its value after -shock and +shock (the reserve pays out what holders are owed)."""
    stressed = {}
    for g in book.gears:
        stressed[g.label] = g.governor_value_usd * max((1 - shock) ** g.power, (1 + shock) ** g.power)
    per_name: dict[str, float] = {}
    for g in book.gears:
        if g.power in (1.5, 2.0):          # Cruise and Sport
            per_name[g.key] = per_name.get(g.key, 0.0) + stressed[g.label]
    largest_name, largest = max(per_name.items(), key=lambda kv: (kv[1], kv[0]), default=("", 0.0))
    total = sum(stressed.values())
    available = max(0.0, book.exit_reserve_usd - book.exit_reserve_floor_usd)
    required = max(coverage_largest * largest, coverage_total * total)
    row = {"stressed_total_usd": round(total, 6), "largest_name": largest_name, "largest_cruise_sport_usd": round(largest, 6),
           "required_usd": round(required, 6), "reserve_usd": book.exit_reserve_usd, "floor_usd": book.exit_reserve_floor_usd,
           "largest_holder_sell_covered_usd": round(available, 6), "covers": available >= required}
    return row, available >= required
