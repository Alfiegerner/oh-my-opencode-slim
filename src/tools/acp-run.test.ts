import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import packageJson from '../../package.json' with { type: 'json' };
import {
  createAcpInitializeParams,
  createAcpRunTool,
  trackProgress,
} from './acp-run';

describe('ACP initialize payload', () => {
  test('sends protocol-compliant client implementation information', () => {
    const params = createAcpInitializeParams();

    expect(params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: 'oh-my-opencode-slim',
        version: packageJson.version,
      },
    });
    expect(params.clientInfo).not.toHaveProperty('title');
  });
});

describe('trackProgress', () => {
  test('streams tool_call state and replaces on tool_call_update', () => {
    const progress = new Map<string, string>();
    const first = trackProgress(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Read src/server.js',
        status: 'in_progress',
      },
      progress,
    );
    expect(first?.title).toBe('▸ Read src/server.js');
    const second = trackProgress(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        title: 'Read src/server.js',
        status: 'completed',
      },
      progress,
    );
    expect(second?.title).toBe('✓ Read src/server.js');
    expect(second?.progress).toBe('✓ Read src/server.js');
  });

  test('renders plan entries as a block with the last line as title', () => {
    const rendered = trackProgress(
      {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read files', status: 'completed' },
          { content: 'Edit card action', status: 'in_progress' },
          { content: 'Run tests', status: 'pending' },
        ],
      },
      new Map(),
    );
    expect(rendered?.progress).toBe(
      '✓ Read files\n▸ Edit card action\n○ Run tests',
    );
    expect(rendered?.title).toBe('○ Run tests');
  });

  test('ignores non-progress updates and malformed entries', () => {
    expect(
      trackProgress({ sessionUpdate: 'agent_message_chunk' }, new Map()),
    ).toBeUndefined();
    expect(
      trackProgress({ sessionUpdate: 'tool_call' }, new Map()),
    ).toBeUndefined();
    expect(
      trackProgress(
        { sessionUpdate: 'plan', entries: [{ status: 'pending' }] },
        new Map(),
      ),
    ).toBeUndefined();
  });

  test('caps the rolling log and reports only the tail', () => {
    const progress = new Map<string, string>();
    let rendered: { title: string; progress: string } | undefined;
    for (let i = 0; i < 45; i++) {
      rendered = trackProgress(
        {
          sessionUpdate: 'tool_call',
          toolCallId: `t${i}`,
          title: `call ${i}`,
          status: 'in_progress',
        },
        progress,
      );
    }
    expect(progress.size).toBe(40);
    expect(rendered?.progress.split('\n')).toHaveLength(20);
    expect(rendered?.progress).toContain('call 44');
    expect(rendered?.progress).not.toContain('call 15\n');
  });

  test('status-only tool_call_update preserves the previous title', () => {
    const progress = new Map<string, string>();
    trackProgress(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Read src/server.js',
        status: 'in_progress',
      },
      progress,
    );
    const completed = trackProgress(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
      },
      progress,
    );
    expect(completed?.title).toBe('✓ Read src/server.js');
  });

  test('a fresh title on tool_call_update replaces the previous one', () => {
    const progress = new Map<string, string>();
    trackProgress(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Read src/server.js',
        status: 'in_progress',
      },
      progress,
    );
    const renamed = trackProgress(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        title: 'Read src/server.ts',
        status: 'completed',
      },
      progress,
    );
    expect(renamed?.title).toBe('✓ Read src/server.ts');
  });

  test('updating an old call moves it into the tail', () => {
    const progress = new Map<string, string>();
    trackProgress(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'old call',
        status: 'in_progress',
      },
      progress,
    );
    for (let i = 2; i <= 30; i++) {
      trackProgress(
        {
          sessionUpdate: 'tool_call',
          toolCallId: `t${i}`,
          title: `call ${i}`,
          status: 'in_progress',
        },
        progress,
      );
    }
    const completed = trackProgress(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        title: 'old call',
        status: 'completed',
      },
      progress,
    );
    expect(completed?.title).toBe('✓ old call');
    const tailLines = (completed?.progress ?? '').split('\n');
    expect(tailLines).toHaveLength(20);
    expect(tailLines.at(-1)).toBe('✓ old call');
  });

  test('a plan longer than the tail is truncated to the last lines', () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      content: `step ${i + 1}`,
      status: 'pending',
    }));
    const rendered = trackProgress(
      { sessionUpdate: 'plan', entries },
      new Map(),
    );
    const tailLines = (rendered?.progress ?? '').split('\n');
    expect(tailLines).toHaveLength(20);
    expect(tailLines[0]).toBe('○ step 6');
    expect(tailLines.at(-1)).toBe('○ step 25');
  });
});

describe('acp_run integration', () => {
  test('streams tool progress through ctx.metadata and returns final text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-progress-'));
    const serverPath = join(dir, 'server.js');
    await writeFile(
      serverPath,
      [
        'let seen = 0; let buf = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => {',
        '  buf += chunk; let idx;',
        '  while ((idx = buf.indexOf("\\n")) >= 0) {',
        '    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        '    seen++;',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: seen === 2 ? { sessionId: "sess-t" } : {} }) + "\\n");',
        '    if (seen === 2) {',
        '      const updates = [',
        '        { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read src/server.js", status: "in_progress" },',
        '        { sessionUpdate: "tool_call_update", toolCallId: "t1", title: "Read src/server.js", status: "completed" },',
        '        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },',
        '      ];',
        '      for (const update of updates) {',
        '        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update } }) + "\\n");',
        '      }',
        '    }',
        '  }',
        '});',
        'process.stdin.on("end", () => process.exit(0));',
      ].join('\n'),
    );

    const metadataCalls: Array<{
      title?: string;
      metadata?: Record<string, unknown>;
    }> = [];
    const tool = createAcpRunTool({
      cursor: {
        command: process.execPath,
        args: [serverPath],
        permissionMode: 'allow',
      },
    });
    const result = await tool.execute(
      { agent: 'cursor', prompt: 'hi' } as never,
      {
        sessionID: 's',
        messageID: 'm',
        agent: 'cursor',
        directory: dir,
        worktree: dir,
        abort: new AbortController().signal,
        metadata: (input: {
          title?: string;
          metadata?: Record<string, unknown>;
        }) => {
          metadataCalls.push(input);
        },
        ask: async () => {},
      } as never,
    );

    expect(result).toBe('done');
    expect(metadataCalls.length).toBe(2);
    expect(metadataCalls[0]?.title).toBe('▸ Read src/server.js');
    expect(metadataCalls[1]?.title).toBe('✓ Read src/server.js');
    expect(metadataCalls[1]?.metadata?.progress).toBe('✓ Read src/server.js');
  }, 15_000);

  test('waits for graceful bridge shutdown after a timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-shutdown-'));
    const serverPath = join(dir, 'server.js');
    const eventsPath = join(dir, 'events.log');
    await writeFile(
      serverPath,
      [
        'const fs = require("node:fs");',
        'let buf = "";',
        `const eventsPath = ${JSON.stringify(eventsPath)};`,
        'const record = (event) => fs.appendFileSync(eventsPath, event + "\\n");',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => {',
        '  buf += chunk; let idx;',
        '  while ((idx = buf.indexOf("\\n")) >= 0) {',
        '    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        '    if (msg.method === "initialize") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");',
        '    } else if (msg.method === "session/new") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-timeout" } }) + "\\n");',
        '    } else if (msg.method === "session/prompt") {',
        '      record("prompt");',
        '    } else if (msg.method === "session/cancel") {',
        '      record("cancel");',
        '    }',
        '  }',
        '});',
        'process.stdin.on("end", () => {',
        '  record("eof");',
        '  setTimeout(() => { record("exit"); process.exit(0); }, 100);',
        '});',
      ].join('\n'),
    );

    const tool = createAcpRunTool({
      cursor: {
        command: process.execPath,
        args: [serverPath],
        permissionMode: 'allow',
      },
    });

    await expect(
      tool.execute(
        { agent: 'cursor', prompt: 'wait', timeout_ms: 50 } as never,
        {
          sessionID: 's',
          messageID: 'm',
          agent: 'cursor',
          directory: dir,
          worktree: dir,
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as never,
      ),
    ).rejects.toThrow("ACP agent 'cursor' timed out after 50ms");

    expect(await readFile(eventsPath, 'utf8')).toBe(
      'prompt\ncancel\neof\nexit\n',
    );
  }, 15_000);

  test('abort settles while an ACP permission request is pending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-abort-permission-'));
    const serverPath = join(dir, 'server.js');
    const eventsPath = join(dir, 'events.log');
    await writeFile(
      serverPath,
      [
        'const fs = require("node:fs");',
        'let buf = "";',
        `const eventsPath = ${JSON.stringify(eventsPath)};`,
        'const record = (event) => fs.appendFileSync(eventsPath, event + "\\n");',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => {',
        '  buf += chunk; let idx;',
        '  while ((idx = buf.indexOf("\\n")) >= 0) {',
        '    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        '    if (msg.method === "initialize") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");',
        '    } else if (msg.method === "session/new") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-permission" } }) + "\\n");',
        '    } else if (msg.method === "session/prompt") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { permission: "write" } }) + "\\n");',
        '      record("permission");',
        '    } else if (msg.method === "session/cancel") {',
        '      record("cancel");',
        '    }',
        '  }',
        '});',
        'process.stdin.on("end", () => process.exit(0));',
      ].join('\n'),
    );

    const controller = new AbortController();
    let permissionStarted!: () => void;
    const permissionSeen = new Promise<void>((resolve) => {
      permissionStarted = resolve;
    });
    const tool = createAcpRunTool({
      cursor: {
        command: process.execPath,
        args: [serverPath],
        permissionMode: 'ask',
      },
    });
    const execution = tool.execute(
      { agent: 'cursor', prompt: 'wait', timeout_ms: 0 } as never,
      {
        sessionID: 's',
        messageID: 'm',
        agent: 'cursor',
        directory: dir,
        worktree: dir,
        abort: controller.signal,
        metadata: () => {},
        ask: async (input: { metadata?: Record<string, unknown> }) => {
          if (input.metadata?.permission === 'write') {
            permissionStarted();
            await new Promise(() => {});
          }
        },
      } as never,
    );

    await permissionSeen;
    controller.abort();
    await expect(
      Promise.race([
        execution,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('abort did not settle')), 2_000),
        ),
      ]),
    ).resolves.toBeDefined();
    expect(await readFile(eventsPath, 'utf8')).toContain('cancel\n');
  }, 15_000);

  test('a spawn failure does not wait through shutdown grace periods', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acp-spawn-error-'));
    const tool = createAcpRunTool({
      cursor: {
        command: join(dir, 'missing-acp-command'),
        args: [],
        permissionMode: 'allow',
      },
    });
    const startedAt = Date.now();

    await expect(
      tool.execute(
        { agent: 'cursor', prompt: 'hi' } as never,
        {
          sessionID: 's',
          messageID: 'm',
          agent: 'cursor',
          directory: dir,
          worktree: dir,
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as never,
      ),
    ).rejects.toThrow();

    expect(Date.now() - startedAt).toBeLessThan(1_500);
  }, 15_000);
});
