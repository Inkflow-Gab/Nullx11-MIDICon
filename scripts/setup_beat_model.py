#!/usr/bin/env python3
"""Download and verify the MIT-licensed Beat This! small0 ONNX mirror.

The weights are the official CPJKU ``small0`` checkpoint (MIT).  This pinned
GitHub blob is a non-LFS ONNX export used by the browser and server pipelines.
No executable model code is downloaded or run.
"""
from __future__ import annotations

import base64
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from webapp.beat import MODEL_NAME, MODEL_SHA256, model_path

REPO = "loganjmoore/webxlights"
COMMIT = "b0006dc0b6466bfa3f98adbec72fba187696d25c"
MODEL_BLOB = "175cdcfe15038441b50f7b306c3ce733b5433278"
LICENSE_PATH = "apps/web/public/models/beat-this-small0.LICENSE.txt"


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "Nullx-MIDICon-setup/1.0", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def main() -> None:
    target = model_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == MODEL_SHA256:
        print(f"Verified AI Assist model already installed: {target}")
    else:
        print("Downloading Beat This! small0 ONNX (~10 MB, MIT)…")
        blob = fetch_json(f"https://api.github.com/repos/{REPO}/git/blobs/{MODEL_BLOB}")
        data = base64.b64decode(blob["content"])
        digest = hashlib.sha256(data).hexdigest()
        if digest != MODEL_SHA256:
            raise RuntimeError(f"AI Assist model checksum mismatch: {digest}")
        tmp = target.with_suffix(".onnx.tmp")
        tmp.write_bytes(data)
        tmp.replace(target)
        print(f"AI Assist model verified and installed: {target}")
    license_target = target.parent / "LICENSE.txt"
    if not license_target.exists():
        meta = fetch_json(f"https://api.github.com/repos/{REPO}/contents/{LICENSE_PATH}?ref={COMMIT}")
        license_target.write_bytes(base64.b64decode(meta["content"]))
    notice = target.parent / "NOTICE.txt"
    notice.write_text(
        "Beat This! small0 ONNX export.\n"
        "Model: https://github.com/CPJKU/beat_this (Foscarin, Schlüter & Widmer, ISMIR 2024).\n"
        "Weights and upstream code: MIT, Copyright (c) 2024 Institute of Computational Perception, JKU Linz.\n"
        f"ONNX mirror: https://github.com/{REPO}/blob/{COMMIT}/apps/web/public/models/{MODEL_NAME}\n"
        "The mirror repository is GPL-3.0; the model file itself is MIT as stated in LICENSE.txt.\n"
        "MIDICon runs this model locally for optional beat/downbeat analysis. It does not train on your audio.\n"
    )


if __name__ == "__main__":
    main()
