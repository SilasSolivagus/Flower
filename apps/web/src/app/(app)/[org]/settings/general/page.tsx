'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { LoadingBlock, QueryError } from '@/components/load-error';
import { NO_PERMISSION_MESSAGE } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { qk, useApiMutation, useOrg } from '@/lib/queries';

const TIMEZONES = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Tokyo', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'UTC'];

function GeneralPage() {
  const { org } = useParams<{ org: string }>();
  const q = useOrg(org);
  const [name, setName] = useState('');
  const [tz, setTz] = useState('Asia/Shanghai');
  const [nameTouched, setNameTouched] = useState(false);
  const [synced, setSynced] = useState<typeof q.data>(undefined);
  if (q.data && q.data !== synced) {
    setSynced(q.data);
    setName(q.data.org.name);
    setTz(q.data.org.settings.timezone ?? 'Asia/Shanghai');
  }
  const save = useApiMutation(() => api(`/orgs/${org}`, { method: 'PATCH', body: { name, timezone: tz } }), {
    invalidate: [qk.org(org), qk.me],
    success: '已保存',
  });
  if (q.isError) return <QueryError error={q.error} noAccessMessage={NO_PERMISSION_MESSAGE} retryMessage="加载组织信息失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return <LoadingBlock />;
  const nameBlank = name.trim() === '';
  return (
    <>
      <PageHeader crumbs={[{ label: '组织设置' }, { label: '组织信息' }]} title="组织信息" />
      <form
        className="flex max-w-lg flex-col gap-4 rounded-lg border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (nameBlank) {
            setNameTouched(true);
            return;
          }
          save.mutate(undefined);
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="g-name">组织名称</Label>
          <Input
            id="g-name"
            value={name}
            aria-invalid={nameTouched && nameBlank}
            onChange={(e) => {
              setNameTouched(true);
              setName(e.target.value);
            }}
          />
          {nameTouched && nameBlank && (
            <p role="alert" className="text-sm text-destructive">
              请填写组织名称
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>组织标识</Label>
          <Input value={q.data.org.slug} readOnly className="font-mono" />
          <span className="text-xs text-muted-foreground">标识出现在网址中，创建后不能修改。</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="g-tz">时区</Label>
          <Select value={tz} onValueChange={setTz}>
            <SelectTrigger id="g-tz">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from(new Set([tz, ...TIMEZONES])).map((z) => (
                <SelectItem key={z} value={z}>
                  {z}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" className="self-start" disabled={save.isPending || nameBlank}>
          保存
        </Button>
      </form>
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <GeneralPage />
    </RequireOrgAdmin>
  );
}
