import { z } from 'zod';
import type { ToolDefinition, ToolOutcome } from '../../core/types.js';
import { toErrorResult } from '../../core/types.js';
import { errorMessage } from '../../core/errors.js';
import type { A2AAgentClient } from './http-agent-client.js';
import type { A2AAgentCard } from './a2a-types.js';

/**
 * A2A → 子 agent 传输，落成一个 `delegate` 工具（ADR-0005）。
 *
 * 主循环看到的只是「调用一个工具」：入参是任务描述（多 agent 时还要点名），
 * 内部走 A2A 的发现 + `message/send`。协议对 `core/` 完全不可见。
 */
export interface DelegateToolOptions {
  /** 工具名，默认 `delegate` */
  name?: string;
  /**
   * 是否要人工确认。默认否：委派是「再问一个 agent」，不是对世界的写操作；
   * 真要写由被委派方自己的 HITL 管。
   */
  requiresConfirmation?: boolean;
}

interface DiscoveredAgent {
  client: A2AAgentClient;
  card?: A2AAgentCard;
  discoveryError?: string;
}

export async function createDelegateTool(
  clients: readonly A2AAgentClient[],
  options: DelegateToolOptions = {},
): Promise<ToolDefinition> {
  if (clients.length === 0) {
    throw new Error('createDelegateTool 需要至少一个远端 agent；没有 agent 就不该注册 delegate 工具');
  }

  const duplicates = findDuplicates(clients.map((client) => client.name));
  if (duplicates.length > 0) {
    throw new Error(`远端 agent 名字必须唯一，重复的有：${duplicates.join('、')}`);
  }

  const discovered = await Promise.all(
    clients.map(async (client): Promise<DiscoveredAgent> => {
      try {
        return { client, card: await client.card() };
      } catch (error) {
        // 发现失败不阻塞注册：描述里如实写明，调用时再给可读错误，别让一个掉线的 agent 拖垮整个 Harness
        return { client, discoveryError: errorMessage(error) };
      }
    }),
  );

  const single = discovered.length === 1;
  const definition: ToolDefinition = {
    name: options.name ?? 'delegate',
    description: describeDelegation(discovered, single),
    schema: single
      ? z.object({ task: z.string().describe('要委派给远端 agent 的子任务，写清目标与约束') })
      : z.object({
          agent: z.enum(discovered.map((entry) => entry.client.name) as [string, ...string[]]).describe(
            `要委派给哪个 agent，只能是：${discovered.map((entry) => entry.client.name).join('、')}`,
          ),
          task: z.string().describe('要委派给远端 agent 的子任务，写清目标与约束'),
        }),
    handler: async (args: { agent?: string; task: string }, ctx) => delegate(discovered, single, args, ctx.signal),
    requiresConfirmation: options.requiresConfirmation ?? false,
  };

  return definition;
}

async function delegate(
  discovered: readonly DiscoveredAgent[],
  single: boolean,
  args: { agent?: string; task: string },
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  const available = discovered.map((entry) => entry.client.name);

  let target: DiscoveredAgent | undefined;
  if (single) {
    target = discovered[0];
  } else {
    target = discovered.find((entry) => entry.client.name === args.agent);
  }
  if (!target) {
    // 多 agent 时 zod 枚举已经挡了一层，这里兜底给模型可读的候选列表
    return toErrorResult(
      `没有名为 "${args.agent ?? '(未指定)'}" 的远端 agent。可用的是：${available.join('、')}。请从中选一个，不要编造。`,
    );
  }

  const task = args.task?.trim();
  if (!task) {
    return toErrorResult(`委派给 "${target.client.name}" 的任务描述是空的，请写清楚要它做什么。`);
  }

  try {
    const reply = await target.client.send(task, signal ? { signal } : undefined);
    return `【远端 agent "${target.client.name}" 的回复】\n${reply}`;
  } catch (error) {
    return toErrorResult(
      `委派给远端 agent "${target.client.name}" 失败：${errorMessage(error)}。` +
        `可以稍后重试，或不要委派、直接自己完成这一步。`,
    );
  }
}

function describeDelegation(discovered: readonly DiscoveredAgent[], single: boolean): string {
  const lines = discovered.map((entry) => {
    if (entry.discoveryError) {
      return `- ${entry.client.name}：发现失败（${entry.discoveryError}），调用时很可能同样失败`;
    }
    const card = entry.card;
    const parts = [`${card?.name ?? entry.client.name}`];
    if (card?.version) parts.push(`v${card.version}`);
    const headline = card?.description ? `：${card.description}` : '';
    const skills = card?.skills?.length
      ? `。技能：${card.skills.map((skill) => (skill.tags?.length ? `${skill.name}（${skill.tags.join('/')}）` : skill.name)).join('、')}`
      : '';
    return `- ${entry.client.name}（${parts.join(' ')}）${headline}${skills}`;
  });

  const pick = single
    ? '只有一个远端 agent，不需要点名。'
    : '多个 agent 时必须用 `agent` 点名，且只能用上面列出的名字；编造的名字会被本地校验打回。';

  return [
    '把一个独立的子任务委派给远端 A2A agent，返回它的文本回复。适合把可并行的调研、翻译、检索类子任务交出去。',
    '',
    '可用 agent：',
    ...lines,
    '',
    pick,
  ].join('\n');
}

function findDuplicates(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return [...duplicates];
}
