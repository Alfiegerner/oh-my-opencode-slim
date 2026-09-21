import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
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
});
