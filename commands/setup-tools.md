---
description: "Detect missing CLI tools and install them to enhance Forge capabilities"
allowed-tools: ["Read(*)", "Bash(*)"]
---

# Forge Setup Tools

Detect which CLI tools are available on the system, show which are missing, and offer to install them.

## Step 1: Run Detection

Run version checks for all supported CLI tools:

```bash
echo "=== CLI Tool Detection ==="

tools_status=""

check_tool() {
  local name="$1" cmd="$2" install="$3" purpose="$4"
  if eval "$cmd" > /dev/null 2>&1; then
    version=$(eval "$cmd" 2>/dev/null | head -1)
    tools_status="${tools_status}\n  [installed]  ${name} — ${purpose} (${version})"
  else
    tools_status="${tools_status}\n  [missing]    ${name} — ${purpose}\n               Install: ${install}"
  fi
}

check_tool "gh"          "gh --version"           "winget install GitHub.cli"                          "GitHub PR/issue management, CI/CD"
check_tool "vercel"      "vercel --version"        "npm i -g vercel"                                   "Deployment, preview URLs, serverless"
check_tool "stripe"      "stripe --version"        "winget install Stripe.StripeCLI"                   "Payment testing, webhooks"
check_tool "ffmpeg"      "ffmpeg -version"         "winget install Gyan.FFmpeg"                        "Video/audio processing"
check_tool "playwright"  "npx playwright --version" "npm i -g playwright && playwright install"        "Browser automation, E2E testing"
check_tool "gws"         "gws --version"           "npm i -g @googleworkspace/cli"                     "Google Workspace — Drive, Gmail, Sheets"
check_tool "notebooklm"  "notebooklm --version"    "pip install notebooklm-py"                        "Research with grounded citations"
check_tool "supabase"    "supabase --version"       "winget install Supabase.CLI"                      "Database, auth, edge functions"
check_tool "firebase"    "firebase --version"       "npm i -g firebase-tools"                          "App hosting, Firestore, cloud functions"
check_tool "docker"      "docker --version"         "winget install Docker.DockerDesktop"              "Container management"
check_tool "wrangler"    "wrangler --version"       "npm i -g wrangler"                                "Cloudflare Workers, KV"
check_tool "graphify"     "graphify -h"              "pip install graphifyy"                             "Codebase knowledge graphs for architecture-aware planning"
check_tool "cli-anything" "ls ~/.claude/plugins/cli-anything* 2>/dev/null || compgen -c cli-anything- | head -1" "In Claude Code: /plugin marketplace add HKUDS/CLI-Anything && /plugin install cli-anything" "Agent-native CLIs for desktop software"

echo -e "$tools_status"
```

## Step 2: Present Results

Display the results in a clear table:

```
Forge Setup Tools
===================================

CLI tools enhance Forge's execution, verification, and research capabilities.
They are optional — Forge works without them, but gains powers when they're present.

{tool_status_output}

Installed: {N}/12
Missing:   {M}/12
```

## Step 3: Offer Installation

If there are missing tools, ask the user:

> **{M} tools are not installed.** Want me to install them?
>
> Options:
> 1. **Install all** — install every missing tool
> 2. **Pick and choose** — select which ones to install
> 3. **Skip** — just show me the status, I'll install manually

If the user chooses to install:
- Use the install command shown for each tool
- Run installs in parallel where possible (npm tools together, pip tools together, winget tools together)
- After installation, re-run detection to confirm everything installed correctly
- Update `.forge/capabilities.json` by running: `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge-tools.cjs" discover --forge-dir .forge` (if `.forge/` exists)

## Step 4: Post-Install Notes

After installation, remind the user about tools that need authentication:

- **stripe**: Run `stripe login` to authenticate
- **vercel**: Run `vercel login` to authenticate
- **gws**: Run `gws auth login` to authenticate with Google
- **notebooklm**: Run `notebooklm auth` to authenticate with Google
- **firebase**: Run `firebase login` to authenticate
- **supabase**: Run `supabase login` to authenticate
- **gh**: Run `gh auth login` if not already authenticated

## Platform Notes

- On **Windows**, prefer `winget` for native tools (stripe, ffmpeg, supabase, docker)
- On **macOS**, prefer `brew` for native tools
- On **Linux**, use the appropriate package manager or direct downloads
- npm and pip tools work cross-platform

Adjust install commands based on the detected platform (`process.platform` or `uname`).
