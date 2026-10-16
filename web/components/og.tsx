export function OgFrame({
  eyebrow,
  title,
  rows,
  footnote,
}: {
  eyebrow: string;
  title: string;
  rows: Array<{ rank?: number; name: string; value: string; delta?: string }>;
  footnote?: string;
}) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "#07090c",
        color: "#e8eef6",
        padding: "48px 56px",
        fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 18, color: "#8b98a8" }}>
        <span>AgentStore Radar</span>
        <span>{eyebrow}</span>
      </div>
      <div style={{ marginTop: 18, fontSize: 44, fontWeight: 600, letterSpacing: -1 }}>{title}</div>
      <div style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 10 }}>
        {rows.slice(0, 6).map((row, index) => (
          <div key={`${row.name}-${index}`} style={{ display: "flex", justifyContent: "space-between", fontSize: 26 }}>
            <span style={{ display: "flex", gap: 16 }}>
              <span style={{ width: 36, color: "#8b98a8" }}>{row.rank ?? index + 1}</span>
              <span>{row.name}</span>
            </span>
            <span style={{ display: "flex", gap: 20, fontFamily: "IBM Plex Mono, ui-monospace" }}>
              <span>{row.value}</span>
              {row.delta ? <span style={{ color: row.delta.startsWith("-") || row.delta.startsWith("−") ? "#ff6b7a" : "#3ee08f" }}>{row.delta}</span> : null}
            </span>
          </div>
        ))}
      </div>
      {footnote ? <div style={{ marginTop: "auto", color: "#8b98a8", fontSize: 18 }}>{footnote}</div> : null}
    </div>
  );
}
