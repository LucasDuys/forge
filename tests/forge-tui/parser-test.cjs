// Tests for StreamParser (T006/T008): chunk-boundary safe parsing,
// agent attribution stack, malformed line handling, token extraction.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { StreamParser, MAX_CONSECUTIVE_PARSE_ERRORS } = require('../../scripts/forge-tui.cjs');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixture-stream.jsonl'), 'utf8');
const EXPECTED_EVENTS = 10;

function makeParser() {
  const events = [];
  const agents = [];
  const p = new StreamParser({
    forgeDir: path.join(__dirname, '..', '..', '.forge'),
    onEvent: (e, a) => { events.push(e); agents.push(a); },
    onFatal: () => { /* swallow for tests that don't care */ },
  });
  return { p, events, agents };
}

module.exports = {
  'feeds entire fixture in one chunk'() {
    const { p, events } = makeParser();
    p.feed(FIXTURE);
    p.end();
    assert.strictEqual(events.length, EXPECTED_EVENTS);
  },

  'feeds fixture character by character'() {
    const { p, events } = makeParser();
    for (const ch of FIXTURE) p.feed(ch);
    p.end();
    assert.strictEqual(events.length, EXPECTED_EVENTS);
  },

  'feeds fixture in arbitrary 7-byte chunks'() {
    const { p, events } = makeParser();
    for (let i = 0; i < FIXTURE.length; i += 7) {
      p.feed(FIXTURE.slice(i, i + 7));
    }
    p.end();
    assert.strictEqual(events.length, EXPECTED_EVENTS);
  },

  'feeds fixture in random chunk sizes'() {
    const { p, events } = makeParser();
    let i = 0;
    let seed = 12345;
    while (i < FIXTURE.length) {
      seed = (seed * 9301 + 49297) % 233280;
      const size = 1 + (seed % 50);
      p.feed(FIXTURE.slice(i, i + size));
      i += size;
    }
    p.end();
    assert.strictEqual(events.length, EXPECTED_EVENTS);
  },

  'attributes nested Task subagent correctly'() {
    const { p, events, agents } = makeParser();
    p.feed(FIXTURE);
    p.end();

    // Find the indices of events that should be attributed to forge-executor.
    // After the Task tool_use, all events until its tool_result belong to it.
    const taskUseIdx = events.findIndex((e) =>
      e.type === 'assistant' && e.message && e.message.content &&
      e.message.content.some((b) => b.type === 'tool_use' && b.name === 'Task')
    );
    assert.ok(taskUseIdx >= 0, 'expected to find Task tool_use event');

    const taskResultIdx = events.findIndex((e) =>
      e.type === 'user' && e.message && e.message.content &&
      e.message.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_task_01')
    );
    assert.ok(taskResultIdx > taskUseIdx, 'task result should come after task use');

    // Events between (exclusive) the Task push and (inclusive) the matching
    // result are attributed to forge-executor at the moment of dispatch.
    assert.strictEqual(agents[taskUseIdx], 'forge-executor', 'Task event should already be attributed');
    for (let i = taskUseIdx + 1; i < taskResultIdx; i++) {
      assert.strictEqual(agents[i], 'forge-executor',
        `event ${i} (type=${events[i].type}) should be forge-executor, got ${agents[i]}`);
    }
    // After the matching result pops the stack, attribution returns to main.
    assert.strictEqual(agents[agents.length - 1], 'main', 'final event should be main');
  },

  'extracts tokens from result event'() {
    const { p } = makeParser();
    p.feed(FIXTURE);
    p.end();
    assert.strictEqual(p.latest.tokens.input, 8420);
    assert.strictEqual(p.latest.tokens.output, 1230);
    assert.strictEqual(p.latest.tokens.cache_read, 4100);
  },

  'logs malformed JSON lines without crashing'() {
    const { p, events } = makeParser();
    p.feed('{"type":"system","subtype":"init"}\n');
    p.feed('not valid json\n');
    p.feed('{"type":"result","usage":{"input_tokens":100}}\n');
    p.end();
    assert.strictEqual(events.length, 2, 'malformed line should be skipped');
  },

  'fires onFatal after 3 consecutive parse errors'() {
    let fatal = null;
    const p = new StreamParser({
      forgeDir: path.join(__dirname, '..', '..', '.forge'),
      onEvent: () => {},
      onFatal: (err) => { fatal = err; },
    });
    p.feed('garbage1\n');
    p.feed('garbage2\n');
    p.feed('garbage3\n');
    assert.ok(fatal, 'expected onFatal to fire');
    assert.ok(/3 consecutive parse errors/.test(fatal.message));
  },

  'consecutive error counter resets on a valid line'() {
    let fatal = null;
    const p = new StreamParser({
      forgeDir: path.join(__dirname, '..', '..', '.forge'),
      onEvent: () => {},
      onFatal: (err) => { fatal = err; },
    });
    p.feed('garbage1\n');
    p.feed('garbage2\n');
    p.feed('{"type":"system","subtype":"init"}\n'); // resets
    p.feed('garbage3\n');
    p.feed('garbage4\n');
    assert.strictEqual(fatal, null, 'should not fire — counter reset by valid line');
  },
};
