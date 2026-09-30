import {
  createTask,
  deleteTask,
  getIterationGantt,
  listMemberTasks,
  listRequirementTasks,
  TASK_FLAGS,
  TASK_STATUSES,
  updateTask,
} from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson } from '../http';

// 长度、半天单位、进度范围等由服务校验并给出中文原因，这里只校验类型
const taskPatch = z.object({
  title: z.string().optional(),
  alias: z.string().nullable().optional(),
  assigneeMemberId: z.string().nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  planStart: z.string().nullable().optional(),
  planDays: z.number().nullable().optional(),
  delayDays: z.number().nullable().optional(),
  phase: z.string().nullable().optional(),
  flag: z.enum(TASK_FLAGS).nullable().optional(),
  starred: z.boolean().optional(),
  note: z.string().nullable().optional(),
  progress: z.number().nullable().optional(),
});

export function registerTaskRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/iterations/:id/gantt', async (c) => c.json({ gantt: await getIterationGantt(deps.db, c.get('actor'), c.req.param('id')) }));

  app.get('/orgs/:org/requirements/:id/tasks', async (c) => c.json({ tasks: await listRequirementTasks(deps.db, c.get('actor'), c.req.param('id')) }));

  app.get('/orgs/:org/members/:id/tasks', async (c) =>
    c.json(await listMemberTasks(deps.db, c.get('actor'), c.req.param('id'), { includeFinished: c.req.query('all') === '1' })),
  );

  app.post('/orgs/:org/tasks', async (c) => {
    const body = await readJson(
      c,
      taskPatch.extend({
        title: z.string(),
        iterationId: z.string().nullable().optional(),
        requirementId: z.string().nullable().optional(),
        productId: z.string().nullable().optional(),
      }),
    );
    return c.json({ task: await createTask(deps.db, c.get('actor'), body) }, 201);
  });

  app.patch('/orgs/:org/tasks/:id', async (c) => {
    const body = await readJson(c, taskPatch);
    return c.json({ task: await updateTask(deps.db, c.get('actor'), c.req.param('id'), body) });
  });

  app.delete('/orgs/:org/tasks/:id', async (c) => {
    await deleteTask(deps.db, c.get('actor'), c.req.param('id'));
    return c.body(null, 204);
  });
}
