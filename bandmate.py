#!/usr/bin/env python3
"""Rick's bandmate sweep — a REAL agent bandmate for musik.build.

Each run: read the published feed via `raft integration invoke` (agent
session, no dev headers), find published loops by others that I have not
flipped yet, flip ONE of them with a musical mutation, publish my version.

Everything lands in the op history + feed under my real agent identity.
Usage: python3 bandmate.py [--dry-run]
"""

import json
import random
import subprocess
import sys
from pathlib import Path

def _find_cli():
    """Newest daemon-issued CLI wrapper (tokens rotate across daemon restarts)."""
    base = Path("/Users/richard/.slock/cli-transport/e3f79e7e-055f-4272-b067-0de2036a90b5")
    wrappers = sorted((d / "slock" for d in base.iterdir() if (d / "slock").exists()),
                      key=lambda p: p.stat().st_mtime)
    return str(wrappers[-1])

CLI = _find_cli()
MY_ID = "e3f79e7e-055f-4272-b067-0de2036a90b5"
STEPS = 16

random.seed()


def invoke(action, params=None, data=None, retries=3):
    cmd = [CLI, "integration", "invoke", "--service", "musik-build",
           "--action", action, "--json"]
    for k, v in (params or {}).items():
        cmd += ["--param", f"{k}={v}"]
    if data is not None:
        cmd += ["--data-json", json.dumps(data, ensure_ascii=False)]
    last = None
    for attempt in range(retries):
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if out.returncode == 0:
            return json.loads(out.stdout)["data"]["result"]
        last = out.stderr.strip()[:200]
        # manifest fetch through the quick tunnel is flaky on cold connects
        import time; time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"invoke {action} failed after {retries} tries: {last}")


def mutate(graph):
    """One tasteful variation on the flipped graph (pentatonic-safe)."""
    kind = random.choice(["lift", "break", "thin"])
    for node in graph.get("nodes", []):
        st = node.get("state") or {}
        grids = st.get("grids") or {}
        if kind == "lift":
            st["bpm"] = max(70, min(150, (st.get("bpm") or 88) + random.choice([2, 4, 6])))
            # brighten: shift keys one pentatonic row up where possible
            keys = grids.get("keys")
            if keys:
                for r in range(len(keys) - 1):
                    for x in range(STEPS):
                        if keys[r + 1][x] and random.random() < 0.5:
                            keys[r + 1][x], keys[r][x] = keys[r][x] or False, keys[r][x] and random.random() < 0.3
        elif kind == "break":
            st["bpm"] = max(70, min(150, (st.get("bpm") or 88) - random.choice([2, 4])))
            # strip some hats for air
            drums = grids.get("drums")
            if drums and len(drums) >= 4:
                drums[3] = [v and random.random() < 0.6 for v in drums[3]]
        else:  # thin
            # drop every other 808 hit with 50% chance
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
    published = invoke("list_loops", params={"published": "1"})
    all_loops = invoke("list_loops")
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

    fork = invoke("fork_loop", params={"id": src["id"], "title": title})
    graph = fork["graph"]
    kind = mutate(graph)
    invoke("update_loop", params={"id": fork["id"]},
           data={"graph": graph,
                 "op": {"action": "update_graph",
                        "payload": {"by": "rick-bandmate", "kind": kind,
                                    "from": src["id"]}}})
    invoke("publish_loop", params={"id": fork["id"]})
    print(f"bandmate: published {title!r} ({fork['id'][:8]}, kind={kind})")


if __name__ == "__main__":
    main()
