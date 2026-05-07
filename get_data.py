#!/usr/bin/env python3
"""
Pull RIPE Atlas anchor-to-anchor mesh ping (latest snapshot) and aggregate to country->country RTT.

Outputs (in --outdir):
  - anchors.jsonl
  - mesh_ping_measurements.jsonl
  - latest_results.jsonl.gz
  - country_country_rtt.csv
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
import sys
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urljoin

import requests

BASE = "https://atlas.ripe.net"
API = urljoin(BASE, "/api/v2/")

# ----------------------------
# HTTP helpers (throttle + retry)
# ----------------------------

@dataclass
class HttpConfig:
    timeout_s: int = 60
    max_retries: int = 8
    backoff_base_s: float = 1.5
    min_sleep_s: float = 0.15  # gentle pacing to reduce 429s
    user_agent: str = "ripe-atlas-mesh-pull/1.0 (+https://atlas.ripe.net/docs/apis/)"

def _sleep(cfg: HttpConfig):
    if cfg.min_sleep_s > 0:
        time.sleep(cfg.min_sleep_s)

def get_json(session: requests.Session, url: str, cfg: HttpConfig, params: Optional[dict] = None) -> Any:
    """
    GET JSON with exponential backoff on transient errors (429/5xx).
    """
    headers = {"User-Agent": cfg.user_agent}
    attempt = 0
    while True:
        attempt += 1
        _sleep(cfg)
        try:
            resp = session.get(url, params=params, timeout=cfg.timeout_s, headers=headers)
        except requests.RequestException as e:
            if attempt >= cfg.max_retries:
                raise RuntimeError(f"GET failed after {attempt} attempts: {url}") from e
            time.sleep(cfg.backoff_base_s ** attempt)
            continue

        if resp.status_code == 200:
            return resp.json()

        # Handle rate limiting / transient
        if resp.status_code in (429, 500, 502, 503, 504):
            if attempt >= cfg.max_retries:
                raise RuntimeError(f"GET {url} failed with {resp.status_code}: {resp.text[:300]}")
            retry_after = resp.headers.get("Retry-After")
            if retry_after:
                try:
                    wait_s = float(retry_after)
                except ValueError:
                    wait_s = cfg.backoff_base_s ** attempt
            else:
                wait_s = cfg.backoff_base_s ** attempt
            time.sleep(wait_s)
            continue

        # Hard fail for other codes
        raise RuntimeError(f"GET {url} failed with {resp.status_code}: {resp.text[:500]}")

def paginate(session: requests.Session, first_url: str, cfg: HttpConfig, params: Optional[dict] = None) -> Iterable[dict]:
    """
    Iterate over paginated RIPE Atlas API v2 list endpoints (they return 'results' + 'next').
    """
    url = first_url
    p = dict(params or {})
    while url:
        data = get_json(session, url, cfg, params=p)
        # after first page, params must not be re-applied if 'next' already contains query args
        p = None
        for item in data.get("results", []):
            yield item
        url = data.get("next")

# ----------------------------
# RIPE Atlas specifics
# ----------------------------

def anchors_endpoint() -> str:
    return urljoin(API, "anchors/")

def anchor_measurements_endpoint() -> str:
    return urljoin(API, "anchor-measurements/")

def measurement_latest_url(measurement_id: int) -> str:
    # per docs: GET /api/v2/measurements/<id>/latest/
    return urljoin(API, f"measurements/{measurement_id}/latest/")

def parse_id_from_url(u: str) -> Optional[int]:
    # e.g. https://atlas.ripe.net/api/v2/measurements/7006244/
    try:
        parts = [p for p in u.strip("/").split("/") if p]
        return int(parts[-1])
    except Exception:
        return None

def safe_write_jsonl(path: str, rows: Iterable[dict]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

def safe_write_jsonl_gz(path: str, rows: Iterable[dict]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

def extract_anchor_probe_ids(anchor_obj: dict) -> List[int]:
    """
    Anchors can expose probe IDs in different shapes across versions.
    We try a few common patterns and return any integers we find.
    """
    probe_ids: List[int] = []

    # Common keys to check
    candidates = []
    for key in ("probe", "probes", "probe_id", "probe_ids"):
        if key in anchor_obj:
            candidates.append(anchor_obj[key])

    # Some APIs nest objects
    if "measurement_sources" in anchor_obj:
        candidates.append(anchor_obj.get("measurement_sources"))

    def walk(x: Any):
        if x is None:
            return
        if isinstance(x, int):
            probe_ids.append(x)
        elif isinstance(x, str):
            # sometimes IDs come as strings
            try:
                probe_ids.append(int(x))
            except ValueError:
                return
        elif isinstance(x, dict):
            for k, v in x.items():
                if k in ("id", "probe", "probe_id") and isinstance(v, (int, str)):
                    walk(v)
                else:
                    walk(v)
        elif isinstance(x, list):
            for it in x:
                walk(it)

    for c in candidates:
        walk(c)

    # de-dup while preserving order
    seen = set()
    out = []
    for pid in probe_ids:
        if pid not in seen:
            out.append(pid)
            seen.add(pid)
    return out

def build_probe_to_anchor_map(anchors: List[dict]) -> Dict[int, int]:
    """
    Map probe_id -> anchor_id.
    """
    m: Dict[int, int] = {}
    for a in anchors:
        anchor_id = a.get("id")
        if not isinstance(anchor_id, int):
            continue
        for pid in extract_anchor_probe_ids(a):
            if pid not in m:
                m[pid] = anchor_id
    return m

def anchor_country_map(anchors: List[dict]) -> Dict[int, Optional[str]]:
    out: Dict[int, Optional[str]] = {}
    for a in anchors:
        aid = a.get("id")
        if isinstance(aid, int):
            out[aid] = a.get("country") or a.get("country_code")
    return out

def anchor_city_map(anchors: List[dict]) -> Dict[int, Optional[str]]:
    out: Dict[int, Optional[str]] = {}
    for a in anchors:
        aid = a.get("id")
        if isinstance(aid, int):
            out[aid] = a.get("city")
    return out

def pull_all_anchors(session: requests.Session, cfg: HttpConfig) -> List[dict]:
    # Use large page size if supported; 'next' pagination still works.
    url = anchors_endpoint()
    return list(paginate(session, url, cfg, params={"page_size": 500}))

def pull_mesh_ping_measurements(session: requests.Session, cfg: HttpConfig) -> List[dict]:
    # Anchor-measurements is a list endpoint; we'll filter client-side (per RIPE forum guidance).
    url = anchor_measurements_endpoint()
    all_items = list(paginate(session, url, cfg, params={"page_size": 500}))
    mesh_ping = [x for x in all_items if x.get("is_mesh") is True and x.get("type") == "ping"]
    return mesh_ping

def iter_latest_results_for_measurement(
    session: requests.Session,
    cfg: HttpConfig,
    measurement_id: int,
    target_anchor_id: Optional[int],
) -> Iterable[dict]:
    """
    Yields normalized rows from /measurements/<id>/latest/.
    The payload is typically a JSON array of per-probe latest results.
    """
    url = measurement_latest_url(measurement_id)
    data = get_json(session, url, cfg)

    if isinstance(data, dict) and "results" in data:
        # some endpoints wrap; be defensive
        results = data["results"]
    else:
        results = data

    if not isinstance(results, list):
        return

    for r in results:
        if not isinstance(r, dict):
            continue
        # For ping, typical fields include: prb_id, timestamp, min/avg/max, rtt, etc.
        # We'll try a few; 'avg' is common for ping.
        prb_id = r.get("prb_id")
        ts = r.get("timestamp") or r.get("time")
        rtt_ms = r.get("avg")
        if rtt_ms is None:
            # some formats might use 'rtt' or provide per-packet 'result'
            rtt_ms = r.get("rtt")

        yield {
            "measurement_id": measurement_id,
            "target_anchor_id": target_anchor_id,
            "src_probe_id": prb_id,
            "timestamp": ts,
            "rtt_ms": rtt_ms,
            # keep some raw fields that help with debugging/quality filtering
            "af": r.get("af"),
            "dst_addr": r.get("dst_addr"),
            "src_addr": r.get("src_addr"),
            "raw": r,
        }

# ----------------------------
# Aggregation: country -> country
# ----------------------------

def aggregate_country_country(rows: Iterable[dict], probe2anchor: Dict[int, int], a2country: Dict[int, Optional[str]]) -> Dict[Tuple[str, str], List[float]]:
    buckets: Dict[Tuple[str, str], List[float]] = {}
    for row in rows:
        prb = row.get("src_probe_id")
        dst_anchor = row.get("target_anchor_id")
        rtt = row.get("rtt_ms")
        if not isinstance(rtt, (int, float)):
            continue
        if not isinstance(prb, int):
            continue
        if not isinstance(dst_anchor, int):
            continue

        src_anchor = probe2anchor.get(prb)
        if src_anchor is None:
            continue

        src_cc = a2country.get(src_anchor)
        dst_cc = a2country.get(dst_anchor)
        if not src_cc or not dst_cc:
            continue

        key = (src_cc, dst_cc)
        buckets.setdefault(key, []).append(float(rtt))
    return buckets

def pct(values: List[float], p: float) -> float:
    """
    Simple percentile (nearest-rank on sorted list).
    """
    if not values:
        return float("nan")
    xs = sorted(values)
    k = int(round((p / 100.0) * (len(xs) - 1)))
    k = max(0, min(len(xs) - 1, k))
    return xs[k]

def write_country_country_csv(path: str, buckets: Dict[Tuple[str, str], List[float]]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["src_country", "dst_country", "n", "min_ms", "p50_ms", "p90_ms", "p95_ms", "max_ms", "mean_ms"])
        for (src, dst), vals in sorted(buckets.items()):
            n = len(vals)
            mn = min(vals)
            mx = max(vals)
            mean = sum(vals) / n
            p50 = pct(vals, 50)
            p90 = pct(vals, 90)
            p95 = pct(vals, 95)
            w.writerow([src, dst, n, f"{mn:.3f}", f"{p50:.3f}", f"{p90:.3f}", f"{p95:.3f}", f"{mx:.3f}", f"{mean:.3f}"])

# ----------------------------
# Main
# ----------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default="ripe_mesh_out", help="Output directory")
    ap.add_argument("--max-measurements", type=int, default=0, help="For testing: limit number of mesh ping measurements (0 = all)")
    ap.add_argument("--min-sleep", type=float, default=0.15, help="Delay between requests (seconds)")
    args = ap.parse_args()

    cfg = HttpConfig(min_sleep_s=args.min_sleep)
    outdir = args.outdir

    with requests.Session() as session:
        print("Pulling anchors...")
        anchors = pull_all_anchors(session, cfg)
        print(f"  anchors: {len(anchors)}")

        safe_write_jsonl(os.path.join(outdir, "anchors.jsonl"), anchors)

        print("Pulling anchor-measurements and filtering mesh pings...")
        mesh_ping = pull_mesh_ping_measurements(session, cfg)
        if args.max_measurements and args.max_measurements > 0:
            mesh_ping = mesh_ping[: args.max_measurements]
        print(f"  mesh ping measurements: {len(mesh_ping)}")

        safe_write_jsonl(os.path.join(outdir, "mesh_ping_measurements.jsonl"), mesh_ping)

        # Build mapping tables
        probe2anchor = build_probe_to_anchor_map(anchors)
        a2country = anchor_country_map(anchors)

        # Stream latest results to gz jsonl
        latest_path = os.path.join(outdir, "latest_results.jsonl.gz")
        print(f"Fetching latest results for each mesh ping measurement -> {latest_path}")

        def iter_all_latest_rows() -> Iterable[dict]:
            for i, m in enumerate(mesh_ping, start=1):
                m_url = m.get("measurement")
                measurement_id = parse_id_from_url(m_url) if isinstance(m_url, str) else None
                target_url = m.get("target")
                target_anchor_id = parse_id_from_url(target_url) if isinstance(target_url, str) else None
                if measurement_id is None:
                    continue
                if i % 25 == 0:
                    print(f"  {i}/{len(mesh_ping)} measurements...")
                for row in iter_latest_results_for_measurement(session, cfg, measurement_id, target_anchor_id):
                    # enrich a bit
                    prb = row.get("src_probe_id")
                    src_anchor = probe2anchor.get(prb) if isinstance(prb, int) else None
                    row["src_anchor_id"] = src_anchor
                    row["src_country"] = a2country.get(src_anchor) if isinstance(src_anchor, int) else None
                    row["dst_country"] = a2country.get(target_anchor_id) if isinstance(target_anchor_id, int) else None
                    yield row

        # Materialize rows once (so we can aggregate after writing)
        all_rows = list(iter_all_latest_rows())
        safe_write_jsonl_gz(latest_path, all_rows)
        print(f"  total latest rows: {len(all_rows)}")

        # Aggregate country->country
        print("Aggregating country->country RTT...")
        buckets = aggregate_country_country(all_rows, probe2anchor, a2country)
        cc_path = os.path.join(outdir, "country_country_rtt.csv")
        write_country_country_csv(cc_path, buckets)
        print(f"  wrote {len(buckets)} country pairs -> {cc_path}")

    print("Done.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

