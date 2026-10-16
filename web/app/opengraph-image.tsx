import { ImageResponse } from "next/og";
import { OgFrame } from "@/components/og";
import { formatCompact, formatSigned } from "@/lib/format";
import { homeRows } from "@/lib/query";
import { loadAggregate } from "@/lib/store";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  const agg = loadAggregate();
  const rows = homeRows(agg, 6).map((row) => ({
    rank: row.rank,
    name: row.app.displayName,
    value: formatCompact(row.value),
    delta: formatSigned(row.delta),
  }));
  return new ImageResponse(
    <OgFrame eyebrow={agg.meta.latestDate ?? ""} title="Cross-store leaderboards" rows={rows} footnote="agentstore-radar · aggregates only" />,
    size,
  );
}
