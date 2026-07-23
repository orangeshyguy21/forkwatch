import json, sys, time, urllib.request

deadline = time.time() + 300
while time.time() < deadline:
    try:
        d = json.load(urllib.request.urlopen("http://localhost:8080/api/state", timeout=10))
    except Exception as e:
        print("  waiting for app:", e); time.sleep(5); continue
    f = d.get("fork") or {}
    depth = len(f.get("core_branch", []))
    sf = d.get("scheduled_fork") or {}
    print(f"  agreed={d['agreed']} core={d['core']['blocks']} knots={d['knots']['blocks']} "
          f"fork_depth={depth} until_fork={sf.get('blocks_until')}", flush=True)
    if not d["agreed"] and depth >= 3:
        print("FORK live and both chains advancing.")
        sys.exit(0)
    time.sleep(8)
print("timed out waiting for fork")
sys.exit(1)
