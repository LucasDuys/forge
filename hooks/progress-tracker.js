#!/usr/bin/env node
// PostToolUse hook -- zero-context progress tracker
// Writes to .forge/.progress.json and stderr ONLY. Zero stdout = zero context tokens.
// Matcher: "*" (all tools)

const fs = require('fs');
const path = require('path');

const FORGE_DIR = '.forge';
const PROGRESS_FILE = path.join(FORGE_DIR, '.progress.json');

let input = '';
const timeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || 'unknown';

    if (!fs.existsSync(FORGE_DIR)) process.exit(0);

    let progress = {
      started: null,
      tool_calls: 0,
      tools_by_type: {},
      current_phase: 'unknown',
      current_task: null,
      tasks_completed: 0,
      last_tool: null,
      last_tool_time: null,
      files_modified: [],
      commits: 0,
      test_runs: 0,
      test_pass_rate: null,
      elapsed_sec: 0
    };
    if (fs.existsSync(PROGRESS_FILE)) {
      try { progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch (e) {}
    }

    if (!progress.started) progress.started = Date.now();
    progress.tool_calls++;
    progress.tools_by_type[toolName] = (progress.tools_by_type[toolName] || 0) + 1;
    progress.last_tool = toolName;
    progress.last_tool_time = new Date().toISOString();
    progress.elapsed_sec = Math.round((Date.now() - progress.started) / 1000);

    // Track commits
    const cmd = data.tool_input?.command || '';
    if (toolName === 'Bash' && /git commit/.test(cmd)) {
      progress.commits++;
    }

    // Track test runs
    if (toolName === 'Bash' && /vitest|jest|pytest|cargo test|go test|npm test/.test(cmd)) {
      progress.test_runs++;
      const output = typeof data.tool_output === 'string' ? data.tool_output : '';
      const passMatch = output.match(/(\d+) passed/);
      const failMatch = output.match(/(\d+) failed/);
      if (passMatch) {
        const passed = parseInt(passMatch[1]);
        const failed = failMatch ? parseInt(failMatch[1]) : 0;
        progress.test_pass_rate = Math.round((passed / (passed + failed)) * 100);
      }
    }

    // Track file modifications
    if (['Edit', 'Write'].includes(toolName)) {
      const fp = data.tool_input?.file_path;
      if (fp && !progress.files_modified.includes(fp)) {
        progress.files_modified.push(fp);
        if (progress.files_modified.length > 50) {
          progress.files_modified = progress.files_modified.slice(-50);
        }
      }
    }

    // Read state for task info
    const statePath = path.join(FORGE_DIR, 'state.md');
    if (fs.existsSync(statePath)) {
      try {
        const stateText = fs.readFileSync(statePath, 'utf8');
        const phaseMatch = stateText.match(/^phase:\s*(.+)$/m);
        const taskMatch = stateText.match(/^current_task:\s*(.+)$/m);
        if (phaseMatch) progress.current_phase = phaseMatch[1].trim();
        if (taskMatch) progress.current_task = taskMatch[1].trim();
      } catch (e) {}
    }

    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));

    // Write to stderr only -- zero context cost
    const min = Math.floor(progress.elapsed_sec / 60);
    const sec = progress.elapsed_sec % 60;
    const summary = `[Forge] ${min}m${sec}s | ${progress.tool_calls} tools | ${progress.commits} commits | ${progress.files_modified.length} files | task: ${progress.current_task || 'none'}`;
    process.stderr.write(summary + '\n');

    // EXIT 0 WITH NO STDOUT -- zero token cost
  } catch (e) {
    // Silent failure
  }
  process.exit(0);
});
