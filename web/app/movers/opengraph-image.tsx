import { ImageResponse } from "next/og";
import { OgFrame } from "@/components/og";
import { formatSigned } from "@/lib/format";
import { movers } from "@/lib/query";
import { loadAggregate } from "@/lib/store";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  const agg = loadAggregate();
  const rows = movers(agg, { window: "7d", metric: "use_count", limit: 6 }).map((row, index) => ({
    rank: index + 1,
    name: row.name,
    value: formatSigned(row.delta),
    delta: formatSigned(row.delta),
  }));
  return new ImageResponse(
    <OgFrame
      eyebrow={`${agg.meta.weekAgoDate ?? ""} → ${agg.meta.latestDate ?? ""}`}
      title="Weekly movers"
      rows={rows}
      footnote="Smithery use count · screenshot this page"
    />,
    size,
  );
}
