'use client';

import { Box } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { RequireOrgAdmin } from '@/components/require-org-admin';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { qk, useApiMutation, useProducts } from '@/lib/queries';
import type { Product } from '@/lib/types';

function ProductsPage() {
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const products = useProducts(org);
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ name: '', key: '' });
  const create = useApiMutation(() => api<{ product: Product }>(`/orgs/${org}/products`, { method: 'POST', body: v }), {
    invalidate: [qk.products(org), qk.me],
    silentError: true,
    onSuccess: (d) => router.push(`/${org}/settings/products/${d.product.id}`),
  });
  return (
    <>
      <PageHeader
        crumbs={[{ label: '组织设置' }, { label: '产品' }]}
        title="产品"
        description="每个产品有自己的需求编号前缀、流程和字段配置。"
        actions={<Button onClick={() => setOpen(true)}>新建产品</Button>}
      />
      {products.data?.length === 0 ? (
        <EmptyState icon={Box} title="还没有产品" description="例如「网盘」，编号前缀 PAN，需求编号会显示为 PAN-123。" />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">前缀</TableHead>
                <TableHead>名称</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.data?.map((p) => (
                <TableRow key={p.id} className="h-10 even:bg-zebra">
                  <TableCell className="font-mono">{p.key}</TableCell>
                  <TableCell>
                    <Link href={`/${org}/settings/products/${p.id}`} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.status === 'active' ? '启用' : '已归档'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(undefined);
            }}
          >
            <DialogHeader>
              <DialogTitle>新建产品</DialogTitle>
              <DialogDescription>编号前缀创建后不能修改。新产品默认使用组织的第一个流程模板。</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="p-name">产品名称</Label>
              <Input id="p-name" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="p-key">编号前缀</Label>
              <Input id="p-key" required className="font-mono uppercase" value={v.key} onChange={(e) => setV({ ...v, key: e.target.value.toUpperCase() })} />
              <span className="text-xs text-muted-foreground">以字母开头，2–10 位大写字母或数字</span>
            </div>
            <FormError error={create.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={create.isPending}>
                创建
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function Page() {
  return (
    <RequireOrgAdmin>
      <ProductsPage />
    </RequireOrgAdmin>
  );
}
