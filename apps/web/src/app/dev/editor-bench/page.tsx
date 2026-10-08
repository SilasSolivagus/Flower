import { notFound } from 'next/navigation';
import { BenchLoader } from './bench-loader';

/** 只在开发环境使用的编辑器性能测量页（Task 1 基线与 e2e/editor-perf.spec.ts）。 */
export default function EditorBenchPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <BenchLoader />;
}
