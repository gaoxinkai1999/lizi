import express from "express";
import { reportColumns } from "@lizi/core";
import { httpError } from "./directories.js";

// 只读接口：供同机的小程序后端（三强小工具）调用。
// 它不要求登录会话，因此公网入口必须在反向代理里挡掉 /api/read/，只允许经回环访问。
const PAGE_SIZE = 100;
const SMALL_PAGE_SIZE = 10;
const SUMMARY_FIELDS = [...reportColumns.map(([key]) => key), "id", "sourceId", "sourceName", "instrumentId", "instrumentType", "schemaVersion", "parserVersion"];

// 摘要化：逐次测量与分段分布体积最大，列表页只保留条数，明细走单份报告接口。
function summary(report) {
  const result = {};
  for (const key of SUMMARY_FIELDS) if (report[key] !== undefined) result[key] = report[key];
  result.detailCount = Array.isArray(report.testResults) ? report.testResults.length : 0;
  result.segmentCount = Array.isArray(report.segmentInfoList) ? report.segmentInfoList.length : 0;
  return result;
}

function sourceView(source) {
  return {
    id: source.id,
    name: source.name ?? null,
    location: source.location ?? null,
    instrumentId: source.instrumentId,
    instrumentType: source.instrumentType,
    registrationState: source.registrationState,
    connectionState: source.connectionState,
    state: source.state ?? (source.registrationState === "approved" ? source.connectionState : source.registrationState),
    warning: source.warning ?? null,
    lastSeenAt: source.lastSeenAt ?? null,
    lastReceivedAt: source.lastReceivedAt ?? null,
    pending: source.pending ?? null,
    clientVersion: source.clientVersion ?? null,
    hasError: Boolean(source.lastError || source.acquisitionError),
  };
}

export function createMobileRead({ store, parseQuery }) {
  const router = express.Router();
  router.use((req, res, next) => {
    try {
      store.assertOpen();
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get("/reports", async (req, res, next) => {
    try {
      const query = parseQuery(req.query);
      let result;
      try {
        // 倒序取最近一页：列表页关心的是最新报告，明细走单份报告接口。
        result = await store.query({ ...query, page: 1, pageSize: PAGE_SIZE, latest: true });
      } catch (error) {
        // 单页明细过多时退化为小页，宁可少回也不整页失败。
        if (error.status !== 413) throw error;
        result = await store.query({ ...query, page: 1, pageSize: SMALL_PAGE_SIZE, latest: true });
      }
      const reports = result.reports.map(summary);
      res.json({
        date: query.date,
        shift: query.shift,
        revision: result.revision,
        total: result.total,
        truncated: result.total > reports.length,
        summary: result.summary,
        sources: result.sources.map(sourceView),
        reports,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/reports/:id", (req, res, next) => {
    try {
      const report = store.report(req.params.id);
      if (!report) throw httpError(404, "报告不存在或已删除");
      const source = store.device(report.sourceId);
      res.json({ report, source: source ? sourceView(source) : null });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
