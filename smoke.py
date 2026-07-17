"""End-to-end smoke test for the musik.build API.

Spins up the server on a scratch port with DEV_AUTH=1 and a temp DB,
exercises every endpoint and the permission rules, prints PASS/FAIL.
Usage: python3 smoke.py
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error

PORT = 8391
BASE = f"http://127.0.0.1:{PORT}"
ALICE = {"X-Dev-Actor": "human:alice"}
ED = {"X-Dev-Actor": "agent:ed"}

GRAPH = {
    "nodes": [{"id": "n1", "name": "A", "x": 0, "y": 0, "reps": 1,
               "state": {"bpm": 100, "grids": {"drums": [[1, 0, 1, 0]]}}}],
    "edges": [],
    "startId": "n1",
}

failures = []


def call(method, path, headers=None, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        headers={"Content-Type": "application/json", **(headers or {})},
        data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        failures.append(name)


def main():
    with tempfile.TemporaryDirectory() as td:
        env = {**os.environ, "PORT": str(PORT), "DEV_AUTH": "1",
               "DB_PATH": os.path.join(td, "test.db")}
        proc = subprocess.Popen(
            [sys.executable, os.path.join(os.path.dirname(__file__), "server.py")],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(50):
                time.sleep(0.1)
                try:
                    s, _ = call("GET", "/api/health")
                    if s == 200:
                        break
                except Exception:
                    pass

            s, b = call("GET", "/api/health")
            check("health", s == 200 and b.get("ok") is True)

            s, b = call("GET", "/api/me", ALICE)
            check("api/me dev actor", s == 200 and b["id"] == "alice"
                  and b["kind"] == "human" and b["name"] == "alice")

            s, b = call("GET", "/.well-known/slock-agent-manifest.json")
            check("agent manifest", s == 200 and
                  b["execution"]["mode"] == "http_api" and
                  b["execution"]["base_url"].endswith("/api") and
                  b["context_check"]["url"].endswith("/api/me"))

            s, _ = call("GET", "/api/loops")
            check("no auth -> 401", s == 401)

            s, b = call("POST", "/api/loops", ALICE, {"bad": 1})
            check("bad graph -> 400", s == 400)

            s, loop = call("POST", "/api/loops", ALICE,
                           {"title": "Midnight Metro", "graph": GRAPH})
            check("create loop", s == 201 and loop["authorKind"] == "human"
                  and loop["forkRoot"] == loop["id"] and loop["published"] is False)
            lid = loop["id"]

            s, b = call("GET", f"/api/loops/{lid}", ED)
            check("get loop", s == 200 and b["id"] == lid)

            g2 = json.loads(json.dumps(GRAPH))
            g2["nodes"].append({"id": "n2", "name": "B", "x": 1, "y": 0,
                                "reps": 2, "state": {"bpm": 92}})
            g2["edges"].append({"from": "n1", "to": "n2"})
            s, b = call("PATCH", f"/api/loops/{lid}", ED, {"graph": g2})
            check("non-author PATCH -> 403", s == 403)

            s, b = call("PATCH", f"/api/loops/{lid}", ALICE,
                        {"graph": g2, "op": {"action": "add_node", "payload": {"id": "n2"}}})
            check("author PATCH", s == 200 and len(b["graph"]["nodes"]) == 2)

            s, b = call("POST", f"/api/loops/{lid}/fork", ED, {})
            check("fork unpublished other's -> 403", s == 403)

            s, b = call("POST", f"/api/loops/{lid}/publish", ED)
            check("non-author publish -> 403", s == 403)

            s, b = call("POST", f"/api/loops/{lid}/publish", ALICE)
            check("publish", s == 200 and b["published"] is True and b["publishedAt"])

            s, fork = call("POST", f"/api/loops/{lid}/fork", ED,
                           {"title": "808 Remix"})
            check("fork published", s == 201 and fork["forkedFrom"] == lid
                  and fork["forkRoot"] == lid and fork["authorKind"] == "agent"
                  and fork["published"] is False)

            s, feed = call("GET", "/api/loops?published=1", ED)
            check("published feed", s == 200 and len(feed) == 1
                  and feed[0]["id"] == lid)

            s, ops = call("GET", f"/api/loops/{lid}/ops", ED)
            actions = [o["action"] for o in ops]
            check("loop ops", s == 200 and actions ==
                  ["create_loop", "add_node", "publish"], str(actions))
            check("op actor recorded", ops[1]["actorId"] == "alice"
                  and ops[1]["actorKind"] == "human")

            s, fops = call("GET", f"/api/loops/{fork['id']}/ops", ALICE)
            check("fork op on child", s == 200 and len(fops) == 1
                  and fops[0]["action"] == "fork"
                  and fops[0]["payload"]["from"] == lid)

            s, recent = call("GET", "/api/ops?limit=10", ALICE)
            check("global ops desc", s == 200 and recent[0]["action"] == "fork"
                  and recent[0]["loopTitle"] == "808 Remix")

            s, all_loops = call("GET", "/api/loops", ALICE)
            check("list all", s == 200 and len(all_loops) == 2)
        finally:
            proc.terminate()
            proc.wait(timeout=5)

    print(f"\n{'ALL PASS' if not failures else f'{len(failures)} FAILURES: {failures}'}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
