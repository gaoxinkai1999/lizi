import { showValue } from "./api.js";

function drawCell(
  context,
  text,
  x,
  y,
  width,
  height,
  { bold = false, fill = "#ffffff", color = "#263546" } = {},
) {
  context.fillStyle = fill;
  context.fillRect(x, y, width, height);
  context.strokeStyle = "#dce3eb";
  context.strokeRect(x, y, width, height);
  context.save();
  context.beginPath();
  context.rect(x + 4, y, width - 8, height);
  context.clip();
  context.fillStyle = color;
  const value = String(showValue(text));
  let size = 20;
  context.font = `${bold ? 600 : 400} ${size}px sans-serif`;
  while (size > 10 && context.measureText(value).width > width - 12) {
    size--;
    context.font = `${bold ? 600 : 400} ${size}px sans-serif`;
  }
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(value, x + width / 2, y + height / 2);
  context.restore();
}

async function* batches(reports, signal) {
  let rows = [];
  for await (const report of reports) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    rows.push(report);
    if (rows.length === 25) {
      yield rows;
      rows = [];
    }
  }
  if (rows.length) yield rows;
}

export async function createReportImages(reports, title, { signal } = {}) {
  const images = [];
  let rowStart = 0;
  try {
    for await (const rows of batches(reports, signal)) {
      const measurementCount = Math.max(
        20,
        ...rows.map((report) => report.testResults?.length || 0),
      );
      for (let testStart = 0; testStart < measurementCount; testStart += 20) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const count = Math.min(20, measurementCount - testStart);
        const columns = [
          150,
          130,
          200,
          150,
          ...Array(count).fill(60),
          100,
          100,
          100,
        ];
        const width = columns.reduce((sum, value) => sum + value, 0) + 48;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = 140 + (rows.length + 1) * 46;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("此浏览器无法生成报告图片。");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#182a3b";
        context.font = "600 30px sans-serif";
        context.fillText(`粒子强度报告 · ${title}`, 24, 48);
        context.fillStyle = "#65758a";
        context.font = "20px sans-serif";
        context.fillText(
          `报告 ${rowStart + 1}–${rowStart + rows.length} · 测量 ${testStart + 1}–${testStart + count} · 硬度单位 g`,
          24,
          86,
        );
        const headers = [
          "日期",
          "时间",
          "样品",
          "来源",
          ...Array.from({ length: count }, (_, index) =>
            String(testStart + index + 1),
          ),
          "最大",
          "平均",
          "最小",
        ];
        let x = 24;
        headers.forEach((header, index) => {
          drawCell(context, header, x, 110, columns[index], 46, {
            bold: true,
            fill: "#eef3f8",
          });
          x += columns[index];
        });
        rows.forEach((report, index) => {
          const cells = [
            report.date,
            report.time,
            report.sampleName,
            report.sourceName || report.sourceId || "本机",
            ...Array.from(
              { length: count },
              (_, i) => report.testResults?.[testStart + i]?.gram,
            ),
            report.maxHardness,
            report.averageHardness,
            report.minHardness,
          ];
          x = 24;
          cells.forEach((cell, col) => {
            drawCell(context, cell, x, 156 + index * 46, columns[col], 46, {
              bold: col === columns.length - 2,
              fill: index % 2 ? "#f8fafc" : "#ffffff",
            });
            x += columns[col];
          });
        });
        const blob = await new Promise((resolve, reject) =>
          canvas.toBlob(
            (value) =>
              value
                ? resolve(value)
                : reject(new Error("图片生成失败，请减少选择的报告后重试。")),
            "image/png",
          ),
        );
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        images.push({
          blob,
          url: URL.createObjectURL(blob),
          name: `粒子报告-${title}-${images.length + 1}.png`,
        });
        canvas.width = 0;
        canvas.height = 0;
      }
      rowStart += rows.length;
    }
    return images;
  } catch (error) {
    images.forEach((image) => URL.revokeObjectURL(image.url));
    throw error;
  }
}
