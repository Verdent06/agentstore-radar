import { ImageResponse } from "next/og";
import { OgFrame } from "@/components/og";
import { formatCompact, formatSigned } from "@/lib/format";
import { isChartId, topChart } from "@/lib/query";
import { loadAggregate } from "@/lib/store";
import { CHART_META } from "@/lib/types";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ chart: string }> }) {
  const { chart: raw } = await params;
  const chart = isChartId(raw) ? raw : "npm";
  const agg = loadAggregate();
  const spec = CHART_META[chart];
  const rows = topChart(agg, chart, 6).map((row) => ({
    rank: row.rank,
    name: row.app.displayName,
    value: formatCompact(row.value),
    delta: formatSigned(row.delta),
  }));
  return new ImageResponse(
    <OgFrame eyebrow={spec.unit} title={spec.title} rows={rows} footnote={`${agg.meta.latestDate ?? ""} · AgentStore Radar`} />,
    size,
  );
}
