import sys, json
d = json.load(sys.stdin)
deps = d["deployments"]
print("deployment names:", list(deps.keys()))
rd = deps.get("reduced_data") or deps.get("rdts")
print(json.dumps(rd, indent=2) if rd else "NO reduced_data/rdts deployment shown")
