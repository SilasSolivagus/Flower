'use client';

import dynamic from 'next/dynamic';

const Bench = dynamic(() => import('./bench').then((m) => m.Bench), { ssr: false });

export function BenchLoader() {
  return <Bench />;
}
