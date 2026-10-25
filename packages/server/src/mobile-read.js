import express from "express";
import { applyReportEdit, reportColumns } from "@lizi/core";
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

  // 更正排队：小程序后端经回环提交，中心只记录意图；设备下次心跳取走，在本地库生效，
  // 再用既有上传链路回传新版本。中心始终不就地把镜像改成与设备不一致的状态。
  router.post(
    "/reports/:id/edit",
    express.json({ limit: "8kb", strict: true }),
    (req, res, next) => {
      try {
        // 信任边界与只读接口相同：端口只绑宿主回环，反代把 /api/read 对公网返回 404，
        // 唯一调用方是同机的中转服务。这里不按来源地址过滤——容器看到的对端是网桥地址。
        const id = req.params.id;
        if (!/^[a-f0-9]{32}$/.test(id)) throw httpError(400, "报告标识无效");
        const body = req.body;
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw httpError(400, "请求体必须为 JSON 对象");
        if (Object.keys(body).some((key) => key !== "sampleName" && key !== "measurement"))
          throw httpError(400, "仅支持修改样品名称或单个测点");
        const edit = {};
        if (body.sampleName !== undefined) edit.sampleName = body.sampleName;
        if (body.measurement !== undefined) edit.measurement = body.measurement;
        if (!Object.keys(edit).length) throw httpError(400, "没有需要修改的内容");

        const report = store.report(id);
        const target = store.reportTarget(id);
        if (!report || !target) throw httpError(404, "报告不存在或已删除");
        // 设备端只认自己的报告标识；格式不符说明是历史或异常上报，直接拒绝而不是排队。
        if (!/^[a-f0-9]{32}$/.test(target.reportId))
          throw httpError(409, "这份报告不支持远程更正");
        let next_;
        try {
          next_ = applyReportEdit(report, edit);
        } catch (error) {
          throw httpError(400, error.message);
        }
        if (!next_.changed) {
          res.json({
            queued: false,
            changed: false,
            pending: store.pendingEditCount(target.deviceId),
            deviceState: store.device(target.deviceId)?.connectionState ?? null,
          });
          return;
        }
        const device = store.device(target.deviceId);
        if (!device || device.registrationState !== "approved")
          throw httpError(409, "所属设备未启用，暂时无法更正");
        const pending = store.queueEdit(target.deviceId, target.reportId, edit);
        res.json({
          queued: true,
          changed: true,
          pending,
          deviceId: target.deviceId,
          deviceState: device.connectionState,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
