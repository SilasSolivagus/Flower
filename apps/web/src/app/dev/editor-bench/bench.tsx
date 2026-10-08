'use client';

import { useEffect, useState } from 'react';
import { DocumentBodyEditor } from '@/features/documents/editor/body-editor';

declare global {
  interface Window {
    __BENCH_MARKDOWN__?: string;
    __BENCH__?: { mountMs: number };
  }
}

export function Bench() {
  const [start] = useState(() => performance.now());
  const [markdown] = useState(() => window.__BENCH_MARKDOWN__ ?? '');
  useEffect(() => {
    // 子组件（编辑器）的 effect 先于这里执行；再等一帧，记录到内容实际绘制为止
    requestAnimationFrame(() => {
      window.__BENCH__ = { mountMs: performance.now() - start };
      document.body.dataset.benchReady = '1';
    });
  }, [start]);
  return (
    <main className="mx-auto max-w-4xl p-6">
      <DocumentBodyEditor initialMarkdown={markdown} editable />
    </main>
  );
}
