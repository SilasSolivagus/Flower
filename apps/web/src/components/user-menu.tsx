'use client';

import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Monitor, Moon, Server, Settings, Sun } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { qk, useMe } from '@/lib/queries';

export function UserMenu() {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const { theme, setTheme } = useTheme();
  const account = me.data?.account;
  if (!account) return null;
  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    qc.clear();
    router.replace('/login');
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="个人菜单"
        className="flex items-center gap-2 rounded-md px-2 py-1.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-7 items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-foreground">
          {account.name.slice(0, 1)}
        </span>
        <span className="text-[13px] font-medium">{account.name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="font-medium">{account.name}</div>
          <div className="font-mono text-xs text-muted-foreground">{account.email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push('/settings')}>
          <Settings className="size-4" aria-hidden="true" />
          个人设置
        </DropdownMenuItem>
        {account.isInstanceAdmin && (
          <DropdownMenuItem onSelect={() => router.push('/admin')}>
            <Server className="size-4" aria-hidden="true" />
            实例设置
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">主题</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme ?? 'light'}
          onValueChange={(v) => {
            setTheme(v);
            if (v !== 'light' && v !== 'dark' && v !== 'system') return;
            void api('/me', { method: 'PATCH', body: { preferences: { theme: v } } }).then(() => {
              void qc.invalidateQueries({ queryKey: qk.me });
              toast.success('主题已写入个人设置');
            });
          }}
        >
          <DropdownMenuRadioItem value="light">
            <Sun className="size-4" aria-hidden="true" />
            浅色
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="size-4" aria-hidden="true" />
            深色
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor className="size-4" aria-hidden="true" />
            跟随系统
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logout}>
          <LogOut className="size-4" aria-hidden="true" />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
