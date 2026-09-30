import { isRecord } from '../core/record.js';
import type { AgentRole } from './role.js';

/**
 * 计划的结构。
 *
 * 为什么用 JSON 而不是模型自由书写的清单：原型的复盘笔记第一条教训就是
 * 「围栏协议无法自证边界」—— 模型把边界写歪，解析器只能猜。JSON 有唯一的结构边界，
 * 抽取失败时也能明确地失败，而不是悄悄截掉一半。
 */
export interface PlanStep {
  id: string;
  /** 角色名，必须是已注册角色 */
  role: string;
  task: string;
  /** 依赖的步骤 id；列出的步骤都成功了才轮到本步 */
  dependsOn?: readonly string[];
}

export interface Plan {
  goal: string;
  steps: readonly PlanStep[];
}

export interface ParsePlanOptions {
  roles: readonly AgentRole[];
  /** 步骤上限，默认 6。计划越长越容易失控，宁可拆两次。 */
  maxSteps?: number;
}

export type ParsePlanResult =
  | { ok: true; plan: Plan; repaired: boolean }
  | { ok: false; detail: string };

/** 计划步骤上限。提示词与校验共用同一个数，改一处即可。 */
export const DEFAULT_MAX_STEPS = 6;

/**
 * 校验并规范化一份计划。**纯函数，不降级、不抛异常。**
 *
 * 「解析归解析，策略归调用方」是原型复盘的第一条教训：兜底逻辑一旦写进解析函数，
 * 调用方就再也分不清拿到的是模型写的还是兜底生成的。所以这里只回答「这份计划合法吗」，
 * 不合法就如实说不合法——要不要退化成单步计划，是 `Supervisor` 的决定。
 *
 * 唯一的例外是补齐缺失的 `id`：那是纯规范化（按序号命名），且会通过 `repaired` 如实上报。
 */
export function parsePlan(value: unknown, options: ParsePlanOptions): ParsePlanResult {
  const roles = new Set(options.roles.map((role) => role.name));
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;

  if (!isRecord(value)) return { ok: false, detail: '计划必须是一个 JSON 对象' };

  const goal = typeof value.goal === 'string' ? value.goal.trim() : '';
  if (!goal) return { ok: false, detail: '计划的 goal 必须是非空字符串' };

  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    return { ok: false, detail: '计划的 steps 必须是非空数组' };
  }
  if (value.steps.length > maxSteps) {
    return { ok: false, detail: `计划有 ${value.steps.length} 步，超过上限 ${maxSteps} 步；请拆成更少、更聚焦的步骤` };
  }

  let repaired = false;
  const steps: PlanStep[] = [];
  const ids = new Set<string>();

  for (const [index, raw] of value.steps.entries()) {
    if (!isRecord(raw)) return { ok: false, detail: `第 ${index + 1} 步不是对象` };

    const task = typeof raw.task === 'string' ? raw.task.trim() : '';
    if (!task) return { ok: false, detail: `第 ${index + 1} 步的 task 是空的` };

    const role = typeof raw.role === 'string' ? raw.role.trim() : '';
    if (!role) return { ok: false, detail: `第 ${index + 1} 步没有 role` };
    if (!roles.has(role)) {
      return {
        ok: false,
        detail: `第 ${index + 1} 步用了不存在的角色 "${role}"；可用角色：${[...roles].join('、')}`,
      };
    }

    let id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id) {
      id = `s${index + 1}`;
      repaired = true;
    }
    if (ids.has(id)) return { ok: false, detail: `步骤 id "${id}" 重复` };
    ids.add(id);

    const dependsOn = readDependsOn(raw.dependsOn);
    if (dependsOn === INVALID_DEPENDS_ON) {
      return { ok: false, detail: `第 ${index + 1} 步的 dependsOn 必须是字符串数组` };
    }

    steps.push(dependsOn.length > 0 ? { id, role, task, dependsOn } : { id, role, task });
  }

  for (const step of steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (dependency === step.id) return { ok: false, detail: `步骤 "${step.id}" 依赖了自己` };
      if (!ids.has(dependency)) {
        return { ok: false, detail: `步骤 "${step.id}" 依赖了不存在的步骤 "${dependency}"` };
      }
    }
  }

  const cycle = findCycle(steps);
  if (cycle) return { ok: false, detail: `步骤依赖成环：${cycle.join(' → ')}` };

  return { ok: true, plan: { goal, steps }, repaired };
}

const INVALID_DEPENDS_ON = Symbol('invalid-depends-on');

function readDependsOn(value: unknown): string[] | typeof INVALID_DEPENDS_ON {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return INVALID_DEPENDS_ON;
  if (value.some((item) => typeof item !== 'string')) return INVALID_DEPENDS_ON;
  return value.map((item) => (item as string).trim()).filter((item) => item.length > 0);
}

/** 深度优先找环，返回环上的 id 序列；没有环返回 null。 */
function findCycle(steps: readonly PlanStep[]): string[] | null {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    const loopAt = path.indexOf(id);
    if (loopAt !== -1) return [...path.slice(loopAt), id];
    if (visited.has(id)) return null;

    path.push(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    visited.add(id);
    return null;
  };

  for (const step of steps) {
    const cycle = visit(step.id);
    if (cycle) return cycle;
  }
  return null;
}
