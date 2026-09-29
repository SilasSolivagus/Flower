import { ShieldOff } from 'lucide-react';

export function NoAccess({ message = '你没有访问这个页面的权限。如需开通，请联系组织管理员。' }: { message?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-center">
      <ShieldOff className="size-8 text-muted-foreground" aria-hidden="true" />
      <h1 className="text-lg font-semibold">无权访问</h1>
      <p className="max-w-sm text-muted-foreground">{message}</p>
    </div>
  );
}
