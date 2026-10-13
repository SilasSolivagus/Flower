import type { CategoryOf, RawRequirement, RawTransition, StateCategory } from '../src/dashboard/metrics';

export const SH = 'Asia/Shanghai';

const CATEGORY: Record<string, StateCategory> = {
  backlog: 'backlog',
  todo: 'unstarted',
  doing: 'started',
  testing: 'started',
  done: 'completed',
  accepted: 'completed',
  canceled: 'canceled',
};

/** 测试用的状态类别：两个进行中类（doing、testing）、两个完成类（done、accepted）。 */
export const categoryOf: CategoryOf = (key) => CATEGORY[key] ?? 'backlog';

/** 构造需求：created 为创建时刻，steps 为依次进入的状态与时刻（ISO，带时区）；当前状态为最后一步。 */
export function req(id: string, created: string, steps: Array<[string, string]>): RawRequirement {
  const transitions: RawTransition[] = [{ fromState: null, toState: 'backlog', at: new Date(created) }];
  let prev = 'backlog';
  for (const [to, when] of steps) {
    transitions.push({ fromState: prev, toState: to, at: new Date(when) });
    prev = to;
  }
  return { id, createdAt: new Date(created), stateKey: prev, transitions };
}
