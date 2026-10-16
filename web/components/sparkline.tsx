type Props = {
  values: Array<number | null>;
  className?: string;
  stroke?: string;
};

export function Sparkline({ values, className, stroke = "var(--accent)" }: Props) {
  const nums = values.filter((value): value is number => value != null);
  if (nums.length < 2) {
    return <span className="text-muted">—</span>;
  }
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const width = 72;
  const height = 22;
  const step = width / (values.length - 1);
  const points = values
    .map((value, index) => {
      if (value == null) return null;
      const x = index * step;
      const y = height - ((value - min) / span) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");
  return (
    <svg width={width} height={height} className={className} aria-hidden="true">
      <polyline fill="none" stroke={stroke} strokeWidth="1.4" points={points} />
    </svg>
  );
}

export function LineChart({
  labels,
  series,
}: {
  labels: string[];
  series: Array<{ name: string; color: string; values: Array<number | null> }>;
}) {
  const width = 720;
  const height = 220;
  const pad = { l: 48, r: 12, t: 12, b: 28 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const nums = series.flatMap((item) => item.values.filter((value): value is number => value != null));
  if (nums.length === 0 || labels.length < 2) {
    return <p className="text-sm text-muted">Not enough history for a chart yet.</p>;
  }
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const x = (index: number) => pad.l + (index / (labels.length - 1)) * innerW;
  const y = (value: number) => pad.t + innerH - ((value - min) / span) * innerH;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-56 w-full" role="img" aria-label="Metric history">
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + innerH} stroke="var(--line)" />
      <line x1={pad.l} y1={pad.t + innerH} x2={pad.l + innerW} y2={pad.t + innerH} stroke="var(--line)" />
      <text x={4} y={pad.t + 8} className="fill-muted" fontSize="10">
        {max.toLocaleString()}
      </text>
      <text x={4} y={pad.t + innerH} className="fill-muted" fontSize="10">
        {min.toLocaleString()}
      </text>
      {labels.map((label, index) =>
        index === 0 || index === labels.length - 1 ? (
          <text key={label} x={x(index)} y={height - 6} className="fill-muted" fontSize="10" textAnchor={index === 0 ? "start" : "end"}>
            {label}
          </text>
        ) : null,
      )}
      {series.map((item) => {
        const pts = item.values
          .map((value, index) => (value == null ? null : `${x(index)},${y(value)}`))
          .filter(Boolean)
          .join(" ");
        return <polyline key={item.name} fill="none" stroke={item.color} strokeWidth="2" points={pts} />;
      })}
    </svg>
  );
}
