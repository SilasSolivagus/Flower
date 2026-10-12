'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChannelsTab } from './channels-tab';
import { DeliveriesTab } from './deliveries-tab';
import { PersonalEmailChannel } from './personal-email-channel';
import { ScheduleList } from './schedule-list';
import { TemplatesTab } from './templates-tab';
import { WecomAppTab } from './wecom-app-tab';

const TABS = ['channels', 'schedules', 'templates', 'deliveries', 'wecom'];

function NotificationsPage() {
  const { org } = useParams<{ org: string }>();
  const tab = useSearchParams().get('tab') ?? '';
  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '推送' }]}
        title="推送"
        description="登记群机器人、Webhook 与邮件通道，维护消息模板，查看定时推送与发送记录，配置企业微信扫码绑定。事件规则与个人提醒通道在各产品设置的「推送」页签配置。"
      />
      <Tabs defaultValue={TABS.includes(tab) ? tab : 'channels'}>
        <TabsList>
          <TabsTrigger value="channels">通道</TabsTrigger>
          <TabsTrigger value="schedules">定时推送</TabsTrigger>
          <TabsTrigger value="templates">消息模板</TabsTrigger>
          <TabsTrigger value="deliveries">发送记录</TabsTrigger>
          <TabsTrigger value="wecom">企业微信应用</TabsTrigger>
        </TabsList>
        <TabsContent value="channels" className="flex flex-col gap-6">
          <ChannelsTab org={org} />
          <PersonalEmailChannel org={org} />
        </TabsContent>
        <TabsContent value="schedules">
          <ScheduleList org={org} />
        </TabsContent>
        <TabsContent value="templates">
          <TemplatesTab org={org} />
        </TabsContent>
        <TabsContent value="deliveries">
          <DeliveriesTab org={org} />
        </TabsContent>
        <TabsContent value="wecom">
          <WecomAppTab org={org} />
        </TabsContent>
      </Tabs>
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <RequireOrgAdmin>
        <NotificationsPage />
      </RequireOrgAdmin>
    </Suspense>
  );
}
