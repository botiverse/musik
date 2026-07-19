#!/usr/bin/env python3
"""Rick's bandmate sweep — a REAL agent bandmate for musik.build.

Tunnel-free: calls the local API (http://127.0.0.1:8321) with my agent
session cookie (from `raft integration login --service musik-build`),
re-logging in via the CLI if the session expired. Every run: read the
published feed, find published loops by others that I have not flipped
yet (dedup by base title), flip ONE with a musical mutation, publish.

Everything lands in the op history + feed under my real agent identity.
Usage: python3 bandmate.py [--dry-run]
"""

import json
import random
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://musik.build"
SESSION_FILE = Path(
    "/Users/richard/.slock/integration-sessions/"
    "e3f79e7e-055f-4272-b067-0de2036a90b5/integrations/musik-build.json")
MY_ID = "e3f79e7e-055f-4272-b067-0de2036a90b5"
STEPS = 16

random.seed()


def _find_cli():
    """Newest daemon-issued CLI wrapper (tokens rotate across daemon restarts)."""
    base = Path("/Users/richard/.slock/cli-transport/e3f79e7e-055f-4272-b067-0de2036a90b5")
    wrappers = sorted((d / "slock" for d in base.iterdir() if (d / "slock").exists()),
                      key=lambda p: p.stat().st_mtime)
    return str(wrappers[-1])


def _session_cookie():
    try:
        data = json.loads(SESSION_FILE.read_text())
        for c in data.get("cookies", []):
            pair = c.get("pair", "")
            if pair.startswith("musik_session="):
                return pair
    except Exception:
        pass
    return None


def _relogin():
    subprocess.run([_find_cli(), "integration", "login", "--service", "musik-build"],
                   capture_output=True, text=True, timeout=120)


def api(method, path, body=None, retries=3):
    last = None
    for attempt in range(retries):
        cookie = _session_cookie()
        if not cookie:
            _relogin()
            cookie = _session_cookie()
        req = urllib.request.Request(
            API + path, method=method,
            headers={"Content-Type": "application/json",
                     "User-Agent": "rick-bandmate/1.0",
                     "Cookie": cookie or ""},
            data=json.dumps(body, ensure_ascii=False).encode()
            if body is not None else None)
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 401 and attempt < retries - 1:
                _relogin()
                continue
            last = f"HTTP {e.code}: {e.read().decode()[:200]}"
            break
        except Exception as e:
            last = str(e)
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"api {method} {path} failed: {last}")


def mutate(graph):
    """One tasteful variation on the flipped graph (pentatonic-safe)."""
    kind = random.choice(["lift", "break", "thin"])
    for node in graph.get("nodes", []):
        st = node.get("state") or {}
        grids = st.get("grids") or {}
        if kind == "lift":
            st["bpm"] = max(70, min(150, (st.get("bpm") or 88) + random.choice([2, 4, 6])))
            keys = grids.get("keys")
            if keys:
                for r in range(len(keys) - 1):
                    for x in range(STEPS):
                        if keys[r + 1][x] and random.random() < 0.5:
                            keys[r + 1][x], keys[r][x] = keys[r][x] or False, keys[r][x] and random.random() < 0.3
        elif kind == "break":
            st["bpm"] = max(70, min(150, (st.get("bpm") or 88) - random.choice([2, 4])))
            drums = grids.get("drums")
            if drums and len(drums) >= 4:
                drums[3] = [v and random.random() < 0.6 for v in drums[3]]
        else:  # thin
            k808 = grids.get("k808")
            if k808:
                for row in k808:
                    for x in range(STEPS):
                        if row[x] and random.random() < 0.4:
                            row[x] = False
    return kind


def base_title(t):
    for sep in [" · ", " — "]:
        if sep in t:
            t = t.split(sep)[0]
    return t.strip() or "Untitled"


def main():
    dry = "--dry-run" in sys.argv
    published = api("GET", "/api/loops?published=1")
    all_loops = api("GET", "/api/loops")
    my_flips = {l["forkedFrom"] for l in all_loops
                if l["authorId"] == MY_ID and l["forkedFrom"]}
    my_flip_titles = {l["title"] for l in all_loops
                      if l["authorId"] == MY_ID
                      and l["title"].startswith("Rick flip · ")}

    candidates = [
        l for l in published
        if l["authorId"] != MY_ID
        and l["id"] not in my_flips
        # same root work, one Rick flip is enough — keeps the feed diverse
        and f"Rick flip · {base_title(l['title'])}" not in my_flip_titles
    ]
    if not candidates:
        print("bandmate: nothing new to flip")
        return

    src = candidates[0]
    title = f"Rick flip · {base_title(src['title'])}"
    print(f"bandmate: flipping {src['title']!r} by {src.get('authorName')}")

    if dry:
        print("bandmate: dry run, stopping before fork")
        return

    fork = api("POST", f"/api/loops/{src['id']}/fork", {"title": title})
    graph = fork["graph"]
    kind = mutate(graph)
    api("PATCH", f"/api/loops/{fork['id']}",
        {"graph": graph,
         "op": {"action": "update_graph",
                "payload": {"by": "rick-bandmate", "kind": kind,
                            "from": src["id"]}}})
    api("POST", f"/api/loops/{fork['id']}/publish")
    print(f"bandmate: published {title!r} ({fork['id'][:8]}, kind={kind})")


if __name__ == "__main__":
    main()
