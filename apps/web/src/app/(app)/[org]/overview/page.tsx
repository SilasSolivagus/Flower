'use client';

import { CheckCircle2, Circle } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { LoadError } from '@/components/load-error';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { computeChecklist } from '@/features/overview/checklist';
import { isOrgAdminRole } from '@/features/shell/nav';
import { PRODUCT_ROLE_LABEL } from '@/lib/labels';
import { useFields, useInvitations, useMembers, useOrg, useProducts, useTokens, useWorkflows } from '@/lib/queries';
import { cn } from '@/lib/utils';

function Checklist({ org }: { org: string }) {
  const members = useMembers(org);
  const invitations = useInvitations(org);
  const products = useProducts(org);
  const workflows = useWorkflows(org);
  const fields = useFields(org);
  const tokens = useTokens(org);
  const all = [members, invitations, products, workflows, fields, tokens];
  if (all.some((q) => !q.data)) return null;
  const items = computeChecklist(org, {
    members: members.data!,
    invitations: invitations.data!,
    products: products.data!,
    workflows: workflows.data!,
    fields: fields.data!,
    tokens: tokens.data!,
  });
  const done = items.filter((i) => i.done).length;
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="font-semibold">组织配置清单</h2>
        <span className="font-mono text-xs text-muted-foreground">
          已完成 {done} / {items.length}
        </span>
      </div>
      <ul aria-label="组织配置清单" className="divide-y">
        {items.map((i) => (
          <li key={i.key}>
            <Link href={i.href} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted">
              {i.done ? (
                <CheckCircle2 className="size-4 text-primary" aria-label="已完成" />
              ) : (
                <Circle className="size-4 text-muted-foreground" aria-label="未完成" />
              )}
              <span className={cn('w-32 font-medium', i.done && 'text-muted-foreground line-through')}>{i.label}</span>
              <span className="text-[13px] text-muted-foreground">{i.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function OrgOverviewPage() {
  const { org } = useParams<{ org: string }>();
  const q = useOrg(org);
  const products = useProducts(org);
  if (!q.data) return null;
  const admin = isOrgAdminRole(q.data.me.orgRole);
  return (
    <>
      <PageHeader title={q.data.org.name} description={admin ? '按清单完成组织配置后，团队就可以开始使用。' : '你可以访问的产品'} />
      {admin && <Checklist org={org} />}
      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">产品</h2>
        {!products.data ? (
          products.isError ? (
            <LoadError message="加载产品失败，请重试。" onRetry={() => products.refetch()} />
          ) : (
            <Skeleton className="h-16" />
          )
        ) : products.data.length === 0 ? (
          <p className="text-muted-foreground">还没有产品。</p>
        ) : (
          <ul className="grid grid-cols-3 gap-3">
            {products.data.map((p) => (
              <li key={p.id} className="flex flex-col gap-1">
                <Link
                  href={`/${org}/requirements?product=${p.key}`}
                  className="flex items-center justify-between rounded-lg border bg-card px-4 py-3 hover:border-primary"
                >
                  <span>
                    <span className="mr-2 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">{p.key}</span>
                    {p.name}
                  </span>
                  <span className="text-xs text-muted-foreground">{PRODUCT_ROLE_LABEL[p.myRole]}</span>
                </Link>
                {p.myRole === 'admin' && !admin && (
                  <Link href={`/${org}/settings/products/${p.id}`} aria-label={`${p.name} 产品设置`} className="self-end text-xs text-primary hover:underline">
                    产品设置
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
