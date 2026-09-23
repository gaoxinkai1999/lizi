<script setup>
import { showValue } from "../api.js";
defineProps({ report: { type: Object, required: true } });
const fields = [
  ["line", "产线"],
  ["operator", "操作员"],
  ["cup", "杯号"],
  ["testStandard", "测试标准"],
  ["effectiveTests", "有效测试"],
  ["totalTests", "总测试"],
  ["invalidTests", "无效测试"],
  ["maxHardness", "最大硬度 / g"],
  ["averageHardness", "平均硬度 / g"],
  ["minHardness", "最小硬度 / g"],
  ["hardnessDeviation", "硬度偏差"],
  ["maxDiameter", "最大粒径 / mm"],
  ["averageDiameter", "平均粒径 / mm"],
  ["minDiameter", "最小粒径 / mm"],
  ["diameterDeviation", "粒径偏差"],
  ["averageOfTop25", "前 25% 平均值"],
  ["deviationOfTop25", "前 25% 偏差"],
  ["crushDiameter", "压碎粒径"],
  ["breakAt", "破碎点"],
  ["step", "步长"],
];
</script>
<template>
  <div class="report-detail">
    <dl class="detail-grid">
      <div v-for="[key, label] in fields" :key="key">
        <dt>{{ label }}</dt>
        <dd>{{ showValue(report[key]) }}</dd>
      </div>
    </dl>
    <h3>
      逐次测量
      <span class="muted">{{ report.testResults?.length || 0 }} 次</span>
    </h3>
    <div v-if="report.testResults?.length" class="table-wrap">
      <table class="measurement-table">
        <thead>
          <tr>
            <th>序号</th>
            <th>测试值</th>
            <th>硬度 / g</th>
            <th>粒径 / mm</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(test, index) in report.testResults" :key="index">
            <td>{{ showValue(test.number ?? index + 1) }}</td>
            <td>{{ showValue(test.test) }}</td>
            <td>{{ showValue(test.gram) }}</td>
            <td>{{ showValue(test.mm) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="muted">报告没有逐次测量数据。</p>
    <template v-if="report.segmentInfoList?.length"
      ><h3>分段分布</h3>
      <dl class="segment-list">
        <div v-for="(segment, index) in report.segmentInfoList" :key="index">
          <dt>{{ showValue(segment.range) }}</dt>
          <dd>{{ showValue(segment.stars) }}</dd>
        </div>
      </dl></template
    >
  </div>
</template>
