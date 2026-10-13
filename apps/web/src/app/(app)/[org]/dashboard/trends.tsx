'use client';

import type { ReactNode } from 'react';
import { MetricHelp } from '@/features/dashboard/components/metric-help';
import { formatDays, linePoints, METRIC_HELP, niceMax, weekLabel } from '@/features/dashboard/model';
import type { ProductDashboard } from '@/lib/types';

type Week = ProductDashboard['weeks'][number];
type Row = { key: string; label: string; value: string };
type Series = { label: string; values: Array<number | null>; stroke: string; swatch: string };

const W = 600;
const H = 160;

/** 图表外框：标题与口径、纵轴上限、周标签（最多约 6 个）、图例，以及给读屏器的数据表。没有数据时图的位置显示原因。 */
function Frame({
  title,
  help,
  max,
  weeks,
  rows,
  legend,
  empty,
  children,
}: {
  title: string;
  help: string;
  max: number;
  weeks: Week[];
  rows: Row[];
  legend?: ReactNode;
  empty: string | null;
  children: ReactNode;
}) {
  const step = Math.max(1, Math.ceil(weeks.length / 6));
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2 rounded-md border bg-card p-3">
      <div className="flex items-center gap-1">
        <h3 className="truncate text-sm font-semibold">{title}</h3>
        <MetricHelp label={title} text={help} />
        {!empty && <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">纵轴 0–{max}</span>}
      </div>
      {empty ? (
        <p className="flex h-40 items-center justify-center text-center text-[13px] text-muted-foreground">{empty}</p>
      ) : (
        <>
          {children}
          <div className="flex justify-between font-mono text-[10px] text-muted-foreground" aria-hidden="true">
            {weeks.map((w, i) => (
              <span key={w.week}>{i % step === 0 || i === weeks.length - 1 ? weekLabel(w.week) : ''}</span>
            ))}
          </div>
          {legend}
        </>
      )}
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td>{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function BarChart({ title, help, weeks, values, emptyReason }: { title: string; help: string; weeks: Week[]; values: number[]; emptyReason: string }) {
  const max = niceMax(values);
  const slot = W / Math.max(1, values.length);
  return (
    <Frame
      title={title}
      help={help}
      max={max}
      weeks={weeks}
      empty={values.every((v) => v === 0) ? emptyReason : null}
      rows={weeks.map((w, i) => ({ key: w.week, label: `${weekLabel(w.week)} 起一周`, value: String(values[i]) }))}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" className="h-40 w-full">
        <line x1={0} y1={H} x2={W} y2={H} className="stroke-border" vectorEffect="non-scaling-stroke" />
        {values.map((v, i) => {
          const h = (v / max) * H;
          return <rect key={weeks[i]!.week} x={i * slot + slot * 0.15} y={H - h} width={slot * 0.7} height={h} className="fill-primary" />;
        })}
      </svg>
    </Frame>
  );
}

function LineChart({
  title,
  help,
  weeks,
  series,
  format,
  emptyReason,
  emptyWhenZero = false,
}: {
  title: string;
  help: string;
  weeks: Week[];
  series: Series[];
  format: (v: number | null) => string;
  emptyReason: string;
  emptyWhenZero?: boolean;
}) {
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const empty = all.length === 0 || (emptyWhenZero && all.every((v) => v === 0));
  const max = niceMax(all);
  const rows = weeks.map((w, i) => ({ key: w.week, label: `${weekLabel(w.week)} 起一周`, value: series.map((s) => `${s.label} ${format(s.values[i] ?? null)}`).join('，') }));
  const legend = (
    <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
      {series.map((s) => (
        <span key={s.label} className="inline-flex items-center gap-1">
          <span className={`inline-block h-0.5 w-3 ${s.swatch}`} aria-hidden="true" />
          {s.label}
        </span>
      ))}
    </div>
  );
  return (
    <Frame title={title} help={help} max={max} weeks={weeks} rows={rows} legend={legend} empty={empty ? emptyReason : null}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" className="h-40 w-full">
        <line x1={0} y1={H} x2={W} y2={H} className="stroke-border" vectorEffect="non-scaling-stroke" />
        {series.map((s) =>
          linePoints(s.values, W, H, max).map((seg, k) => {
            // 前后都断开的单独一周画成一小段横线
            const pts = seg.length === 1 ? [{ x: seg[0]!.x - 4, y: seg[0]!.y }, { x: seg[0]!.x + 4, y: seg[0]!.y }] : seg;
            return (
              <polyline
                key={`${s.label}-${k}`}
                points={pts.map((pt) => `${pt.x},${pt.y}`).join(' ')}
                fill="none"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                className={s.stroke}
              />
            );
          }),
        )}
      </svg>
    </Frame>
  );
}

/** 趋势：每周吞吐量、在制品周趋势、前置时间与流动时间的 85 分位走势。 */
export function Trends({ weeks }: { weeks: Week[] }) {
  return (
    <section aria-label="趋势" className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">趋势</h2>
      <div className="grid gap-3 lg:grid-cols-3">
        <BarChart title="每周吞吐量" help={METRIC_HELP.throughput} weeks={weeks} values={weeks.map((w) => w.throughput)} emptyReason="时间段内没有完成的需求" />
        <LineChart
          title="在制品周趋势"
          help={METRIC_HELP.wip}
          weeks={weeks}
          format={(v) => (v === null ? '—' : String(v))}
          series={[{ label: '在制品', values: weeks.map((w) => w.wip), stroke: 'stroke-amber-600', swatch: 'bg-amber-600' }]}
          emptyReason="时间段内没有进行中的需求"
          emptyWhenZero
        />
        <LineChart
          title="前置时间与流动时间（85 分位）"
          help={`${METRIC_HELP.leadTime}${METRIC_HELP.flowTime}每周取当周完成的需求计算 85 分位。`}
          weeks={weeks}
          format={formatDays}
          series={[
            { label: '前置时间', values: weeks.map((w) => w.leadP85), stroke: 'stroke-primary', swatch: 'bg-primary' },
            { label: '流动时间', values: weeks.map((w) => w.flowP85), stroke: 'stroke-amber-600', swatch: 'bg-amber-600' },
          ]}
          emptyReason="时间段内没有完成的需求"
        />
      </div>
    </section>
  );
}
