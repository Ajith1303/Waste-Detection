"""
Validate a Roboflow API key and print the exact values to paste into
backend/python_detector/.env so the detector can run a specific model.

Usage:
    python scripts/check_roboflow_key.py <YOUR_API_KEY> [<project>/<version>]

Examples:
    python scripts/check_roboflow_key.py "AbCdEf123..."
    python scripts/check_roboflow_key.py "AbCdEf123..." "illegal-dumping-detection-a5otx/1"
"""
import json
import sys
import urllib.request

KEY = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
MODEL = (sys.argv[2] if len(sys.argv) > 2 else "").strip()


def get(url):
    with urllib.request.urlopen(url, timeout=25) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    if not KEY:
        print("ERROR: pass your Roboflow private API key as the first argument.")
        sys.exit(1)

    print(f"Checking API key ...{KEY[-4:]}")
    try:
        who = get(f"https://api.roboflow.com/?api_key={KEY}")
    except Exception as e:
        print(f"ERROR: could not reach Roboflow: {e}")
        sys.exit(1)

    ws = (who.get("workspace") or "").strip()
    if not ws:
        print("ERROR: invalid API key (no workspace returned).")
        sys.exit(1)

    print(f"\nWorkspace     : {ws}   <-- put this in ROBOFLOW_WORKSPACE")

    print("\nProjects in this workspace:")
    try:
        data = get(f"https://api.roboflow.com/{ws}?api_key={KEY}")
        projs = data.get("workspace", {}).get("projects", []) or []
        if not projs:
            print("  (none)")
        for p in projs:
            pid = (p.get("id") or "").split("/")[-1]
            print(f"  - {pid:45s} versions={p.get('versions', 0)}  images={p.get('images', 0)}")
    except Exception as e:
        print(f"  (could not list projects: {e})")

    if not MODEL:
        print("\nProvide a model id to validate it, e.g. your_project/2")
        return

    model = MODEL.strip().strip("/")
    parts = [p for p in model.split("/") if p]
    if len(parts) == 2:
        model = f"{ws}/{model}"
    print(f"\nUsing model   : {model}")

    # Validate the project exists in this workspace by forcing an inference ping.
    probe = f"https://serverless.roboflow.com/{model}"
    print(f"Probing       : {probe}")
    try:
        req = urllib.request.Request(
            probe, data=b"x" * 16, method="POST",
            headers={"Authorization": f"Bearer {KEY}"},
        )
        with urllib.request.urlopen(req, timeout=25) as r:
            print(f"  OK: {r.status} (note: may need a real image)")
    except urllib.error.HTTPError as e:
        if e.code == 400:
            print("  OK: model endpoint reached (400 = expected without a valid image)")
        else:
            print(f"  HTTP {e.code}: {e.read().decode('utf-8')[:200]}")
    except urllib.error.URLError as e:
        print(f"  URL error: {e.reason}")

    print("\nPaste these into backend/python_detector/.env:")
    print("  ROBOFLOW_MODE=model")
    print(f"  ROBOFLOW_API_KEY={KEY}")
    print(f"  ROBOFLOW_WORKSPACE={ws}")
    print(f"  ROBOFLOW_MODEL_ID={model}")


if __name__ == "__main__":
    main()
