<template>
  <div class="mobile-view">
    <van-nav-bar title="粒子强度数据 (移动版)" fixed placeholder />

    <van-form @submit="onSubmitGetData" class="form-container">
      <van-field
        readonly
        clickable
        name="date"
        :value="value"
        label="选择日期"
        placeholder="点击选择日期"
        @click="showDatePicker = true"
        input-align="right"
      />
      <van-popup v-model="showDatePicker" position="bottom">
        <van-datetime-picker
          v-model="currentDateForPicker"
          type="date"
          title="选择年月日"
          :min-date="minDate"
          :max-date="maxDate"
          @confirm="onDateConfirm"
          @cancel="showDatePicker = false"
        />
      </van-popup>

      <van-field name="radio" label="班次">
        <template #input>
          <van-radio-group v-model="radio" direction="horizontal" class="radio-group-mobile">
            <van-radio name="1">白班</van-radio>
            <van-radio name="2">夜班</van-radio>
          </van-radio-group>
        </template>
      </van-field>

      <div class="button-container">
        <van-button round block type="info" native-type="submit">
          获取数据
        </van-button>
      </div>
    </van-form>

    <!-- 数据展示区域 -->
    <div v-if="tableData.length > 0" class="data-list-container">
      <van-divider>详细数据</van-divider>
      <div class="table-scroll-x">
        <table class="data-table">
          <thead>
            <tr>
              <th>日期</th>
              <th>时间</th>
              <th>样品名称</th>
              <th>最大硬度</th>
              <th>平均硬度</th>
              <th>最小硬度</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in tableData" :key="index">
              <td>{{ item.date }}</td>
              <td>{{ item.time }}</td>
              <td>{{ item.sampleName }}</td>
              <td>{{ item.maxHardness }}</td>
              <td>{{ item.averageHardness }}</td>
              <td>{{ item.minHardness }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <van-empty v-else-if="searched" description="暂无数据" />


    <div class="action-buttons-container" v-if="tableData.length > 0">
       <van-button type="primary" size="small" @click="dialogVisible = true">简易模式</van-button>
       <van-button type="primary" size="small" @click="exportToExcel">导出Excel</van-button>
       <van-button type="primary" size="small" @click="copyTableAsImage">复制图片</van-button>
    </div>

    <!-- 简易模式 Dialog -->
    <van-dialog v-model="dialogVisible" title="粒子强度数据 (简易模式)" show-cancel-button :show-confirm-button="false" width="90vw">
        <div class="simple-mode-container">
          <div v-for="(row, rowIndex) in groupedTableDate" :key="rowIndex" class="simple-mode-row">
            <div v-for="(item, colIndex) in row" :key="colIndex" class="simple-mode-card">
              <div class="simple-mode-header" v-if="item">{{ item.line }}线 - {{item.time}}</div>
              <div class="simple-mode-results-grid" v-if="item">
                <van-tag v-for="(innerItem, innerColIndex) in flattenTestResults(item.groupedTestResults)" :key="innerColIndex" type="success" size="small" class="simple-mode-tag">
                   {{ innerItem.gram }}
                </van-tag>
              </div>
              <div class="simple-mode-stats" v-if="item">
                <span>最大:{{ item.maxHardness }}</span>
                <span>平均:{{ item.averageHardness }}</span>
                <span>最小:{{ item.minHardness }}</span>
              </div>
            </div>
          </div>
        </div>
    </van-dialog>

    <!-- 图片弹窗 -->
    <van-dialog v-model="showImageDialog" title="表格图片" @close="showImageDialog = false" width="90vw">
      <div style="text-align: center;">
        <img :src="generatedImageUrl" alt="表格图片" style="max-width: 100%; height: auto;" />
        <div style="margin-top: 10px; color: #666;">长按图片可保存</div>
      </div>
    </van-dialog>

  </div>
</template>

<script>
import * as XLSX from 'xlsx';
// import html2canvas from 'html2canvas'; // Consider lazy loading

export default {
  name: 'MobileView',
  data() {
    const today = new Date();
    const formattedDate = `${today.getFullYear()}-${('0' + (today.getMonth() + 1)).slice(-2)}-${('0' + today.getDate()).slice(-2)}`;
    return {
      value: formattedDate, // For display and submission
      currentDateForPicker: new Date(), // For van-datetime-picker, will be synced in created()
      radio: '1', // 白班/夜班
      tableData: [], // 原始数据
      loading: false,
      finished: false,
      currentPage: 1,
      itemsPerPage: 5, // 每次加载5条数据
      activeCollapse: [], // 控制折叠面板的展开状态
      showDatePicker: false,
      minDate: new Date(today.getFullYear() - 5, 0, 1), // 最小可选日期
      maxDate: new Date(today.getFullYear() + 5, 11, 31), // 最大可选日期
      dialogVisible: false, // 简易模式弹窗
      selection: [],
      html2canvas: null, // 按需加载
      searched: false, // 是否已执行过获取数据操作
      showImageDialog: false, // 新增：图片弹窗显示
      generatedImageUrl: '', // 新增：生成的图片 base64
    };
  },
  computed: {
    groupedTableDate() {
      const sourceData = this.tableData;
      const chunkSize = 2; // 简易模式下每行显示多少个卡片
      const grouped = [];
      for (let i = 0; i < sourceData.length; i += chunkSize) {
        grouped.push(sourceData.slice(i, i + chunkSize));
      }
      for (const groupRow of grouped) {
        for (const item of groupRow) {
          if (item && item.testResults) {
            const groupedTestResults = [];
            const chunkSizeTestResults = 5; // 每行显示5个测试结果
            for (let j = 0; j < item.testResults.length; j += chunkSizeTestResults) {
              groupedTestResults.push(item.testResults.slice(j, j + chunkSizeTestResults));
            }
            item['groupedTestResults'] = groupedTestResults;
          } else {
            //确保 groupedTestResults 属性存在，即使没有测试结果
            if(item) item['groupedTestResults'] = [];
          }
        }
      }
      return grouped;
    },
  },
  methods: {
    formatDateForPicker(dateString) {
      const parts = dateString.split('-');
      return new Date(parseInt(parts[0],10), parseInt(parts[1],10) - 1, parseInt(parts[2],10));
    },
    formatDateForSubmit(dateObj) {
      const year = dateObj.getFullYear();
      const month = ('0' + (dateObj.getMonth() + 1)).slice(-2);
      const day = ('0' + dateObj.getDate()).slice(-2);
      return `${year}-${month}-${day}`;
    },
    onDateConfirm(date) {
      this.value = this.formatDateForSubmit(date);
      this.currentDateForPicker = date;
      this.showDatePicker = false;
    },
    onSubmitGetData() {
      this.currentPage = 1;
      this.tableData = []; // 清空旧数据
      this.finished = false;
      this.loading = true;
      this.searched = true;

      this.$http.post('/demo', this.$qs.stringify({ date: this.value, radio: this.radio }))
        .then(res => {
          this.tableData = res.data.data || [];
          this.activeCollapse = new Array(this.tableData.length).fill(null);
          this.finished = true;
          this.loading = false;
        })
        .catch(error => {
          this.$toast.fail('数据获取失败');
          console.error("Error fetching data: ", error);
          this.tableData = [];
          this.loading = false;
          this.finished = true;
        });
    },
    flattenTestResults(groupedTestResults) {
      if (!groupedTestResults) return [];
      return groupedTestResults.reduce((acc, curr) => acc.concat(curr), []);
    },
    async ensureHtml2Canvas() {
      if (!this.html2canvas) {
        try {
          const module = await import('html2canvas');
          this.html2canvas = module.default;
        } catch (e) {
          this.$toast.fail('图片组件加载失败');
          console.error("Failed to load html2canvas", e);
          return false;
        }
      }
      return true;
    },
    exportToExcel() {
      this.$toast.loading({ message: '正在导出...', forbidClick: true, duration: 0 });
      const exList = [];
      (this.tableData || []).forEach(data => {
        if (data.sampleName && (data.sampleName.includes('z') || data.sampleName.includes('Z') || data.sampleName.includes('总'))) return;
        const record = {};
        record['日期'] = data.date;
        record['时间'] = data.time;
        record['样品名称'] = data.sampleName;
        for (let i = 0; i < 20; i++) {
          record[`${i + 1}`] = data.testResults && data.testResults[i] ? data.testResults[i].gram : '';
        }
        record['最大硬度'] = data.maxHardness;
        record['平均硬度'] = data.averageHardness;
        record['最小硬度'] = data.minHardness;
        exList.push(record);
      });

      const headers = ["日期", "时间", "样品名称", ...Array.from({ length: 20 }, (_, i) => `${i + 1}`), "最大硬度", "平均硬度", "最小硬度"];
      const ws_data = [headers];
      exList.forEach(row => {
        const dataRow = headers.map(header => row[header] !== undefined ? row[header] : '');
        ws_data.push(dataRow);
      });

      const ws = XLSX.utils.aoa_to_sheet(ws_data);
      const colsWidth = [{ wch: 12 }, { wch: 10 }, { wch: 20 }, ...Array(20).fill({ wch: 6 }), { wch: 12 }, { wch: 12 }, { wch: 12 }];
      ws['!cols'] = colsWidth;

      const baseCellStyle = {
        font: { sz: "11", name: "Calibri" },
        alignment: { horizontal: "center", vertical: "center", wrapText: true },
        border: { top: { style: "thin", color: { rgb: "000000" } }, bottom: { style: "thin", color: { rgb: "000000" } }, left: { style: "thin", color: { rgb: "000000" } }, right: { style: "thin", color: { rgb: "000000" } } }
      };
      const headerCellStyle = JSON.parse(JSON.stringify(baseCellStyle));
      headerCellStyle.font.bold = true;

      const range = XLSX.utils.decode_range(ws['!ref']);
      for (let R = range.s.r; R <= range.e.r; ++R) {
        for (let C = range.s.c; C <= range.e.c; ++C) {
          const cell_address = { c: C, r: R };
          const cell_ref = XLSX.utils.encode_cell(cell_address);
          if (!ws[cell_ref]) ws[cell_ref] = { t: 's', v: '' };
          ws[cell_ref].s = (R === range.s.r) ? headerCellStyle : baseCellStyle;
        }
      }
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      try {
        XLSX.writeFile(wb, `${this.value}_${this.radio === '1' ? '白班' : '夜班'}-粒子强度数据.xlsx`);
        this.$toast.success('导出成功');
      } catch (e) {
        this.$toast.fail('导出失败，请重试');
        console.error("Error writing excel file", e);
      }
    },
    async copyTableAsImage() {
      this.$toast.loading({ message: '正在生成图片...', forbidClick: true, duration: 0 });
      const ready = await this.ensureHtml2Canvas();
      if (!ready) {
        this.$toast.clear();
        return;
      }

      let shotDiv = document.createElement('div');
      shotDiv.style.position = 'absolute';
      shotDiv.style.left = '-9999px';
      shotDiv.style.top = '-9999px';
      shotDiv.style.width = '800px';
      shotDiv.style.padding = '10px';
      shotDiv.style.background = '#fff';

      let html = '<table border="1" cellspacing="0" cellpadding="3" style="border-collapse:collapse;width:100%;font-size:12px;text-align:center;font-family: Arial, sans-serif;">';
      html += '<thead><tr style="background-color:#f2f2f2; font-weight:bold;">';
      html += '<th>日期</th><th>时间</th><th>样品名称</th>';
      for (let i = 1; i <= 20; i++) html += `<th>${i}</th>`;
      html += '<th>最大硬度</th><th>平均硬度</th><th>最小硬度</th>';
      html += '</tr></thead><tbody>';

      (this.tableData || []).forEach(row => {
        if (row.sampleName && (row.sampleName.includes('z') || row.sampleName.includes('Z') || row.sampleName.includes('总'))) return;
        html += '<tr>';
        html += `<td>${row.date || ''}</td><td>${row.time || ''}</td><td>${row.sampleName || ''}</td>`;
        for (let i = 0; i < 20; i++) html += `<td>${row.testResults && row.testResults[i] ? row.testResults[i].gram : ''}</td>`;
        html += `<td>${row.maxHardness || ''}</td><td>${row.averageHardness || ''}</td><td>${row.minHardness || ''}</td>`;
        html += '</tr>';
      });
      html += '</tbody></table>';
      shotDiv.innerHTML = html;
      document.body.appendChild(shotDiv);

      try {
        const canvas = await this.html2canvas(shotDiv, {
          scale: 2, useCORS: true, backgroundColor: '#ffffff',
          width: shotDiv.offsetWidth, height: shotDiv.offsetHeight,
          scrollX: 0, scrollY: 0,
          windowWidth: shotDiv.scrollWidth, windowHeight: shotDiv.scrollHeight
        });
        // 新增：统一处理图片复制/展示
        const tryClipboard = navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined';
        if (tryClipboard) {
          canvas.toBlob(async (blob) => {
            try {
              // @ts-ignore
              const item = new ClipboardItem({ 'image/png': blob });
              await navigator.clipboard.write([item]);
              this.$toast.success('表格已复制为图片！');
            } catch (err) {
              console.error('复制图片到剪贴板失败: ', err);
              // 失败时也弹窗展示图片
              this.generatedImageUrl = canvas.toDataURL('image/png');
              this.showImageDialog = true;
              this.$toast.fail('复制失败，可长按图片保存');
            }
            this.$toast.clear();
          }, 'image/png');
        } else {
          // 不支持自动复制，直接弹窗展示图片
          this.generatedImageUrl = canvas.toDataURL('image/png');
          this.showImageDialog = true;
          this.$toast.fail('浏览器不支持自动复制图片，可长按图片保存');
          this.$toast.clear();
        }
      } catch (e) {
        console.error('html2canvas 截图失败: ', e);
        this.$toast.fail('图片生成失败');
        this.$toast.clear();
      } finally {
         if (document.body.contains(shotDiv)) {
            document.body.removeChild(shotDiv);
         }
      }
    },
    handleClose() {
        this.dialogVisible = false;
    }
  },
  created() {
    this.currentDateForPicker = this.formatDateForPicker(this.value);
  },
};
</script>

<style scoped>
.mobile-view {
  padding-bottom: 60px; /* 为底部操作按钮留出空间 */
}
.form-container {
  margin: 10px;
  padding: 10px;
  background-color: #fff;
  border-radius: 8px;
  box-shadow: 0 2px 12px 0 rgba(0,0,0,0.1);
}
.radio-group-mobile {
  margin-top: 5px;
}
.button-container {
  margin: 20px 10px;
}
.data-list-container {
  margin-top: 15px;
}
.data-card {
  margin: 10px;
  border-radius: 8px;
  overflow: hidden; /* 配合 inset cell-group */
}
.test-results-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 10px;
}
.test-result-tag {
  margin: 2px;
}
.action-buttons-container {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-around;
  padding: 10px;
  background-color: #fff;
  border-top: 1px solid #ebedf0;
  box-shadow: 0 -2px 5px rgba(0,0,0,0.05);
}
.simple-mode-container {
  padding: 10px;
  max-height: 70vh;
  overflow-y: auto;
}
.simple-mode-row {
  display: flex;
  flex-wrap: wrap; /* 允许换行 */
  justify-content: space-between; /* 在行内平均分布 */
  margin-bottom: 10px;
}
.simple-mode-card {
  border: 1px solid #eee;
  border-radius: 6px;
  padding: 8px;
  margin-bottom: 8px; /* 卡片间距 */
  background-color: #f9f9f9;
  width: calc(50% - 10px); /* 每行显示两个，并留出间隙 */
  box-sizing: border-box;
}
@media (max-width: 400px) { /* 屏幕更窄时，每行一个 */
  .simple-mode-card {
    width: 100%;
  }
}
.simple-mode-header {
  font-weight: bold;
  margin-bottom: 5px;
  font-size: 14px;
  text-align: center;
}
.simple-mode-results-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  justify-content: center;
  margin-bottom: 5px;
}
.simple-mode-tag {
  margin: 2px;
}
.simple-mode-stats {
  font-size: 12px;
  display: flex;
  justify-content: space-around;
  margin-top: 5px;
  color: #666;
}
.table-scroll-x {
  overflow-x: auto;
}
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  background: #fff;
}
.data-table th, .data-table td {
  border: 1px solid #eee;
  padding: 6px 4px;
  text-align: center;
  white-space: nowrap;
}
.data-table th {
  background: #f7f7f7;
  font-weight: bold;
}
</style>