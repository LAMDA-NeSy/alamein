#!/usr/bin/env python3
"""Extract real El Alamein counters and predefined scenarios for the studio."""

from __future__ import annotations

import io
import json
import re
import shutil
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
VMOD = ROOT.parent / "vassal" / "mod" / "El-Alamein-v1.0.vmod"
IMAGE_DIR = ROOT / "mod_images"
SCENARIO_DIR = ROOT / "scenarios"

HEADER = b"!VCSK"
COLUMN_ROW_BOUNDS = {
    1: (1, 7), 2: (1, 7), 3: (1, 8), 4: (1, 8), 5: (1, 9),
    6: (1, 9), 7: (1, 10), 8: (1, 10), 9: (1, 11), 10: (1, 11),
    11: (1, 12), 12: (1, 12), 13: (1, 13), 14: (1, 13), 15: (1, 14),
    16: (1, 14), 17: (1, 15), 18: (1, 17), 19: (1, 18), 20: (1, 19),
    21: (1, 21), 22: (1, 21), 23: (1, 34), 24: (2, 33), 25: (3, 34),
    26: (3, 33), 27: (4, 34), 28: (4, 33), 29: (5, 34), 30: (5, 33),
    31: (6, 34), 32: (6, 33), 33: (7, 34), 34: (7, 33), 35: (8, 34),
    36: (8, 33), 37: (9, 34), 38: (9, 33), 39: (10, 34), 40: (10, 33),
    41: (10, 34), 42: (10, 33), 43: (10, 34), 44: (10, 33), 45: (10, 34),
    46: (10, 33), 47: (10, 34), 48: (10, 33), 49: (10, 34),
}

GRID = {
    "x0": 30.0,
    "y0": 36.0,
    "dx": 80.9,
    "dy": 93.7,
    "even_column_y_offset": 93.7 / 2,
}

SCENARIOS = {
    "july": "18.1-July-Scenario.vsav",
    "september": "18.2-September-Scenario.vsav",
    "october": "18.3-October-Scenario.vsav",
}


def deobfuscate(data: bytes) -> bytes:
    if not data.startswith(HEADER):
        return data
    key = int(data[5:7], 16)
    body = data[7:]
    out = bytearray()
    for i in range(0, len(body) - 1, 2):
        out.append(int(body[i:i + 2], 16) ^ key)
    return bytes(out)


def hex_center(hex_id: str) -> tuple[float, float]:
    col = int(hex_id[:2])
    row = int(hex_id[2:])
    raw_col = col
    raw_row = row
    if raw_col % 2 != 0:
        raw_row -= 1
    x = GRID["x0"] + raw_col * GRID["dx"]
    y = GRID["y0"] + raw_row * GRID["dy"]
    if raw_col % 2 != 0:
        y += GRID["even_column_y_offset"]
    return x, y


def pixel_to_hex(x: float, y: float) -> str:
    best_hex = "0101"
    best_dist = float("inf")
    for col, (min_row, max_row) in COLUMN_ROW_BOUNDS.items():
        for row in range(min_row, max_row + 1):
            hex_id = f"{col:02d}{row:02d}"
            cx, cy = hex_center(hex_id)
            dist = (cx - x) ** 2 + (cy - y) ** 2
            if dist < best_dist:
                best_hex = hex_id
                best_dist = dist
    return best_hex


def clean_spec(spec: str) -> tuple[str, str, str]:
    spec = spec.split("\\\ttrue;Map0;1;", 1)[0]
    spec = spec.replace("\\", "").strip()
    parts = spec.split("\t")
    title = parts[0].strip()
    side = next((p.strip().lower() for p in parts[1:] if p.strip().lower() in {"axis", "allies"}), "")
    if "/" in title:
      name, piece_type = title.split("/", 1)
    else:
      name, piece_type = title, ""
    return name.strip(), piece_type.strip(), side


def infer_side(image: str, name: str, explicit: str) -> str:
    stem = Path(image).stem.lower()
    if stem.startswith("allied-") or stem.startswith("allies-"):
        return "allies"
    if stem.startswith("axis-"):
        return "axis"
    if explicit in {"axis", "allies"}:
        return explicit
    lower = f"{image} {name}".lower()
    if any(token in lower for token in ["allies", "allied", "cw", "nz", "aus", "ind", "sa", "pol", "bel", "fr", "grk", "us"]):
        return "allies"
    if any(token in lower for token in ["axis", "it-", " it", "panzer", "pzg", "bers", "ggff", "ram", "kiel", "para", "air-landing", "aa"]):
        return "axis"
    return "neutral"


def infer_kind(image: str, name: str, piece_type: str) -> str:
    lower = f"{image} {name} {piece_type}".lower()
    if "mine" in lower:
        return "mine"
    if "supply" in lower or "vanguard" in lower:
        return "supply"
    if "road-mode" in lower or "road mode" in lower:
        return "marker"
    if "engineer" in lower:
        return "engineer"
    return "ground"


def infer_stats(image: str, name: str, piece_type: str, kind: str) -> dict[str, object]:
    text = f"{Path(image).stem} {name}"
    match = re.search(r"(?<!\d)(\d{1,2})-(\d{1,2})(?!\d)", text)
    if match:
        attack = int(match.group(1))
        movement = int(match.group(2))
        return {
            "attack": attack,
            "defense": attack,
            "movement": movement,
            "stats_status": "from_name",
        }
    if kind != "ground":
        return {"attack": 0, "defense": 0, "movement": 0, "stats_status": "marker"}
    mech = "mech" in piece_type.lower() or "arm" in image.lower() or "recon" in image.lower() or "panzer" in image.lower()
    return {
        "attack": 1,
        "defense": 1,
        "movement": 10 if mech else 4,
        "stats_status": "needs_counter_read",
    }


def parse_scenario(label: str, saved_name: str, archive: zipfile.ZipFile) -> dict[str, object]:
    with zipfile.ZipFile(io.BytesIO(archive.read(saved_name))) as save_zip:
        text = deobfuscate(save_zip.read("savedGame")).decode("utf-8", "replace")

    units: dict[str, dict[str, object]] = {}
    counters: dict[str, int] = {}
    for chunk in re.split(r"\x1b\+/", text):
        image_match = re.search(r"piece;;;([^;]+\.png);", chunk)
        if not image_match:
            continue
        image = image_match.group(1)
        main_map = re.search(r"Main Map;(\d+);(\d+);", chunk)
        map0 = re.search(r"true;Map0;1;(\d+),(\d+);true", chunk)
        xy_match = map0 or main_map
        if not xy_match:
            continue
        x, y = int(xy_match.group(1)), int(xy_match.group(2))
        spec_start = image_match.end()
        spec_end = chunk.find("\\\ttrue;Map0;1;", spec_start)
        if spec_end < 0:
            spec_end = chunk.find("\ttrue;Map0;1;", spec_start)
        spec = chunk[spec_start:spec_end if spec_end > 0 else spec_start + 160]
        name, piece_type, explicit_side = clean_spec(spec)
        side = infer_side(image, name, explicit_side)
        kind = infer_kind(image, name, piece_type)
        stats = infer_stats(image, name, piece_type, kind)
        stem = Path(image).stem
        counters[stem] = counters.get(stem, 0) + 1
        unit_id = f"{label}-{stem}-{counters[stem]:02d}"
        size = "division" if "division" in name.lower() or " div" in name.lower() or "it-inf" in image.lower() else "regiment"
        units[unit_id] = {
            "name": name or stem,
            "piece_type": piece_type,
            "side": side,
            "hex": pixel_to_hex(x, y),
            "x": x,
            "y": y,
            "image": f"mod_images/{image}",
            "state": "fresh",
            "size": size,
            "kind": kind,
            **stats,
        }

    active = "axis"
    phase = "axis_initial_movement"
    return {
        "schema_version": 1,
        "source": saved_name,
        "scenario": label,
        "turn": 7 if label == "july" else 1,
        "phase": phase,
        "active_side": active,
        "map_grid": GRID,
        "control": {"3711": "allies"},
        "units": units,
    }


def main() -> int:
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    SCENARIO_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(VMOD) as archive:
        for name in archive.namelist():
            if name.startswith("images/") and name.lower().endswith(".png"):
                target = IMAGE_DIR / Path(name).name
                with archive.open(name) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
        for label, saved_name in SCENARIOS.items():
            data = parse_scenario(label, saved_name, archive)
            (SCENARIO_DIR / f"{label}.json").write_text(
                json.dumps(data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
    print(f"extracted {len(list(IMAGE_DIR.glob('*.png')))} images")
    for label in SCENARIOS:
        data = json.loads((SCENARIO_DIR / f"{label}.json").read_text(encoding="utf-8"))
        print(label, len(data["units"]), "pieces")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
