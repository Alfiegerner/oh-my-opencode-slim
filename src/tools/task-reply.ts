import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import {
  clearChildInputWait,
  getChildInputWait,
  listChildInputWaits,
} from '../hooks/task-session-manager/child-input-wait';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { getClient } from '../utils/opencode-client';
import { OperationTimeoutError, withTimeout } from '../utils/session';

const z = tool.schema;
const DEFAULT_REPLY_TIMEOUT_MS = 10_000;
const MAX_ANSWER_LENGTH = 2000;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Answer (or reject) a background child's pending question/permission.
 *
 * A background child that calls the `question` tool parks with no tokens
 * moving until the host's question.reply/reject API resolves the request —
 * a `task_message` text nudge does NOT unblock it. This tool performs the
 * actual reply through the host client, scoped to the calling parent's own
 * tracked children: the task must resolve under the parent session and
 * have a recorded open ask for the given request id.
 */
export function createTaskReplyTool(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  replyTimeoutMs?: number;
}): Record<'task_reply', ToolDefinition> {
  const task_reply = tool({
    description:
      'Answer a tracked background child task waiting on a question or permission request. Resolves the pending request through the host so the child can proceed. Accepts the task ID or parent-scoped alias plus the request ID from the wake or task_status.',
    args: {
      task_id: z
        .string()
        .describe('Tracked live task ID or parent-scoped alias'),
      request_id: z
        .string()
        .describe('Open question/permission request ID to answer'),
      answers: z
        .array(z.string().max(MAX_ANSWER_LENGTH))
        .optional()
        .describe(
          'Answers for a question request, in question order (each entry selects option labels). Omit to reject the request instead of answering it.',
        ),
      reply: z
        .enum(['once', 'always', 'reject'])
        .optional()
        .describe(
          'Response for a permission request: once, always, or reject. Defaults to once.',
        ),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_reply requires sessionID');

      const requested = args.task_id.trim();
      if (!requested) throw new Error('task_reply requires task_id');
      const requestID = args.request_id.trim();
      if (!requestID) throw new Error('task_reply requires request_id');

      const job = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );
      if (!job) throw new Error(`Unknown task ID or alias: ${args.task_id}`);
      if (job.state !== 'running') {
        throw new Error(
          `Task ${requested} cannot be answered: board state is ${job.state}, not running`,
        );
      }

      const wait = getChildInputWait(job.taskID, requestID);
      if (!wait) {
        const open = listChildInputWaits(job.taskID);
        const hint =
          open.length > 0
            ? ` Open requests for this task: ${open.map((entry) => entry.requestID).join(', ')}.`
            : ' This task has no open question or permission requests.';
        throw new Error(
          `Task ${requested} has no open request ${requestID}.${hint}`,
        );
      }

      const client = getClient(options.input) as unknown as {
        question?: {
          reply: (args: Record<string, unknown>) => Promise<unknown>;
          reject: (args: Record<string, unknown>) => Promise<unknown>;
        };
        permission?: {
          reply: (args: Record<string, unknown>) => Promise<unknown>;
        };
      };
      const timeoutMs = Math.max(
        1,
        options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS,
      );

      try {
        if (wait.kind === 'question') {
          const question = client.question;
          if (typeof question?.reply !== 'function') {
            throw new Error(
              'Host client has no question.reply API; cannot answer the pending question',
            );
          }
          if (!args.answers || args.answers.length === 0) {
            if (typeof question?.reject !== 'function') {
              throw new Error(
                'Host client has no question.reject API; cannot reject the pending question',
              );
            }
            await withTimeout(
              question.reject({
                requestID: wait.requestID,
                directory: options.input.directory,
              }),
              timeoutMs,
              `Question reject timed out after ${timeoutMs}ms`,
            );
            return `Rejected pending question ${wait.requestID} for ${job.alias} (${job.taskID}).`;
          }
          await withTimeout(
            question.reply({
              requestID: wait.requestID,
              directory: options.input.directory,
              answers: args.answers.map((answer) => [answer]),
            }),
            timeoutMs,
            `Question reply timed out after ${timeoutMs}ms`,
          );
          return `Answered pending question ${wait.requestID} for ${job.alias} (${job.taskID}).`;
        }

        const permission = client.permission;
        if (typeof permission?.reply !== 'function') {
          throw new Error(
            'Host client has no permission.reply API; cannot answer the pending permission request',
          );
        }
        await withTimeout(
          permission.reply({
            requestID: wait.requestID,
            directory: options.input.directory,
            reply: args.reply ?? 'once',
          }),
          timeoutMs,
          `Permission reply timed out after ${timeoutMs}ms`,
        );
        return `Replied ${args.reply ?? 'once'} to pending permission ${wait.requestID} for ${job.alias} (${job.taskID}).`;
      } catch (error) {
        if (error instanceof OperationTimeoutError) throw error;
        throw new Error(`Task reply transport failed: ${errorText(error)}`);
      } finally {
        // The host emits question.replied/rejected (or permission.replied)
        // on success, which clears the sidecar via the event path. Clear
        // here as well so a missed/slow event cannot re-wake the parent
        // for an already-answered ask; a failed transport leaves the ask
        // open on the host, and the next ask event re-records it.
        clearChildInputWait(job.taskID, wait.requestID);
      }
    },
  });

  return { task_reply };
}
