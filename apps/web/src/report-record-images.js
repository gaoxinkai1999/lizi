// Record-sheet images: one炉号 sheet per page, columns chunked so a sheet stays
// readable, summary (最大/平均/最小) repeated at the bottom. Client-side only.
import { showValue } from "./api.js";

const COLUMNS_PER_PAGE = 8;

function drawCell(
  context,
  text,
  x,
  y,
  width,
  height,
  { bold = false, fill = "#ffffff", color = "#263546", size = 20 } = {},
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
  let current = size;
  context.font = `${bold ? 600 : 400} ${current}px sans-serif`;
  while (current > 10 && context.measureText(value).width > width - 12) {
    current--;
    context.font = `${bold ? 600 : 400} ${current}px sans-serif`;
  }
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(value, x + width / 2, y + height / 2);
  context.restore();
}

function chunks(items, size) {
  const pages = [];
  for (let index = 0; index < items.length; index += size)
    pages.push(items.slice(index, index + size));
  return pages.length ? pages : [[]];
}

export async function createRecordImages(sheets, { signal, title } = {}) {
  const images = [];
  const labelWidth = 90;
  const columnWidth = 110;
  try {
    for (const sheet of sheets) {
      const columnPages = chunks(sheet.columns, COLUMNS_PER_PAGE);
      for (let page = 0; page < columnPages.length; page++) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const columns = columnPages[page];
        const rangeStart = page * COLUMNS_PER_PAGE;
        const width = labelWidth + columnWidth * columns.length + 48;
        const height = 190 + (sheet.rows.length + 3) * 46;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("此浏览器无法生成报告图片。");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.fillStyle = "#182a3b";
        context.font = "600 30px sans-serif";
        context.fillText(`${sheet.title} · ${sheet.date}`, 24, 48);
        context.fillStyle = "#65758a";
        context.font = "20px sans-serif";
        const suffix =
          columnPages.length > 1
            ? `${title ? `${title} · ` : ""}第 ${page + 1} / ${columnPages.length} 段`
            : title || "";
        context.fillText(suffix, 24, 86);
        let x = 24;
        drawCell(context, "日期", x, 110, labelWidth, 46, {
          bold: true,
          fill: "#eef3f8",
        });
        drawCell(context, sheet.date, x + labelWidth, 110, columnWidth * columns.length, 46, {
          bold: true,
          fill: "#eef3f8",
        });
        x = 24;
        drawCell(context, "时间", x, 156, labelWidth, 46, {
          bold: true,
          fill: "#eef3f8",
        });
        columns.forEach((column, index) => {
          drawCell(
            context,
            column.time,
            x + labelWidth + index * columnWidth,
            156,
            columnWidth,
            46,
            { bold: true, fill: "#eef3f8" },
          );
        });
        sheet.rows.forEach((row, rowIndex) => {
          const y = 202 + rowIndex * 46;
          const fill = rowIndex % 2 ? "#f8fafc" : "#ffffff";
          drawCell(context, rowIndex + 1, 24, y, labelWidth, 46, {
            bold: false,
            fill,
            color: "#65758a",
          });
          row.slice(rangeStart, rangeStart + columns.length).forEach((value, index) => {
            drawCell(
              context,
              value,
              24 + labelWidth + index * columnWidth,
              y,
              columnWidth,
              46,
              { fill },
            );
          });
        });
        ["max", "average", "min"].forEach((key, summaryIndex) => {
          const label = { max: "最大", average: "平均", min: "最小" }[key];
          const y = 202 + (sheet.rows.length + summaryIndex) * 46;
          drawCell(context, label, 24, y, labelWidth, 46, {
            bold: true,
            fill: "#eff6f5",
            color: "#195450",
          });
          sheet.summary[key]
            .slice(rangeStart, rangeStart + columns.length)
            .forEach((value, index) => {
              drawCell(
                context,
                value,
                24 + labelWidth + index * columnWidth,
                y,
                columnWidth,
                46,
                { bold: true, fill: "#eff6f5", color: "#195450" },
              );
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
        const segment =
          columnPages.length > 1 ? `-${page + 1}` : "";
        images.push({
          blob,
          url: URL.createObjectURL(blob),
          name: `${sheet.label}-${sheet.date}-记录表${segment}.png`,
        });
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    return images;
  } catch (error) {
    images.forEach((image) => URL.revokeObjectURL(image.url));
    throw error;
  }
}
