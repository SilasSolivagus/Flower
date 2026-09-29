import {
  acceptInvitation,
  AppError,
  createInvitation,
  createSession,
  listInvitations,
  previewInvitation,
  revokeInvitation,
} from '@flower/core';
import { z } from 'zod';
import type { ApiDeps, App } from '../api';
import { readJson, sessionMeta, setSessionCookie } from '../http';

export function registerInvitationRoutes(app: App, deps: ApiDeps): void {
  app.get('/orgs/:org/invitations', async (c) => c.json({ invitations: await listInvitations(deps.db, c.get('actor')) }));

  app.post('/orgs/:org/invitations', async (c) => {
    const body = await readJson(
      c,
      z.object({ email: z.string().max(254), orgRole: z.enum(['admin', 'member', 'guest']), memberId: z.string().optional() }),
    );
    const { invitation, token } = await createInvitation(deps.db, c.get('actor'), body);
    return c.json({ invitation, token, link: `${deps.publicUrl}/invite/${token}` }, 201);
  });

  app.delete('/orgs/:org/invitations/:id', async (c) => {
    await revokeInvitation(deps.db, c.get('actor'), c.req.param('id'));
    return c.body(null, 204);
  });

  app.get('/invitations/:token', async (c) => {
    const preview = await previewInvitation(deps.db, c.req.param('token'));
    if (!preview) throw new AppError('not_found', '邀请不存在');
    return c.json(preview);
  });

  app.post('/invitations/:token/accept', async (c) => {
    const account = c.get('account');
    const body = await readJson(c, z.object({ name: z.string().optional(), password: z.string().max(256).optional() }));
    let who: Parameters<typeof acceptInvitation>[2];
    if (account) {
      who = { accountId: account.id };
    } else {
      if (!body.name || !body.password) throw new AppError('invalid', '请填写姓名和密码');
      who = { newAccount: { name: body.name, password: body.password } };
    }
    const r = await acceptInvitation(deps.db, c.req.param('token'), who);
    if (!account) {
      const s = await createSession(deps.db, r.accountId, sessionMeta(c));
      setSessionCookie(c, s.token, s.expiresAt, deps.secureCookies);
    }
    return c.json({ orgSlug: r.orgSlug });
  });
}
