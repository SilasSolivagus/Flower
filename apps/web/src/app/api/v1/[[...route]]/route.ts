import { handle } from 'hono/vercel';
import { getApi } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handler(req: Request) {
  return handle(getApi())(req);
}

export { handler as DELETE, handler as GET, handler as PATCH, handler as POST, handler as PUT };
