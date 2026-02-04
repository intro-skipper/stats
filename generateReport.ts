import { writeFile, mkdir, rm } from "fs/promises";

interface AxiomResponse {
  format: string;
  status: {
    elapsedTime: number;
    blocksExamined: number;
    rowsExamined: number;
    rowsMatched: number;
    minBlockTime: string;
    maxBlockTime: string;
  };
  tables: Array<{
    name: string;
    fields: Array<{
      name: string;
      type: string;
    }>;
    columns: Array<Array<string | number>>;
    range?: {
      start: string;
      end: string;
    };
  }>;
}

async function queryAxiom(): Promise<AxiomResponse> {
  const apiToken = process.env.AXIOM_API_TOKEN;
  if (!apiToken) {
    throw new Error("AXIOM_API_TOKEN environment variable is required");
  }

  const response = await fetch(
    "https://api.axiom.co/v1/datasets/_apl?format=tabular",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        apl: "caddy | where isnotempty(['request.headers.Accept-Encoding']) | summarize count() by agent | order by agent asc",
        startTime: "now-1d",
        endTime: "now",
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Axiom API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<AxiomResponse>;
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${Math.floor(r * 0.45)}, ${Math.floor(g * 0.45)}, ${Math.floor(b * 0.45)}, ${alpha})`;
}

function generateSvgPieChart(data: Map<string, number>): string {
  const entries = [...data.entries()].sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  
  // Colors from the reference chart
  const colors = [
    "#3b9eff", "#ff801f", "#9a5cd0", "#33b074", "#de51a8",
    "#6e6ade", "#ffd60a", "#ec6142", "#2870bd", "#a35829",
    "#8457aa", "#2f7c57", "#a84885", "#5958b1", "#8f6424",
    "#ac4d39", "#222222"
  ];

  const cx = 384, cy = 180, r = 159;
  let currentAngle = -Math.PI / 2;
  
  const slices: string[] = [];
  const insideLabels: string[] = [];
  const outsideLabels: string[] = [];
  
  // Track angles for labels
  const sliceData: Array<{label: string; value: number; percentage: number; midAngle: number; color: string}> = [];
  
  entries.forEach(([label, value], i) => {
    const percentage = value / total;
    const angle = percentage * 2 * Math.PI;
    const endAngle = currentAngle + angle;
    const midAngle = currentAngle + angle / 2;
    
    const x1 = cx + r * Math.cos(currentAngle);
    const y1 = cy + r * Math.sin(currentAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    
    const largeArc = angle > Math.PI ? 1 : 0;
    const color = colors[i % colors.length]!;
    const strokeColor = hexToRgba(color, 0.5);
    
    slices.push(`<path d="M${cx},${cy} L${x1.toFixed(3)},${y1.toFixed(3)} A${r},${r} 0 ${largeArc},1 ${x2.toFixed(3)},${y2.toFixed(3)} Z" fill="${color}" stroke="${strokeColor}" stroke-width="1"/>`);
    
    sliceData.push({ label, value, percentage, midAngle, color });
    currentAngle = endAngle;
  });

  // Generate labels - inside for large slices (>2%), outside with leader lines only for slices with inside labels
  sliceData.forEach(({ label, percentage, midAngle }) => {
    const pctText = (percentage * 100).toFixed(2).replace(".", ",") + "%";
    
    if (percentage >= 0.02) {
      // Inside label
      const labelR = r * 0.5;
      const lx = cx + labelR * Math.cos(midAngle);
      const ly = cy + labelR * Math.sin(midAngle);
      insideLabels.push(`<text x="${lx.toFixed(3)}" y="${ly.toFixed(3)}" text-anchor="middle" dominant-baseline="central" font-family="system-ui, -apple-system, sans-serif" font-size="12" fill="#eeeeee" stroke="#111111" stroke-width="2" paint-order="stroke">${pctText}</text>`);
    
      // Outside label with leader line (only for slices with visible %)
      const innerR = r + 7;
      const outerR = r + 23;
      const lineExtend = 24;
      
      const x1 = cx + innerR * Math.cos(midAngle);
      const y1 = cy + innerR * Math.sin(midAngle);
      const x2 = cx + outerR * Math.cos(midAngle);
      const y2 = cy + outerR * Math.sin(midAngle);
      
      const isRight = Math.cos(midAngle) >= 0;
      const x3 = x2 + (isRight ? lineExtend : -lineExtend);
      const textX = x3 + (isRight ? 6 : -6);
      const anchor = isRight ? "start" : "end";
      
      outsideLabels.push(`<g opacity="1"><path fill="none" stroke="#777777" stroke-width="1" d="M${x1.toFixed(3)},${y1.toFixed(3)}L${x2.toFixed(3)},${y2.toFixed(3)}L${x3.toFixed(3)},${y2.toFixed(3)}"/><text x="${textX.toFixed(3)}" y="${y2.toFixed(3)}" text-anchor="${anchor}" dominant-baseline="central" font-family="system-ui, -apple-system, sans-serif" font-size="12" fill="#eeeeee" stroke="#111111" stroke-width="2" paint-order="stroke">${label}</text></g>`);
    }
  });

  const width = 768;
  const height = 370;
  
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="transparent"/>
  <g>
    ${slices.join("\n    ")}
    ${insideLabels.join("\n    ")}
    ${outsideLabels.join("\n    ")}
  </g>
</svg>`;
}

interface GenerateResult {
  markdown: string[];
  overviewSvg: string;
  detailSvg: string;
  versionSvgs: Map<string, string>;
}

function generateMarkdown(data: AxiomResponse): GenerateResult {
  const lines: string[] = [];
  let overviewSvg = "";
  let detailSvg = "";
  const versionSvgs = new Map<string, string>();

  const formatTime = (iso: string) => iso.replace(/\.\d+Z$/, "Z");
  const start = data.tables[0]?.range?.start;
  const end = data.tables[0]?.range?.end;

  lines.push("# Axiom Query Results");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| ------ | ----- |");
  lines.push(`| Query Time Range | ${start ? formatTime(start) : "N/A"} to ${end ? formatTime(end) : "N/A"} |`);
  lines.push(`| Rows Matched | ${data.status.rowsMatched.toLocaleString()} |`);
  lines.push(`| Elapsed Time | ${data.status.elapsedTime}ms |`);
  lines.push("");

  // Main table (summary by agent)
  const mainTable = data.tables.find((t) => t.name === "0");
  if (mainTable && mainTable.columns.length >= 2) {
    const agents = mainTable.columns[0] as string[];
    const counts = mainTable.columns[1] as number[];

    // Filter valid versions: must have 3 parts, patch version <= 100
    const isValidVersion = (version: string): boolean => {
      const parts = version.split(".");
      if (parts.length !== 3) return false;
      const patch = parseInt(parts[2]!, 10);
      return !isNaN(patch) && patch <= 100;
    };

    // Group by major.minor version for pie chart (only valid versions)
    const grouped = new Map<string, number>();
    for (let i = 0; i < agents.length; i++) {
      const version = agents[i]!.replace("Jellyfin-Server/", "");
      if (!isValidVersion(version)) continue;
      const parts = version.split(".");
      const majorMinor = parts.slice(0, 2).join(".");
      grouped.set(majorMinor, (grouped.get(majorMinor) ?? 0) + counts[i]!);
    }

    // SVG pie chart - overview
    overviewSvg = generateSvgPieChart(grouped);
    lines.push("## Requests by Jellyfin Server Version");
    lines.push("");
    lines.push("![Requests by Jellyfin Server Version](charts/overview.svg)");
    lines.push("");

    // Get last 3 major.minor versions
    const sortedVersions = [...grouped.keys()].sort((a, b) => {
      const [aMaj, aMin] = a.split(".").map(Number);
      const [bMaj, bMin] = b.split(".").map(Number);
      return aMaj !== bMaj ? aMaj! - bMaj! : aMin! - bMin!;
    });
    const last3 = sortedVersions.slice(-3);

    // Detailed pie chart for last 3 major.minor versions (combined)
    const detailData = new Map<string, number>();
    for (let i = 0; i < agents.length; i++) {
      const version = agents[i]!.replace("Jellyfin-Server/", "");
      if (!isValidVersion(version)) continue;
      const parts = version.split(".");
      const majorMinor = parts.slice(0, 2).join(".");
      if (last3.includes(majorMinor)) {
        detailData.set(version, counts[i]!);
      }
    }

    detailSvg = generateSvgPieChart(detailData);
    lines.push(`## Requests by Patch Version (${last3.join(", ")})`);
    lines.push("");
    lines.push(`![Requests by Patch Version (${last3.join(", ")})](charts/detail.svg)`);
    lines.push("");

    // Individual charts for each of the last 3 versions (newest first)
    let chartNum = 1;
    for (const majorMinor of [...last3].reverse()) {
      const versionData = new Map<string, number>();
      for (let i = 0; i < agents.length; i++) {
        const version = agents[i]!.replace("Jellyfin-Server/", "");
        if (!isValidVersion(version)) continue;
        const parts = version.split(".");
        const mm = parts.slice(0, 2).join(".");
        if (mm === majorMinor) {
          versionData.set(version, counts[i]!);
        }
      }
      
      // Skip charts with only one entry (would be 100%)
      if (versionData.size <= 1) continue;
      
      const svg = generateSvgPieChart(versionData);
      versionSvgs.set(String(chartNum), svg);
      
      lines.push(`## Version ${majorMinor}`);
      lines.push("");
      lines.push(`![Version ${majorMinor}](charts/chart-${chartNum}.svg)`);
      lines.push("");
      chartNum++;
    }

    lines.push("## Summary by Agent");
    lines.push("");
    lines.push("| Agent | Total Count |");
    lines.push("| ----- | ----------- |");

    // Sort by semantic version (descending - newest first)
    const validIndices = agents
      .map((agent, i) => ({ agent, count: counts[i]!, i }))
      .filter(({ agent }) => isValidVersion(agent.replace("Jellyfin-Server/", "")))
      .sort((a, b) => {
        const aParts = a.agent.replace("Jellyfin-Server/", "").split(".").map(Number);
        const bParts = b.agent.replace("Jellyfin-Server/", "").split(".").map(Number);
        for (let j = 0; j < 3; j++) {
          if (aParts[j]! !== bParts[j]!) return bParts[j]! - aParts[j]!;
        }
        return 0;
      });

    for (const { agent, count } of validIndices) {
      lines.push(`| ${agent} | ${count.toLocaleString()} |`);
    }
  }

  lines.push("");
  lines.push("---");
  lines.push(`*Generated at ${new Date().toISOString()}*`);
  lines.push("");

  return { markdown: lines, overviewSvg, detailSvg, versionSvgs };
}

async function main() {
  console.log("Querying Axiom API...");

  const data = await queryAxiom();
  const resultRows = data.tables[0]?.columns[0]?.length ?? 0;
  console.log(`Scanned ${data.status.rowsMatched.toLocaleString()} log entries, returned ${resultRows} results`);

  const result = generateMarkdown(data);

  // Delete and recreate charts directory
  await rm("charts", { recursive: true, force: true });
  await mkdir("charts", { recursive: true });

  // Write SVG files
  if (result.overviewSvg) {
    await writeFile("charts/overview.svg", result.overviewSvg);
  }
  if (result.detailSvg) {
    await writeFile("charts/detail.svg", result.detailSvg);
  }
  for (const [num, svg] of result.versionSvgs) {
    await writeFile(`charts/chart-${num}.svg`, svg);
  }

  // Write README
  await writeFile("README.md", result.markdown.join("\n"));
  console.log("Results written to README.md and charts/");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
