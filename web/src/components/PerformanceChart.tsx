import { useId } from 'react';
import { number, signed } from '../api';
import { Empty } from './UI';

export interface ChartPoint {
  at: string;
  value: number;
}
const date = (at: string) =>
  new Date(at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const compact = (value: number) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

export function PerformanceChart({
  points,
  kind,
  hands,
  scoreLabel = 'Season score',
}: {
  points: ChartPoint[];
  kind: 'profit' | 'score';
  hands: number;
  scoreLabel?: string;
}) {
  const gradient = useId();
  if (!points.length)
    return (
      <Empty title={kind === 'profit' ? 'No settled hands yet' : 'No score snapshots yet'}>
        {kind === 'profit'
          ? 'Results appear after a verified settlement.'
          : 'The curve starts with an official account snapshot.'}
      </Empty>
    );
  const values = points.map((point) => point.value);
  const minimum = Math.min(...values, ...(kind === 'profit' ? [0] : []));
  const maximum = Math.max(...values, ...(kind === 'profit' ? [0] : []));
  const padding = Math.max(1, (maximum - minimum) * 0.12);
  const low = minimum - padding;
  const high = maximum + padding;
  const y = (value: number) => 280 - ((value - low) / (high - low)) * 280;
  const start = Date.parse(points[0]!.at);
  const duration = Date.parse(points.at(-1)!.at) - start;
  const x = (point: ChartPoint, index: number) =>
    duration > 0
      ? 8 + ((Date.parse(point.at) - start) / duration) * 984
      : points.length > 1
        ? 8 + (index / (points.length - 1)) * 984
        : 500;
  const xy = points.map((point, index) => `${x(point, index)},${y(point.value)}`);
  const last = points.at(-1)!;
  const color = kind === 'profit' && last.value < 0 ? '#efa590' : '#b7f78a';
  const label =
    kind === 'profit'
      ? `Cumulative net profit: ${signed(last.value)} chips across ${number(hands)} verified hands`
      : `${scoreLabel}: ${number(last.value)} chips`;
  return (
    <figure className="results-chart">
      <div className="results-chart-body">
        <div className="results-chart-scale" aria-hidden="true">
          {[high, (high + low) / 2, low].map((value, index) => (
            <span key={index}>{compact(value)}</span>
          ))}
        </div>
        <svg viewBox="0 0 1000 280" preserveAspectRatio="none" role="img" aria-label={label}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity=".22" />
              <stop offset="100%" stopColor={color} stopOpacity=".015" />
            </linearGradient>
          </defs>
          {[1, 140, 279].map((height) => (
            <line
              key={height}
              x1="0"
              x2="1000"
              y1={height}
              y2={height}
              stroke="#2c3b30"
              strokeDasharray="3 5"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {points.length > 1 && (
            <path
              d={`M${xy.join(' L')} L${x(last, points.length - 1)},280 L${x(points[0]!, 0)},280 Z`}
              fill={`url(#${gradient})`}
            />
          )}
          {kind === 'profit' && (
            <line
              x1="0"
              x2="1000"
              y1={y(0)}
              y2={y(0)}
              stroke="#5b705d"
              strokeDasharray="4 6"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <polyline
            points={xy.join(' ')}
            fill="none"
            stroke={color}
            strokeWidth="2.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {points.map((point, index) => (
            <circle key={index} cx={x(point, index)} cy={y(point.value)} r="3" fill={color}>
              <title>
                {date(point.at)}: {kind === 'profit' ? signed(point.value) : number(point.value)}{' '}
                chips
              </title>
            </circle>
          ))}
        </svg>
      </div>
      <figcaption className="results-chart-dates">
        <span>{date(points[0]!.at)}</span>
        <span>{date(last.at)}</span>
      </figcaption>
    </figure>
  );
}
