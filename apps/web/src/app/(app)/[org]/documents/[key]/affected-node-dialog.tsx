'use client';

import { useState } from 'react';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CHANGE_TYPE_LABEL, domainOptions, featureOptions, moduleOptions } from '@/features/documents/model';
import { levelLabel } from '@/features/structure/model';
import { api } from '@/lib/api';
import { documentKeys, qk, useApiMutation, useLevelNames, useNodes } from '@/lib/queries';
import type { AffectedChangeType, AffectedNode, AffectedNodes, DocumentDetail, StructureNode } from '@/lib/types';
import { cn } from '@/lib/utils';

const CHANGE_TYPES: AffectedChangeType[] = ['added', 'modified', 'removed'];

/**
 * 声明影响（item 为空）或修改一条声明。功能点按名称搜索本产品的结构树；没有时可以在模块下新建功能点，
 * 或在业务域下新建模块再建功能点。初值只在挂载时读取，调用方用 key 重新挂载。
 */
export function AffectedNodeDialog({
  org,
  doc,
  affected,
  item,
  onClose,
}: {
  org: string;
  doc: DocumentDetail;
  affected: AffectedNodes;
  item: AffectedNode | null;
  onClose: () => void;
}) {
  const nodes = useNodes(org, doc.productId);
  const levels = useLevelNames(org, doc.productId);
  const names = levels.data?.names ?? [];
  const [q, setQ] = useState('');
  const [nodeId, setNodeId] = useState<string | null>(item?.nodeId ?? null);
  const [changeType, setChangeType] = useState<AffectedChangeType>(item?.changeType ?? 'modified');
  const [sources, setSources] = useState<string[]>(item?.sourceSections.map((s) => s.key) ?? []);
  const [domainId, setDomainId] = useState('');
  const [moduleName, setModuleName] = useState('');
  const [moduleId, setModuleId] = useState('');
  const [featureName, setFeatureName] = useState('');
  const newNode = useApiMutation(
    (v: { parentId: string; name: string }) => api<{ node: StructureNode }>(`/orgs/${org}/documents/${doc.id}/affected-nodes/new-node`, { method: 'POST', body: v }),
    { silentError: true, invalidate: [qk.nodes(org, doc.productId), documentKeys(org)] },
  );
  const save = useApiMutation(
    () =>
      item
        ? api(`/orgs/${org}/documents/${doc.id}/affected-nodes/${item.nodeId}`, { method: 'PATCH', body: { changeType, sourceSections: sources } })
        : api(`/orgs/${org}/documents/${doc.id}/affected-nodes`, { method: 'POST', body: { nodeId, changeType, sourceSections: sources } }),
    { silentError: true, invalidate: [documentKeys(org)], success: '已保存', onSuccess: onClose },
  );
  const all = nodes.data ?? [];
  const options = featureOptions(all, q, new Set(affected.items.map((x) => x.nodeId)));
  const modules = moduleOptions(all);
  const domains = domainOptions(all);
  // 已失效的来源仍列出（已勾选），由用户决定保留还是去掉
  const choices = [...affected.sections, ...(item?.sourceSections.filter((s) => s.stale).map((s) => s.key) ?? [])];
  const stale = new Set(item?.sourceSections.filter((s) => s.stale).map((s) => s.key) ?? []);
  const featureLabel = levelLabel(names, 3);
  const moduleLabel = levelLabel(names, 2);
  const domainLabel = levelLabel(names, 1);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{item ? '修改影响声明' : '声明影响'}</DialogTitle>
        </DialogHeader>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (item || nodeId) save.mutate();
          }}
        >
          {item ? (
            <p className="text-[13px]">{item.path}</p>
          ) : (
            <fieldset className="flex min-w-0 flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{featureLabel}</legend>
              <Input aria-label={`搜索${featureLabel}`} placeholder={`按名称搜索本产品的${featureLabel}`} className="h-8" value={q} onChange={(e) => setQ(e.target.value)} />
              {options.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">没有可选的{featureLabel}，可以在下面新建</p>
              ) : (
                <ul className="flex max-h-48 flex-col overflow-y-auto rounded-md border">
                  {options.map((o) => (
                    <li key={o.id}>
                      <button
                        type="button"
                        aria-pressed={nodeId === o.id}
                        className={cn('w-full truncate px-3 py-1.5 text-left text-[13px] hover:bg-muted', nodeId === o.id && 'bg-primary/10')}
                        onClick={() => setNodeId(o.id)}
                      >
                        {o.path}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-col gap-2 rounded-md border border-dashed p-3">
                <p className="text-xs text-muted-foreground">没有合适的{featureLabel}时当场新建</p>
                {domains.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">
                    结构树还没有{domainLabel}，请产品管理员在产品设置的结构树页签中添加。
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select value={moduleId} onValueChange={setModuleId}>
                        <SelectTrigger className="h-8 w-48" aria-label={`所属${moduleLabel}`}>
                          <SelectValue placeholder={`选择${moduleLabel}`} />
                        </SelectTrigger>
                        <SelectContent>
                          {modules.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.path}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input aria-label={`新${featureLabel}名称`} className="h-8 w-40" maxLength={50} value={featureName} onChange={(e) => setFeatureName(e.target.value)} />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!moduleId || !featureName.trim() || newNode.isPending}
                        onClick={() =>
                          newNode.mutate(
                            { parentId: moduleId, name: featureName },
                            {
                              onSuccess: (r) => {
                                setNodeId(r.node.id);
                                setFeatureName('');
                                setQ('');
                              },
                            },
                          )
                        }
                      >
                        新建{featureLabel}
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select value={domainId} onValueChange={setDomainId}>
                        <SelectTrigger className="h-8 w-48" aria-label={`所属${domainLabel}`}>
                          <SelectValue placeholder={`选择${domainLabel}`} />
                        </SelectTrigger>
                        <SelectContent>
                          {domains.map((d) => (
                            <SelectItem key={d.id} value={d.id}>
                              {d.path}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input aria-label={`新${moduleLabel}名称`} className="h-8 w-40" maxLength={50} value={moduleName} onChange={(e) => setModuleName(e.target.value)} />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!domainId || !moduleName.trim() || newNode.isPending}
                        onClick={() =>
                          newNode.mutate(
                            { parentId: domainId, name: moduleName },
                            {
                              onSuccess: (r) => {
                                setModuleId(r.node.id);
                                setModuleName('');
                              },
                            },
                          )
                        }
                      >
                        新建{moduleLabel}
                      </Button>
                    </div>
                  </>
                )}
                <FormError error={newNode.error} />
              </div>
            </fieldset>
          )}

          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">变更类型</span>
            <Select value={changeType} onValueChange={(v) => setChangeType(v as AffectedChangeType)}>
              <SelectTrigger className="h-8 w-28" aria-label="变更类型">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHANGE_TYPES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CHANGE_TYPE_LABEL[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className="mb-1 text-sm font-medium">来源小节</legend>
            {doc.source !== 'native' ? (
              <p className="text-[13px] text-muted-foreground">外部 PRD 没有正文，来源小节不可选</p>
            ) : choices.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">PRD 正文还没有小节</p>
            ) : (
              choices.map((key) => (
                <label key={key} className="flex min-w-0 items-center gap-1.5 text-[13px]">
                  <Checkbox aria-label={key} checked={sources.includes(key)} onCheckedChange={(v) => setSources(v ? [...sources, key] : sources.filter((x) => x !== key))} />
                  <span className={cn('truncate', stale.has(key) && 'line-through')}>{key}</span>
                  {stale.has(key) && <span className="shrink-0 text-xs text-muted-foreground">（已失效）</span>}
                </label>
              ))
            )}
          </fieldset>

          <FormError error={save.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={save.isPending || (!item && !nodeId)}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
