type Props = {
  values: Array<number | null>;
  className?: string;
  stroke?: string;
};

function splitNumericSegments(values: Array<number | null>): Array<Array<{ index: number; value: number }>> {
  const segments: Array<Array<{ index: number; value: number }>> = [];
  let current: Array<{ index: number; value: number }> = [];
  values.forEach((value, index) => {
    if (value == null) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      return;
    }
    current.push({ index, value });
  });
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

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
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const point = (index: number, value: number) => {
    const x = index * step;
    const y = height - ((value - min) / span) * (height - 2) - 1;
    return { x, y };
  };
  return (
    <svg width={width} height={height} className={className} aria-hidden="true">
      {splitNumericSegments(values).map((segment, segmentIndex) => {
        if (segment.length === 1) {
          const { x, y } = point(segment[0]!.index, segment[0]!.value);
          return <circle key={segmentIndex} cx={x} cy={y} r="1.4" fill={stroke} />;
        }
        const points = segment.map(({ index, value }) => {
          const { x, y } = point(index, value);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        });
        return <polyline key={segmentIndex} fill="none" stroke={stroke} strokeWidth="1.4" points={points.join(" ")} />;
      })}
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
      {series.map((item) =>
        splitNumericSegments(item.values).map((segment, segmentIndex) => {
          if (segment.length === 1) {
            return (
              <circle
                key={`${item.name}-${segmentIndex}`}
                cx={x(segment[0]!.index)}
                cy={y(segment[0]!.value)}
                r="2.2"
                fill={item.color}
              />
            );
          }
          const pts = segment.map(({ index, value }) => `${x(index)},${y(value)}`).join(" ");
          return <polyline key={`${item.name}-${segmentIndex}`} fill="none" stroke={item.color} strokeWidth="2" points={pts} />;
        }),
      )}
    </svg>
  );
}
