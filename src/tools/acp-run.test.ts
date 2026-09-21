import { describe, expect, test } from 'bun:test';
import packageJson from '../../package.json' with { type: 'json' };
import { createAcpInitializeParams, trackProgress } from './acp-run';

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
    let rendered;
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
});
