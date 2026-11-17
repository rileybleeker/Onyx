"""Synthetic checks for uber_rides_import (written 2026-11-17; not run before merge, per policy)."""
import uber_rides_import as u

CSV = (
    "City,Product Type,Trip or Order Status,Request Time,Begin Trip Time,Begin Trip Address,"
    "Dropoff Time,Dropoff Address,Distance (miles),Fare Amount,Fare Currency\n"
    "Testville,UberX,COMPLETED,2024-01-05 18:22:10 +0000 UTC,2024-01-05 18:28:00 +0000 UTC,1 Secret St,"
    "2024-01-05 18:50:00 +0000 UTC,2 Hidden Ave,5.4,\"$1,012.50\",USD\n"
    "Testville,UberX,RIDER_CANCELED,2024-01-06 09:00:00 +0000 UTC,,,,,0,0,USD\n"
    "Testville,UberX,COMPLETED,not a time,,,,,1,2,USD\n"
)


def test_parse_and_privacy():
    rows, skipped = u.rows_from_csv(CSV)
    assert len(rows) == 2 and skipped == 1
    ride = next(r for r in rows if r["status"] == "completed")
    assert ride["fare_amount"] == 1012.5 and ride["distance_miles"] == 5.4
    assert "Secret" not in repr(rows) and "Hidden" not in repr(rows)
    assert next(r for r in rows if r["status"] == "canceled")["started_at"] is None


def test_idempotent_key():
    a, _ = u.rows_from_csv(CSV)
    b, _ = u.rows_from_csv(CSV)
    assert [r["ride_key"] for r in a] == [r["ride_key"] for r in b]
