"""
Personal Data Scientist — Supplement Lookup (DSLD)
====================================================
Searches the NIH Dietary Supplement Label Database and seeds rows into
pds.supplement_products. DSLD is public, no auth, comprehensive — covers
vitamins, minerals, botanicals, amino acids, and nootropics.

UNII codes (FDA's universal ingredient IDs) are preserved per ingredient so
the supplement_intake_by_compound view can roll up cross-brand intake
without normalization heuristics.

Usage:
    python supplement_lookup.py search "centrum"             # list hits
    python supplement_lookup.py seed 19155                   # fetch + upsert by DSLD id
    python supplement_lookup.py seed-from-upc 300054470607   # search by UPC, prompt, seed
    python supplement_lookup.py list                         # show what's in our library
"""

import os
import sys
import json
import argparse
import logging
from typing import Any

import httpx
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

DSLD_API = "https://api.ods.od.nih.gov/dsld/v9"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("supplement_lookup")


# ---------------------------------------------------------------------------
# DSLD client
# ---------------------------------------------------------------------------

def dsld_search(query: str, size: int = 10) -> list[dict]:
    """Free-text search. Accepts product names, brand names, or UPC barcodes."""
    resp = httpx.get(
        f"{DSLD_API}/search-filter",
        params={"q": query, "size": size},
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json().get("hits", [])


def dsld_label(dsld_id: int) -> dict:
    """Fetch a full label record by DSLD numeric id."""
    resp = httpx.get(f"{DSLD_API}/label/{dsld_id}", timeout=20)
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# Label → our normalized shape
# ---------------------------------------------------------------------------

def _digits_only(s: str | None) -> str | None:
    """Normalize UPC barcodes — DSLD includes spaces/dashes ('3 0005-4470-60 7')."""
    if not s:
        return None
    out = "".join(c for c in s if c.isdigit())
    return out or None


def _flatten_ingredient(ing: dict) -> dict:
    """
    Convert one DSLD ingredient row into our compact shape.

    DSLD's quantity is a list (one entry per serving-size variant — most products
    have just one). We take the first entry's quantity/unit/percent_dv. If the
    ingredient has nested forms (e.g. "Vitamin A as Beta-Carotene"), we record
    the form names + UNIIs alongside.
    """
    qty_list = ing.get("quantity") or []
    qty_entry = qty_list[0] if qty_list else {}
    dv_list = qty_entry.get("dailyValueTargetGroup") or []
    dv_entry = dv_list[0] if dv_list else {}

    forms = []
    for f in ing.get("forms") or []:
        forms.append({
            "name": f.get("name"),
            "ingredient_group": f.get("ingredientGroup"),
            "unii_code": f.get("uniiCode"),
            "category": f.get("category"),
            "percent": f.get("percent"),
        })

    return {
        "name": ing.get("name"),
        "ingredient_group": ing.get("ingredientGroup"),
        "unii_code": ing.get("uniiCode"),
        "category": ing.get("category"),
        "quantity": qty_entry.get("quantity"),
        "unit": qty_entry.get("unit"),
        "percent_dv": dv_entry.get("percent"),
        "forms": forms,
        "notes": ing.get("notes"),
    }


def normalize_label(label: dict) -> dict:
    """Convert a DSLD label payload into a supplement_products row."""
    dsld_id = label.get("id")
    serving_sizes = label.get("servingSizes") or []
    serving = serving_sizes[0] if serving_sizes else {}
    net_contents = label.get("netContents") or []
    net = net_contents[0] if net_contents else {}

    ingredients = [_flatten_ingredient(i) for i in (label.get("ingredientRows") or [])]

    return {
        "product_id": f"dsld_{dsld_id}",
        "dsld_id": dsld_id,
        "brand_name": label.get("brandName"),
        "full_name": label.get("fullName"),
        "upc_sku": _digits_only(label.get("upcSku")),
        "serving_size": serving.get("minQuantity"),
        "serving_unit": serving.get("unit"),
        "servings_per_container": net.get("quantity") if net.get("unit") == serving.get("unit") else None,
        "product_type": (label.get("productType") or {}).get("langualCodeDescription"),
        "physical_state": (label.get("physicalState") or {}).get("langualCodeDescription"),
        "target_groups": label.get("targetGroups") or [],
        "ingredients": ingredients,
        "off_market": label.get("offMarket", False),
        "raw_json": label,
    }


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def get_supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def upsert_product(sb: Client, row: dict) -> None:
    sb.schema("pds").table("supplement_products").upsert(
        row, on_conflict="product_id"
    ).execute()


# ---------------------------------------------------------------------------
# Hit formatting (CLI display)
# ---------------------------------------------------------------------------

def fmt_hit(hit: dict) -> str:
    s = hit.get("_source", {})
    return (
        f"  dsld:{hit.get('_id'):>7}  "
        f"{(s.get('brandName') or '—'):<24}  "
        f"{(s.get('fullName') or '?'):<48}  "
        f"upc:{_digits_only(s.get('upcSku')) or '—'}"
    )


# ---------------------------------------------------------------------------
# CLI flows
# ---------------------------------------------------------------------------

def cmd_search(query: str, size: int) -> None:
    hits = dsld_search(query, size=size)
    log.info(f"{len(hits)} hits for {query!r}")
    for h in hits:
        print(fmt_hit(h))


def cmd_seed(dsld_id: int) -> None:
    sb = get_supabase()
    label = dsld_label(dsld_id)
    row = normalize_label(label)
    upsert_product(sb, row)
    log.info(
        f"Seeded {row['product_id']} — {row['brand_name']}: {row['full_name']} "
        f"({len(row['ingredients'])} ingredients)"
    )


def cmd_seed_from_upc(upc: str) -> None:
    """Search DSLD by UPC, prompt for the correct match if multiple, seed."""
    digits = _digits_only(upc) or upc
    hits = dsld_search(digits, size=5)
    if not hits:
        log.error(f"No DSLD hits for UPC {digits}")
        sys.exit(1)
    if len(hits) == 1:
        chosen = hits[0]
    else:
        print(f"{len(hits)} candidate matches:")
        for i, h in enumerate(hits):
            print(f"  [{i}] {fmt_hit(h).strip()}")
        idx = int(input("Pick one (number): "))
        chosen = hits[idx]
    cmd_seed(int(chosen["_id"]))


def cmd_list() -> None:
    sb = get_supabase()
    rows = (
        sb.schema("pds").table("supplement_products")
        .select("product_id,brand_name,full_name,upc_sku,ingredients")
        .order("brand_name")
        .execute()
        .data or []
    )
    log.info(f"Library contains {len(rows)} products")
    for r in rows:
        n_ings = len(r.get("ingredients") or [])
        print(
            f"  {r['product_id']:<14}  "
            f"{(r.get('brand_name') or '—'):<24}  "
            f"{(r.get('full_name') or '?'):<48}  "
            f"{n_ings} ingredients"
        )


def main():
    parser = argparse.ArgumentParser(description="DSLD-backed supplement lookup")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_search = sub.add_parser("search", help="Search DSLD by name/brand/UPC")
    p_search.add_argument("query")
    p_search.add_argument("--size", type=int, default=10)

    p_seed = sub.add_parser("seed", help="Fetch + upsert a product by DSLD id")
    p_seed.add_argument("dsld_id", type=int)

    p_upc = sub.add_parser("seed-from-upc", help="Search by UPC and seed the match")
    p_upc.add_argument("upc")

    sub.add_parser("list", help="Print current library contents")

    args = parser.parse_args()
    if args.cmd == "search":
        cmd_search(args.query, args.size)
    elif args.cmd == "seed":
        cmd_seed(args.dsld_id)
    elif args.cmd == "seed-from-upc":
        cmd_seed_from_upc(args.upc)
    elif args.cmd == "list":
        cmd_list()


if __name__ == "__main__":
    main()
