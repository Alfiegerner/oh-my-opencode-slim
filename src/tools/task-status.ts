import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { listChildInputWaits } from '../hooks/task-session-manager/child-input-wait';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { getRuntimeSessionStatusSnapshot } from '../utils/session-runtime-status';
import type { TaskActivityTracker } from './task-activity';
import { observationFromSnapshot, summarizeTaskStatus } from './task-policy';

const z = tool.schema;
const ACTIVE_STATES = new Set(['busy', 'running', 'retry']);

export function createTaskStatusTool(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  activityTracker?: TaskActivityTracker;
  now?: () => number;
  statusTimeoutMs?: number;
}): Record<'task_status', ToolDefinition> {
  const task_status = tool({
    description:
      'Read the current status of a tracked child task without resuming, prompting, or changing it. Accepts its task ID or parent-scoped alias.',
    args: {
      task_id: z.string().describe('Tracked task ID or parent-scoped alias'),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_status requires sessionID');
      const requested = args.task_id.trim();
      if (!requested) throw new Error('task_status requires task_id');

      const job = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );
      if (!job) throw new Error(`Unknown task ID or alias: ${requested}`);

      // Bounded live read: a failed, malformed, or timed-out host status
      // response surfaces as explicit uncertainty instead of a confident
      // board-state fallback.
      const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
        timeoutMs: options.statusTimeoutMs,
      });
      const observation = observationFromSnapshot(snapshot, job.taskID);
      const now = options.now?.() ?? Date.now();
      const lastActivityAt =
        options.activityTracker?.lastActivityAt(job.taskID) ??
        job.lastLiveBusyAt ??
        job.runStartedAt;
      const report = summarizeTaskStatus(job, observation, lastActivityAt, now);

      const details = [
        `Task ${job.alias} (${job.taskID})`,
        `state: ${report.state}${report.uncertain ? ' (unconfirmed)' : ''}`,
        `agent: ${job.agent}`,
        `last_activity_at: ${new Date(lastActivityAt).toISOString()}`,
        `idle_for_seconds: ${report.idleSeconds}`,
        `possibly_stuck: ${report.possiblyStuck}`,
      ];
      // A child parked on an open question/permission moves no tokens and
      // never finishes on its own: surface the block explicitly so the
      // parent answers it (task_reply) instead of waiting it out.
      for (const wait of listChildInputWaits(job.taskID)) {
        details.push(`waiting_input: true (${wait.kind} ${wait.requestID})`);
        details.push(
          `pending_${wait.kind}: ${formatPendingInput(wait.kind, wait.requestID, wait.questions, wait.permission, wait.patterns)}`,
        );
      }
      if (report.uncertain) {
        details.push('status_uncertain: true');
        if (report.lastStatusError) {
          details.push(`last_status_error: ${report.lastStatusError}`);
        }
      }
      if (!report.uncertain && ACTIVE_STATES.has(report.state)) {
        details.push('');
        details.push(
          '[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.',
        );
      }
      if (listChildInputWaits(job.taskID).length > 0) {
        details.push('');
        details.push(
          '[guidance]: The task is waiting for your input and cannot proceed until you answer. Use task_reply with the request ID above to answer or reject it.',
        );
      }
      return details.join('\n');
    },
  });

  return { task_status };
}

function formatPendingInput(
  kind: 'question' | 'permission',
  requestID: string,
  questions?: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
  }>,
  permission?: string,
  patterns?: string[],
): string {
  if (kind === 'permission') {
    const patternText =
      patterns && patterns.length > 0
        ? ` patterns: ${patterns.join(', ')}`
        : '';
    return `${requestID} permission: ${permission ?? 'unknown'}${patternText}`;
  }
  if (!questions || questions.length === 0) return requestID;
  const rendered = questions
    .map((entry) => {
      const options =
        entry.options.length > 0
          ? ` [${entry.options.map((option) => option.label).join(' / ')}]`
          : '';
      const header = entry.header ? `${entry.header}: ` : '';
      return `${header}${entry.question}${options}`;
    })
    .join('; ');
  return `${requestID} ${rendered}`;
}
