#!/usr/bin/env bash
# Rebuild the public benchmark corpus (~7MB, four content kinds).
# Downloads are public-domain / permissively licensed; generated files are
# deterministic. Downloaded/generated corpus files are gitignored.
set -euo pipefail
cd "$(dirname "$0")"

# prose (public domain, GITenberg mirrors)
curl -sSL -o moby-dick.txt \
  "https://raw.githubusercontent.com/GITenberg/Moby-Dick--Or-The-Whale_2701/master/2701.txt"
curl -sSL -o war-and-peace.txt \
  "https://raw.githubusercontent.com/mmcky/nyu-econ-370/master/notebooks/data/book-war-and-peace.txt"

# docs (git project documentation, GPLv2 — used locally for benchmarking only)
curl -sSL -o git-docs.adoc \
  "https://raw.githubusercontent.com/git/git/master/Documentation/config.adoc"

# code (local Python stdlib, PSF license)
python3 - <<'EOF'
import glob, os, sysconfig
libdir = sysconfig.get_path('stdlib')
out = open('python-stdlib.py', 'w'); total = 0
for f in sorted(glob.glob(os.path.join(libdir, '*.py'))):
    s = open(f, encoding='utf-8', errors='ignore').read()
    out.write(f"\n# ===== {os.path.basename(f)} =====\n" + s)
    total += len(s)
    if total > 2_500_000:
        break
out.close(); print('python-stdlib.py', total)
EOF

# logs (deterministic synthetic agent transcript)
python3 - <<'EOF'
import random
random.seed(42)
tools = ["Read","Edit","Bash","Grep","Glob","WebFetch"]
files = ["src/auth/login.py","lib/tokens.js","scripts/deploy.sh","api/routes.go","tests/test_budget.py"]
lines = []
for turn in range(1, 4001):
    t = random.choice(tools); f = random.choice(files)
    lines.append(f"[turn {turn:04d}] agent invoked {t} on {f} -> exit {random.choice([0,0,0,1])} "
                 f"({random.randint(3,900)}ms). tokens_in={random.randint(200,9000)} "
                 f"tokens_out={random.randint(20,1200)}. note: {'retry after transient failure' if random.random()<0.1 else 'ok'}")
open("agent-log.txt","w").write("\n".join(lines))
print("agent-log.txt", sum(len(l)+1 for l in lines))
EOF

ls -la
