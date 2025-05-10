<template>
  <div class="block">
    <div class="flex-container">
      <el-date-picker
          v-model="value"
          type="date"
          placeholder="选择日期"
          value-format="yyyy-MM-dd">
      </el-date-picker>
      <div class="radio-group">
        <el-radio v-model="radio" label="1" border>白班</el-radio>
        <el-radio v-model="radio" label="2" border>夜班</el-radio>
      </div>
      <el-button type="primary" @click="getData()">获取数据</el-button>
    </div>


    <el-table
        :data="tableData"

        style="width: 100%;margin-top: 3%"
        border
        @selection-change="handleSelectionChange"

    >
      <el-table-column
          type="selection"
          width="55">
      </el-table-column>
      <el-table-column
          prop="date"
          label="日期"
          width="100"
      >
      </el-table-column>
      <el-table-column
          prop="time"
          label="时间">
      </el-table-column>
      <el-table-column
          prop="sampleName"
          label="样品名称"
      >
        <template slot-scope="scope">
          <span v-if="scope.row.sampleName && (scope.row.sampleName.includes('z') || scope.row.sampleName.includes('Z') || scope.row.sampleName.includes('总'))">
            <el-tag type="warning">总分析数据</el-tag>
            {{ scope.row.sampleName }}
          </span>
          <span v-else>
            {{ scope.row.sampleName }}
          </span>
        </template>
      </el-table-column>

      <!-- 假设每个样本有5个测试结果 -->
      <el-table-column
          v-for="(item, index) in 20"
          :key="index"
          :label="`${index + 1}`"
          min-width="30"
          :prop="`testResults[${index}].gram`">
      </el-table-column>
      <el-table-column
          prop="maxHardness"
          label="最大硬度">
      </el-table-column>
      <el-table-column
          prop="averageHardness"
          label="平均硬度">
      </el-table-column>
      <el-table-column
          prop="minHardness"
          label="最小硬度">
      </el-table-column>

    </el-table>
    <div style="margin-top: 20px">
      <el-button @click="dialogVisible = true">打开简易模式</el-button>
      <el-button @click="exportToExcel">导出 Excel</el-button>
      <el-button @click="copyTableAsImage">复制表格为图片</el-button>
    </div>


    <el-dialog
        title="粒子强度数据"
        :visible.sync="dialogVisible"
        width="80vw"
        :before-close="handleClose">
      <!--      简易模式数据-->
      <el-row :gutter="50" v-for="(row, rowIndex) in groupedTableDate" :key="rowIndex"
              style="width: 70vw; margin: 0 auto;">
        <el-col :span="6" v-for="(item, colIndex) in row" :key="colIndex">
          <div class="grid-content bg-purple" style="  border: 1px solid #000; /* 添加黑色边框 */
  margin: 5px; /* 增加间距 */;text-align: center">
            <h1>{{ item.line }}线</h1>
            <h2>{{item.time}}</h2>
            <el-row :gutter="1" v-for="(innerRow, innerRowIndex) in item.groupedTestResults" :key="innerRowIndex"
                    type="flex" justify="center">
              <el-col :span="4" v-for="(innerItem, innerColIndex) in innerRow" :key="innerColIndex">
                <div class="nested-content bg-lightblue">
                  {{ innerItem.gram }}
                </div>
              </el-col>
            </el-row>
            <el-row :gutter="10" type="flex" justify="center" style="margin: 1vh auto;">
              <el-col :span="8">
                最大:{{ item.maxHardness }}
              </el-col>
              <el-col :span="8">
                平均:{{ item.averageHardness }}
              </el-col>
              <el-col :span="8">
                最小:{{ item.minHardness }}
              </el-col>

            </el-row>
          </div>
        </el-col>
      </el-row>
      <span slot="footer" class="dialog-footer">
    <el-button @click="dialogVisible = false">取 消</el-button>
    <el-button type="primary" @click="dialogVisible = false">确 定</el-button>
  </span>
    </el-dialog>


  </div>

</template>

<script>
// eslint-disable-next-line no-unused-vars
import * as XLSX from 'xlsx';

export default {
  name: 'HelloWorld',
  data() {
    const today = new Date();
    // eslint-disable-next-line no-unused-vars
    const formattedDate = today.getFullYear() + '-' +
        ('0' + (today.getMonth() + 1)).slice(-2) + '-' +
        ('0' + today.getDate()).slice(-2);
    return {
      value: formattedDate,
      radio: '1',
      tableData: '',
      dialogVisible: false,
      selection: [],
      html2canvas: null // 添加html2canvas引用
    }
  },
  created() {
    // 预先加载html2canvas
    import('html2canvas').then(module => {
      this.html2canvas = module.default;
    });
  },
  computed: {
    groupedTableDate() {
      const chunkSize = 4;
      const grouped = [];
      for (let i = 0; i < this.selection.length; i += chunkSize) {
        grouped.push(this.selection.slice(i, i + chunkSize));
      }
      for (const groupedElement of grouped) {
        for (const groupedElementElement of groupedElement) {
          const groupedTestResults = [];
          const chunkSizeTestResults = 5;
          for (let i = 0; i < (groupedElementElement.testResults ? groupedElementElement.testResults.length : 0); i += chunkSizeTestResults) {
            groupedTestResults.push(groupedElementElement.testResults.slice(i, i + chunkSizeTestResults));
          }
          groupedElementElement['groupedTestResults'] = groupedTestResults
        }
      }
      return grouped;
    },
  },
  methods: {
    handleSelectionChange(selection) {
      this.selection = selection.sort((a, b) => this.tableData.indexOf(a) - this.tableData.indexOf(b))
    },
    getData() {
      this.$http.post('/demo', this.$qs.stringify({date: this.value, radio: this.radio})).then(res => {
        this.tableData = res.data.data
      })
    },
    exportToExcel() {
      const exList = [];
      // 导出全部非总分析数据
      (this.tableData || []).forEach(data => {
        if (data.sampleName && (data.sampleName.includes('z') || data.sampleName.includes('Z') || data.sampleName.includes('总'))) return;
        const record = {};
        record['日期'] = data.date;
        record['时间'] = data.time;
        record['样品名称'] = data.sampleName;
        for (let i = 0; i < 20; i++) {
          // 使用数字作为列名，以匹配 copyTableAsImage 的表头
          record[`${i + 1}`] = data.testResults && data.testResults[i] ? data.testResults[i].gram : '';
        }
        record['最大硬度'] = data.maxHardness;
        record['平均硬度'] = data.averageHardness;
        record['最小硬度'] = data.minHardness;
        exList.push(record);
      });

      // 定义表头顺序和名称，这些将是Excel中的列标题
      const headers = [
        "日期", "时间", "样品名称",
        ...Array.from({ length: 20 }, (_, i) => `${i + 1}`), // 列名为 '1', '2', ..., '20'
        "最大硬度", "平均硬度", "最小硬度"
      ];
      
      // 1. 创建表头行
      const ws_data = [headers];
      // 2. 添加数据行
      exList.forEach(row => {
        const dataRow = headers.map(header => row[header] !== undefined ? row[header] : ''); // 确保顺序并处理 undefined
        ws_data.push(dataRow);
      });

      const ws = XLSX.utils.aoa_to_sheet(ws_data);

      // 定义列宽
      const colsWidth = [
        { wch: 12 }, // 日期
        { wch: 10 }, // 时间
        { wch: 20 }, // 样品名称
        ...Array(20).fill({ wch: 6 }), // 测试1-20
        { wch: 12 }, // 最大硬度
        { wch: 12 }, // 平均硬度
        { wch: 12 }  // 最小硬度
      ];
      ws['!cols'] = colsWidth;

      // 定义基础单元格样式
      const baseCellStyle = {
        font: { sz: "11", name: "Calibri" }, // 字体大小11磅, Calibri字体 (近似14px)
        alignment: { horizontal: "center", vertical: "center", wrapText: true }, // 水平垂直居中，自动换行
        border: { // 黑色细边框
          top: { style: "thin", color: { rgb: "000000" } },
          bottom: { style: "thin", color: { rgb: "000000" } },
          left: { style: "thin", color: { rgb: "000000" } },
          right: { style: "thin", color: { rgb: "000000" } }
        }
      };
      
      // 表头单元格样式（基础样式上加粗）
      const headerCellStyle = JSON.parse(JSON.stringify(baseCellStyle)); // 深拷贝
      headerCellStyle.font.bold = true;

      // 应用样式到所有单元格
      const range = XLSX.utils.decode_range(ws['!ref']);
      for (let R = range.s.r; R <= range.e.r; ++R) {
        for (let C = range.s.c; C <= range.e.c; ++C) {
          const cell_address = { c: C, r: R };
          const cell_ref = XLSX.utils.encode_cell(cell_address);
          if (!ws[cell_ref]) ws[cell_ref] = { t: 's', v: '' }; // 确保单元格对象存在
          
          if (R === range.s.r) { // 如果是表头行 (通常是第一行, R=0)
            ws[cell_ref].s = headerCellStyle;
          } else { // 数据行
            ws[cell_ref].s = baseCellStyle;
          }
        }
      }

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      XLSX.writeFile(wb, this.value + (this.radio === '1' ? '白班' : '夜班') + "-粒子强度数据.xlsx");
    },
    copyTableAsImage() {
      if (!this.html2canvas) {
        this.$message.error('图片生成组件未加载完成，请稍后重试');
        return;
      }
      const table = this.$el.querySelector('.el-table');
      if (!table) {
        this.$message.error('未找到表格');
        return;
      }
      // 1. 创建隐藏截图表格容器
      let shotDiv = document.createElement('div');
      shotDiv.style.position = 'fixed';
      shotDiv.style.left = '-9999px';
      shotDiv.style.top = '0';
      shotDiv.style.background = '#fff';
      shotDiv.style.zIndex = '-1';
      shotDiv.style.width = 'auto';
      shotDiv.style.maxWidth = '1200px';
      shotDiv.style.minWidth = '900px';
      shotDiv.style.padding = '10px';
      // 2. 构造表头
      let html = '<table border="1" cellspacing="0" cellpadding="2" style="border-collapse:collapse;width:100%;font-size:14px;text-align:center;">';
      html += '<thead><tr>';
      html += '<th>日期</th><th>时间</th><th>样品名称</th>';
      for(let i=1;i<=20;i++) html += `<th>${i}</th>`;
      html += '<th>最大硬度</th><th>平均硬度</th><th>最小硬度</th>';
      html += '</tr></thead><tbody>';
      // 3. 构造表体（过滤总分析数据）
      (this.tableData||[]).forEach(row => {
        if(row.sampleName && (row.sampleName.includes('z') || row.sampleName.includes('Z') || row.sampleName.includes('总'))) return;
        html += '<tr>';
        html += `<td>${row.date||''}</td><td>${row.time||''}</td><td>${row.sampleName||''}</td>`;
        for(let i=0;i<20;i++) html += `<td>${row.testResults&&row.testResults[i]?row.testResults[i].gram:''}</td>`;
        html += `<td>${row.maxHardness||''}</td><td>${row.averageHardness||''}</td><td>${row.minHardness||''}</td>`;
        html += '</tr>';
      });
      html += '</tbody></table>';
      shotDiv.innerHTML = html;
      document.body.appendChild(shotDiv);
      // 4. 使用预加载的html2canvas截图
      this.html2canvas(shotDiv, {
        backgroundColor: '#fff',
        scale: 2,
        width: shotDiv.offsetWidth
      }).then(canvas => {
        document.body.removeChild(shotDiv);
        canvas.toBlob(blob => {
          if (navigator.clipboard && window.ClipboardItem) {
            const item = new window.ClipboardItem({ 'image/png': blob });
            navigator.clipboard.write([item]).then(() => {
              this.$message.success('表格已复制为图片，可直接粘贴！');
            }, () => {
              this.$message.error('复制失败，可能浏览器不支持');
            });
          } else {
            this.$message.error('当前环境不支持图片复制到剪贴板');
          }
        });
      });
    },
  },


}
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
h3 {
  margin: 40px 0 0;
}

ul {
  list-style-type: none;
  padding: 0;
}

li {
  display: inline-block;
  margin: 0 10px;
}

a {
  color: #42b983;
}

.bordered {
  border: 1px solid #000; /* 添加黑色边框 */
  margin: 5px; /* 增加间距 */
}

.flex-container {
  display: flex;
  justify-content: center; /* 水平居中子元素 */
  /* 添加以下样式来居中整个容器 */
  width: 100%; /* 容器宽度为100% */
  justify-content: center; /* 水平居中 */


}

.radio-group {
  display: flex;
  margin-left: 5vw;
  margin-right: 5vw;
  align-items: center;
}

</style>
