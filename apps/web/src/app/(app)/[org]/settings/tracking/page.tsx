'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { QueryError } from '@/components/load-error';
import { NO_PERMISSION_MESSAGE } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { trackingKeys, useApiMutation, useTrackingSettings } from '@/lib/queries';

function DaysField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" inputMode="numeric" min={1} max={365} step={1} className="w-32 font-mono" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function TrackingSettingsPage() {
  const { org } = useParams<{ org: string }>();
  const q = useTrackingSettings(org);
  const [warnDays, setWarnDays] = useState('');
  const [alertDays, setAlertDays] = useState('');
  const [staleDays, setStaleDays] = useState('');
  const [synced, setSynced] = useState<typeof q.data>(undefined);
  if (q.data && q.data !== synced) {
    setSynced(q.data);
    setWarnDays(String(q.data.warnDays));
    setAlertDays(String(q.data.alertDays));
    setStaleDays(String(q.data.staleUpdateDays));
  }
  const save = useApiMutation(
    () =>
      api(`/orgs/${org}/tracking-settings`, {
        method: 'PUT',
        body: { warnDays: Number(warnDays), alertDays: Number(alertDays), staleUpdateDays: Number(staleDays) },
      }),
    { invalidate: [trackingKeys(org)], silentError: true, success: '已保存' },
  );
  if (q.isError) return <QueryError error={q.error} noAccessMessage={NO_PERMISSION_MESSAGE} retryMessage="加载跟进设置失败，请重试。" onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '跟进' }]}
        title="跟进"
        description="跟进页「任务老化」的阈值：本阶段停留（扣除暂停）超过标黄天数标黄、超过标红天数标红；超过无进展天数没有进展记录的条目单独列出。暂停中的条目不标色、不计无进展。"
      />
      <form
        className="flex max-w-lg flex-col gap-4 rounded-lg border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <DaysField id="tracking-warn" label="标黄：本阶段停留超过（天）" value={warnDays} onChange={setWarnDays} />
        <DaysField id="tracking-alert" label="标红：本阶段停留超过（天）" value={alertDays} onChange={setAlertDays} />
        <DaysField id="tracking-stale" label="无进展：超过（天）没有进展记录" value={staleDays} onChange={setStaleDays} />
        <FormError error={save.error} />
        <Button type="submit" className="self-start" disabled={save.isPending}>
          保存
        </Button>
      </form>
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <TrackingSettingsPage />
    </RequireOrgAdmin>
  );
}
