<script setup>
import { ref, computed, onMounted, watch, onUnmounted } from 'vue'; // 导入 Vue 相关模块, 添加 onUnmounted
import { ElMessage, ElMessageBox, ElConfigProvider, ElAlert, ElNotification } from 'element-plus'; // 导入 Element Plus 组件, 添加 ElNotification
import zhCn from 'element-plus/dist/locale/zh-cn.mjs'; // 导入 Element Plus 中文语言包
import * as XLSX from 'xlsx'; // 导入 xlsx 库用于 Excel 操作

// --- 简单防抖函数 ---
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}


// --- 响应式状态定义 ---
// 辅助函数：获取初始日期字符串 (格式：YYYY-MM-DD)
const getInitialDateString = () => {
   const today = new Date();
   const year = today.getFullYear();
   const month = String(today.getMonth() + 1).padStart(2, '0');
   const day = String(today.getDate()).padStart(2, '0');
   return `${year}-${month}-${day}`;
};
const selectedDate = ref(getInitialDateString()); // 当前选中的日期 (格式：YYYY-MM-DD)
const selectedShift = ref('day'); // 当前选中的班次 ('day' 或 'night')
const tableData = ref([]); // 当前表格显示的数据
const allData = ref([]); // 从后端获取的原始数据（包含选定日期和次日，用于班次过滤）
const loading = ref(false); // 是否正在加载数据
const selectedRows = ref([]); // 表格中当前选中的行
const dialogVisible = ref(false); // "简易模式"对话框是否可见
// const simpleModeData = ref([]); // 不再需要，使用计算属性 groupedSimpleModeData

// 数据目录路径状态
const dataPathInput = ref(''); // 用于显示和编辑的数据目录路径
// 当前视图标题状态
const currentViewTitle = ref(''); // 用于显示特殊视图（例如"昨日完整数据"）的标题
// 文件监控状态提示文本
const monitoringStatusText = ref('');

// --- 辅助函数 ---
// 格式化 Date 对象或日期字符串为 YYYY-MM-DD 字符串
const formatDateToYYYYMMDD = (dateInput) => {
  let dateObj;
  if (dateInput instanceof Date && !isNaN(dateInput.getTime())) {
    dateObj = dateInput;
  } else if (typeof dateInput === 'string' && dateInput) {
    dateObj = new Date(dateInput);
    if (isNaN(dateObj.getTime())) {
      return ''; // 对无效字符串返回空
    }
  } else {
    return ''; // 对其他无效输入返回空
  }

  if (!(dateObj instanceof Date) || isNaN(dateObj.getTime())) {
    // 如果输入无效，返回空字符串或进行错误处理
    // 尝试从 selectedDate.value 恢复（如果它是有效的字符串）
    if (typeof selectedDate.value === 'string' && selectedDate.value) {
       const parsedDate = new Date(selectedDate.value);
       if (!isNaN(parsedDate.getTime())) {
           dateObj = parsedDate;
       } else {
           return ''; // 仍然无效，返回空
       }
    } else {
       return ''; // 无法恢复，返回空
    }
  }
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, '0'); // 月份从0开始，需要+1
  const day = String(dateObj.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};


// --- 计算属性 ---

// 计算属性：为"简易模式"准备分组数据
const groupedSimpleModeData = computed(() => {
  if (!selectedRows.value || selectedRows.value.length === 0) { // 如果没有选中行
    return [];
  }

  const chunkSize = 4; // "简易模式"中每行显示的项目数
  const grouped = [];
  // 确保按表格中的原始顺序处理选中的行
  const sortedSelection = [...selectedRows.value].sort((a, b) => tableData.value.indexOf(a) - tableData.value.indexOf(b));

  for (let i = 0; i < sortedSelection.length; i += chunkSize) {
    const chunk = sortedSelection.slice(i, i + chunkSize); // 获取当前块的数据
    // 为块中的每个项目处理其内部的 testResults 分组（用于简易模式的内部网格）
    const processedChunk = chunk.map(item => {
      const groupedTestResults = [];
      const testChunkSize = 5; // 每个项目内部的测试结果每行显示5个
      if (item.testResults && Array.isArray(item.testResults)) {
        for (let j = 0; j < item.testResults.length; j += testChunkSize) {
          groupedTestResults.push(item.testResults.slice(j, j + testChunkSize)); // 分割测试结果
        }
      }
      // 返回包含处理后 groupedTestResults 的新对象
      return { ...item, groupedTestResults };
    });
    grouped.push(processedChunk);
  }
  return grouped;
});


// 计算属性：根据选定的班次过滤和排序数据
const filteredAndSortedData = computed(() => {
 if (!allData.value || allData.value.length === 0) { // 如果没有原始数据
   return [];
 }

 let filtered = []; // 过滤后的数据
 // 确保 selectedDate.value 是有效的日期字符串或 Date 对象
 let validSelectedDate;
 if (selectedDate.value instanceof Date && !isNaN(selectedDate.value)) { // 如果是有效的 Date 对象
     validSelectedDate = selectedDate.value;
 } else if (typeof selectedDate.value === 'string' && selectedDate.value) { // 如果是有效的日期字符串
     const parsed = new Date(selectedDate.value);
     if (!isNaN(parsed)) {
         validSelectedDate = parsed; // 解析成功
     }
 }

 if (!validSelectedDate) {
     return []; // 如果日期无效，返回空数组
 }


 const selectedDayStart = new Date(validSelectedDate);
 selectedDayStart.setHours(0, 0, 0, 0); // 当天零点

 const selectedDayEnd = new Date(validSelectedDate);
 selectedDayEnd.setHours(23, 59, 59, 999); // 当天结束

 const nextDayStart = new Date(validSelectedDate);
 nextDayStart.setDate(nextDayStart.getDate() + 1);
 nextDayStart.setHours(0, 0, 0, 0); // 次日零点

 const dayShiftStartHour = 7; // 白班开始小时 (7:00)
 const dayShiftEndHour = 19; // 白班结束小时 (不含19:00)
 const nightShiftStartHour = 19; // 夜班开始小时 (19:00)
 const nightShiftEndHour = 7; // 夜班结束小时 (不含7:00)

 if (selectedShift.value === 'day') {
   // 白班: 当天 7:00:00 到 当天 18:59:59.999
   const dayShiftStartTime = new Date(selectedDayStart);
   dayShiftStartTime.setHours(dayShiftStartHour, 0, 0, 0);
   const dayShiftEndTime = new Date(selectedDayStart);
   dayShiftEndTime.setHours(dayShiftEndHour - 1, 59, 59, 999); // 结束于 18:59:59.999

   // 辅助函数：将 "HH:MM:SS" 解析为可比较的秒数
   const parseTime = (timeStr) => {
       if (!timeStr || typeof timeStr !== 'string') return null;
       const parts = timeStr.split(':');
       if (parts.length !== 3) return null;
       const h = parseInt(parts[0], 10);
       const m = parseInt(parts[1], 10);
       const s = parseInt(parts[2], 10);
       if (isNaN(h) || isNaN(m) || isNaN(s)) return null;
       // 返回从午夜开始的总秒数，便于比较
       return h * 3600 + m * 60 + s;
   };
   const dayStartSeconds = dayShiftStartHour * 3600; // 7 * 3600 = 25200
   const dayEndSeconds = dayShiftEndHour * 3600;     // 19 * 3600 = 68400

   filtered = allData.value.filter(item => {
     if (!item.date || !item.time) return false;
     const itemDateStr = item.date; // YYYY-MM-DD 字符串
     const selectedDateStr = formatDateToYYYYMMDD(selectedDayStart); // 使用辅助函数
     const itemTimeSeconds = parseTime(item.time);

     if (itemTimeSeconds === null || !selectedDateStr) {
         return false; // 跳过时间或日期格式无效的项目
     }

     let included = false; // 默认不包含
     const dateMatch = itemDateStr === selectedDateStr;

     // 检查项目日期是否为选定日期
     if (dateMatch) {
         // 检查时间是否在 7:00:00 (含) 到 19:00:00 (含) 之间
         included = itemTimeSeconds >= dayStartSeconds && itemTimeSeconds <= dayEndSeconds;
     }
     return included;
   });
 } else {
   // 夜班: 当天 19:00:00 到 次日 06:59:59.999
   const nightShiftStartTime = new Date(selectedDayStart);
   nightShiftStartTime.setHours(nightShiftStartHour, 0, 0, 0);
   const nightShiftEndTime = new Date(nextDayStart); // 使用次日零点
   nightShiftEndTime.setHours(nightShiftEndHour - 1, 59, 59, 999); // 结束于次日 06:59:59.999

   // 辅助函数 (同上)
   const parseTime = (timeStr) => {
       if (!timeStr || typeof timeStr !== 'string') return null;
       const parts = timeStr.split(':');
       if (parts.length !== 3) return null;
       const h = parseInt(parts[0], 10);
       const m = parseInt(parts[1], 10);
       const s = parseInt(parts[2], 10);
       if (isNaN(h) || isNaN(m) || isNaN(s)) return null;
       return h * 3600 + m * 60 + s;
   };
   const nightStartSeconds = nightShiftStartHour * 3600; // 19 * 3600 = 68400
   const nightEndSeconds = nightShiftEndHour * 3600;     // 7 * 3600 = 25200

   filtered = allData.value.filter(item => {
     if (!item.date || !item.time) return false;
     const itemDateStr = item.date; // YYYY-MM-DD 字符串
     const selectedDateStr = formatDateToYYYYMMDD(selectedDayStart); // 使用辅助函数
     const nextDateStr = formatDateToYYYYMMDD(nextDayStart);       // 使用辅助函数
     const itemTimeSeconds = parseTime(item.time);

      if (itemTimeSeconds === null || !selectedDateStr || !nextDateStr) {
         return false; // 跳过时间或日期格式无效的项目
     }

     // 检查项目是否来自选定日期且时间是 19:00:00 或之后
     const isSelectedDayNight = (itemDateStr === selectedDateStr && itemTimeSeconds >= nightStartSeconds);
     // 检查项目是否来自次日且时间严格早于 07:00:00
     const isNextDayMorning = (itemDateStr === nextDateStr && itemTimeSeconds < nightEndSeconds);

     const included = isSelectedDayNight || isNextDayMorning;
     return included;
   });
 }

 // 按日期和时间排序
 return filtered.sort((a, b) => {
     // 确保 a 和 b 都有有效的 date 和 time
     if (!a.date || !a.time || !b.date || !b.time) {
         // 如果任一记录缺少日期或时间，不改变它们的相对顺序
         return 0;
     }
     try {
         const dateTimeA = new Date(`${a.date}T${a.time}`);
         const dateTimeB = new Date(`${b.date}T${b.time}`);
         // 检查日期是否有效
         if (isNaN(dateTimeA) || isNaN(dateTimeB)) {
             return 0; // 无效日期不改变顺序
         }
         return dateTimeA - dateTimeB; // 时间升序
     } catch (e) {
         return 0; // 出错时不改变顺序
     }
 });
});


// --- 方法 ---
// 获取数据
const getData = async () => {
  // 增加判断，如果日期无效则不查询
  if (!selectedDate.value || (typeof selectedDate.value === 'string' && !selectedDate.value)) {
      ElMessage.warning('请选择一个有效的日期');
      return;
  }
  // 增加判断，如果正在加载中，则不重复查询
  if (loading.value) {
      return;
  }

  loading.value = true;
  allData.value = []; // 清空旧数据
  tableData.value = [];

  try {
    // 确保 selectedDate 是 Date 对象或有效日期字符串
    let dateToFetch;
    if (selectedDate.value instanceof Date && !isNaN(selectedDate.value)) {
        dateToFetch = selectedDate.value;
    } else if (typeof selectedDate.value === 'string' && selectedDate.value) {
        dateToFetch = new Date(selectedDate.value);
        if (isNaN(dateToFetch.getTime())) {
             ElMessage.error('无效的日期格式');
             loading.value = false;
             return;
        }
    } else {
         // 这个分支理论上不会进入，因为前面加了判断
         ElMessage.error('请选择一个有效的日期');
         loading.value = false;
         return;
     }

     const dateStr = dateToFetch.toISOString().split('T')[0]; // 格式化日期为 YYYY-MM-DD

     // 获取选定日期的数据 (主进程会使用其内部保存的 basePath)
     const todayData = await window.electronAPI.invokeReadReports(dateStr);
     if (todayData && Array.isArray(todayData)) {
         allData.value.push(...todayData);
     }

     // 获取第二天的数据 (总是获取，以便班次切换时数据完整)
     const nextDay = new Date(dateToFetch);
     nextDay.setDate(nextDay.getDate() + 1);
     const nextDateStr = nextDay.toISOString().split('T')[0];
     const nextDayData = await window.electronAPI.invokeReadReports(nextDateStr);
     if (nextDayData && Array.isArray(nextDayData)) {
         allData.value.push(...nextDayData);
     }

    // 数据获取完毕后，触发 computed 属性更新 tableData
    tableData.value = filteredAndSortedData.value;
    currentViewTitle.value = ''; // 清除特殊视图标题，表示是标准查询

    if (tableData.value.length === 0) {
        ElMessage.info('当前日期和班次没有数据。'); // 保留这个用户提示
    }

  } catch (error) {
    console.error('获取报告数据失败:', error); // 保留错误日志
    ElMessage.error(`获取报告数据失败: ${error.message || error}`);
    allData.value = []; // 出错时清空
    tableData.value = [];
  } finally {
    loading.value = false;
  }
};

// 处理表格行选中变化
const handleSelectionChange = (val) => {
  selectedRows.value = val;
};

// 导出到 Excel
const exportToExcel = () => {
  if (selectedRows.value.length === 0) {
    ElMessage.warning('请先选择要导出的行！');
    return;
  }

  try {
    // 提取选中行的数据用于导出
    // 准备导出数据，匹配旧项目格式
    const dataToExport = selectedRows.value.map(row => {
      const exportRow = {
        '日期': row.date,
        '时间': row.time,
        '产线': row.line,
        '样品名称': row.sampleName,
        '最大硬度': row.maxHardness,
        '最小硬度': row.minHardness,
        '平均硬度': row.averageHardness,
        // '总测试数': row.totalTests, // 旧项目导出似乎没有这两个字段
        // '无效测试数': row.invalidTests,
      };
      // 添加最多20个测试结果
      for (let i = 0; i < 20; i++) {
        exportRow[`测试${i + 1}`] = row.testResults && row.testResults[i] ? row.testResults[i].gram : ''; // 如果没有测试结果则为空字符串
      }
      return exportRow;
    });

    const worksheet = XLSX.utils.json_to_sheet(dataToExport);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1'); // Sheet 名称与旧项目一致

    // 生成文件名，与旧项目一致
    let dateStrToUse = '';
    if (selectedDate.value instanceof Date && !isNaN(selectedDate.value)) {
        dateStrToUse = selectedDate.value.toISOString().split('T')[0];
    } else if (typeof selectedDate.value === 'string' && selectedDate.value) {
        const parsedDate = new Date(selectedDate.value);
        if (!isNaN(parsedDate)) {
            dateStrToUse = parsedDate.toISOString().split('T')[0];
        }
    }
    if (!dateStrToUse) {
        // 如果日期无效，使用当前日期作为备选
        dateStrToUse = new Date().toISOString().split('T')[0];
        ElMessage.warning('选定日期无效，导出文件名将使用当前日期。');
    }


    const shiftStr = selectedShift.value === 'day' ? '白班' : '夜班';
    const fileName = `${dateStrToUse}${shiftStr}-粒子强度数据.xlsx`;

    // 触发下载
    XLSX.writeFile(workbook, fileName);
    ElMessage.success('成功导出到 Excel！');
  } catch (error) {
    console.error('导出 Excel 失败:', error); // 保留错误日志
    ElMessage.error(`导出 Excel 失败: ${error.message || error}`);
  }
};

// 显示"简易模式"对话框
const showSimpleMode = () => {
  if (selectedRows.value.length === 0) {
    ElMessage.warning('请先选择要查看简易模式的行！');
    return;
  }
  // 准备简易模式数据 - 这部分逻辑由计算属性 groupedSimpleModeData 处理
  dialogVisible.value = true;
};

// 打开目录选择对话框 (调用主进程)
const openDirectory = async () => {
  if (window.electronAPI && typeof window.electronAPI.openDirectoryDialog === 'function') {
    const selectedPath = await window.electronAPI.openDirectoryDialog();
    if (selectedPath) {
      dataPathInput.value = selectedPath; // 更新输入框显示
    }
  } else {
    ElMessage.error('Electron API 未加载或 openDirectoryDialog 不可用。');
  }
};

// 保存数据目录路径 (调用主进程)
const saveDataPath = async () => {
  if (!dataPathInput.value) {
    ElMessage.warning('请选择一个有效的数据目录路径。');
    return;
  }
  if (window.electronAPI && typeof window.electronAPI.setDataPath === 'function') {
    const result = await window.electronAPI.setDataPath(dataPathInput.value);
    if (result.success) {
      ElMessage.success(result.message);
      // 路径保存成功后，重新加载当前选定日期的数据
      getData();
    } else {
      ElMessage.error(result.message);
    }
  } else {
    ElMessage.error('Electron API 未加载或 setDataPath 不可用。');
  }
};

// 加载昨日完整数据 (昨日白班 + 昨日夜班)
const loadYesterdayCompleteData = async () => {
  if (loading.value) {
    return;
  }
  loading.value = true;
  allData.value = []; // 清空旧数据
  tableData.value = [];

  try {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1); // 昨天
    const today = new Date(now); // 今天 (用于获取昨天夜班的后半部分)

    const yesterdayStr = formatDateToYYYYMMDD(yesterday);
    const todayStr = formatDateToYYYYMMDD(today);

    const yesterdayRawData = await window.electronAPI.invokeReadReports(yesterdayStr);
    if (yesterdayRawData && Array.isArray(yesterdayRawData)) {
      allData.value.push(...yesterdayRawData);
    }

    const todayRawData = await window.electronAPI.invokeReadReports(todayStr);
    if (todayRawData && Array.isArray(todayRawData)) {
      allData.value.push(...todayRawData);
    }

    // 定义昨天完整工作日的时间范围 (昨天 07:00:00 到 今天 06:59:59.999)
    const yesterdayShiftStart = new Date(yesterday);
    yesterdayShiftStart.setHours(7, 0, 0, 0); // 昨天 7 点

    const yesterdayShiftEnd = new Date(today);
    yesterdayShiftEnd.setHours(6, 59, 59, 999); // 今天 7 点前

    // 过滤 allData 中属于昨天完整工作日的数据，并排除特定样品名称
    const yesterdayCompleteFiltered = allData.value.filter(item => {
      if (!item.date || !item.time) return false; // 必须有日期和时间

      // 检查样品名称是否包含 '总' 或 'z' (不区分大小写)
      const sampleName = String(item.sampleName ?? '').toLowerCase(); // 转换为小写字符串，处理 null/undefined
      if (sampleName.includes('总') || sampleName.includes('z')) {
        return false; // 如果包含，则排除此项
      }

      // 检查时间是否在范围内
      try {
        const itemDateTime = new Date(`${item.date}T${item.time}`);
        // 检查日期是否有效且在时间范围内
        return !isNaN(itemDateTime) && itemDateTime >= yesterdayShiftStart && itemDateTime <= yesterdayShiftEnd;
      } catch (e) {
        return false;
      }
    });

    // 按产线分组，然后按日期时间排序
    yesterdayCompleteFiltered.sort((a, b) => {
      // 确保关键字段存在，将缺少字段的项排在后面
      const aLine = String(a.line ?? ''); // 使用 ?? 处理 null/undefined 并转为字符串
      const bLine = String(b.line ?? ''); // 使用 ?? 处理 null/undefined 并转为字符串
      const aDate = a.date;
      const aTime = a.time;
      const bDate = b.date;
      const bTime = b.time;

      // 检查日期和时间是否存在
      const aHasDateTime = aDate && aTime;
      const bHasDateTime = bDate && bTime;

      if (!aHasDateTime) return 1; // 将缺少日期/时间的项排在后面
      if (!bHasDateTime) return -1; // 将缺少日期/时间的项排在后面

      // 1. 按产线排序 (字符串比较)
      const lineCompare = aLine.localeCompare(bLine);
      if (lineCompare !== 0) {
        return lineCompare;
      }

      // 2. 如果产线相同，则按日期时间排序
      try {
        const dateTimeA = new Date(`${aDate}T${aTime}`);
        const dateTimeB = new Date(`${bDate}T${bTime}`);
        // 处理无效日期，将其排在后面
        if (isNaN(dateTimeA)) return 1;
        if (isNaN(dateTimeB)) return -1;
        return dateTimeA - dateTimeB; // 时间升序
      } catch (e) {
        return 0; // 出错时保持原始相对顺序
      }
    });

    tableData.value = yesterdayCompleteFiltered;
    currentViewTitle.value = '当前显示：昨日完整数据 (昨日 7:00 - 今日 7:00)'; // 设置特殊视图标题

    if (tableData.value.length === 0) {
      ElMessage.info('昨天没有数据。');
    } else {
      ElMessage.success(`成功加载昨日 ${tableData.value.length} 条数据。`);
      // 成功加载数据后，更新文件监控状态
      monitoringStatusText.value = '已加载昨日完整数据，文件监控暂停。';
      // 可选：更新日期选择器和班次选择器以反映加载的数据范围，但这可能与用户预期不符
      // selectedDate.value = yesterdayStr;
      // selectedShift.value = 'day'; // 或者保持不变
    }

  } catch (error) {
    console.error('加载昨日完整数据失败:', error); // 保留错误日志
    let errorMsg = '加载昨日完整数据失败';
    
    // 增强错误信息的详细度
    if (error.code === 'ENOENT') {
      errorMsg += ': 找不到数据文件或目录';
    } else if (error.code === 'EACCES') {
      errorMsg += ': 没有读取数据文件的权限';
    } else if (error.message && error.message.includes('网络')) {
      errorMsg += ': 网络连接问题';
    } else if (error.message) {
      errorMsg += `: ${error.message}`;
    } else {
      errorMsg += `: ${error}`;
    }
    
    ElMessage.error(errorMsg);
    allData.value = []; // 出错时清空
    tableData.value = [];
    currentViewTitle.value = ''; // 出错时清空标题
  } finally {
    loading.value = false;
  }
};

// 取消"昨日完整数据"视图，返回标准查询视图
const cancelYesterdayView = () => {
  currentViewTitle.value = ''; // 清除特殊标题
  getData(); // 重新加载标准数据 (基于当前选定的日期和班次)
  // 重新触发对当前选定日期的监控
  triggerWatcherUpdate(selectedDate.value);
};


// --- 侦听器 ---
// 函数：触发主进程更新文件监视器，并更新UI提示
const triggerWatcherUpdate = async (dateToWatch, shiftToWatch) => { // 添加 shiftToWatch 参数
    const dateString = formatDateToYYYYMMDD(dateToWatch); // 格式化日期
    if (dateString && shiftToWatch && window.electronAPI && typeof window.electronAPI.watchDataDirectory === 'function') { // 检查 shiftToWatch
        try {
            // 调用 IPC 时传递日期和班次
            await window.electronAPI.watchDataDirectory(dateString, shiftToWatch);
            // 更新监控状态提示文本
            const shiftText = shiftToWatch === 'day' ? '白班' : '夜班';
            let statusMsg = `正在监控 ${dateString} ${shiftText}数据目录，做出新的强度时自动刷新。`;
            if (shiftToWatch === 'night') {
                // 计算次日日期并添加到提示
                try {
                    const currentDate = new Date(dateString);
                    currentDate.setDate(currentDate.getDate() + 1);
                    const nextDateString = formatDateToYYYYMMDD(currentDate);
                    if (nextDateString) {
                        statusMsg = `正在监控 ${dateString} 至 ${nextDateString} ${shiftText}数据目录，做出新的强度时自动刷新。`;
                    }
                } catch (e) { /* 忽略日期计算错误 */ }
            }
            monitoringStatusText.value = statusMsg;
        } catch (error) {
            console.error(`[App.vue] 调用 watchDataDirectory (${dateString}, ${shiftToWatch}) 出错:`, error); // 保留错误日志
            ElMessage.error(`无法启动文件监控: ${error.message}`);
            monitoringStatusText.value = '文件监控启动失败。'; // 更新状态提示
        }
    } else if (!dateString) {
         // 日期无效，不执行操作
    } else {
         // API 不可用，可能在挂载时已提示过
    }
};


// 侦听选定日期和班次的变化，自动触发数据查询和文件监控更新
watch([selectedDate, selectedShift], (newValues, oldValues) => {
  const newDate = newValues[0];
  const oldDate = oldValues ? oldValues[0] : null; // 处理初始运行 oldValues 可能为 undefined 的情况
  const newShift = newValues[1];
  const oldShift = oldValues ? oldValues[1] : null;

  // 使用辅助函数检查有效性并格式化
  const newDateString = formatDateToYYYYMMDD(newDate);
  const oldDateString = formatDateToYYYYMMDD(oldDate); // 也格式化旧日期以便比较
  const newDateIsValid = !!newDateString; // 如果格式化后不是空字符串则有效

  const dateChanged = newDateString !== oldDateString; // 日期是否改变
  const shiftChanged = newShift !== oldShift; // 班次是否改变

  if ((dateChanged || shiftChanged) && newDateIsValid) {
      getData(); // 获取新日期/班次组合的数据
      // 只要日期或班次变化，就更新监控
      triggerWatcherUpdate(newDateString, newShift); // 传递日期和班次
  } else if (!newDateIsValid) {
      // 新日期无效
      tableData.value = [];
      allData.value = [];
      if (newValues[0] !== null && newValues[0] !== undefined) { // 避免在日期被清除时显示错误
          ElMessage.warning('选择的日期无效，无法查询数据。');
      }
  }
}, { immediate: false }); // immediate: false 避免在初始加载时触发


// --- 防抖处理的数据刷新函数 ---
const debouncedGetData = debounce(getData, 1000); // 1秒防抖

// --- 生命周期钩子 ---
// 组件挂载后执行：获取初始数据和数据目录路径，并启动初始文件监控和监听
onMounted(async () => {
  // 确保 electronAPI 可用后再调用
  if (window.electronAPI && typeof window.electronAPI.invokeReadReports === 'function') {
    // 获取并显示当前数据目录路径
    if (typeof window.electronAPI.getDataPath === 'function') {
        dataPathInput.value = await window.electronAPI.getDataPath();
    } else {
        ElMessage.error('无法获取数据目录配置。');
    }


    // 检查初始日期是否有效
    let initialDateIsValid = false;
    if (selectedDate.value instanceof Date && !isNaN(selectedDate.value)) {
        initialDateIsValid = true;
    } else if (typeof selectedDate.value === 'string' && selectedDate.value) {
        const parsed = new Date(selectedDate.value);
        if (!isNaN(parsed)) {
            initialDateIsValid = true;
        }
    }

    if (initialDateIsValid) {
        await getData(); // 初始加载时仍然需要调用一次 (设为 await)
        // 初始数据加载后，触发对初始日期和班次的监控
        triggerWatcherUpdate(selectedDate.value, selectedShift.value); // 传递初始日期和班次
    } else {
        ElMessage.warning('初始日期无效，请选择一个有效日期。');
    }
  } else {
    // API 不可用
     ElMessage.error('无法连接到后端服务，请检查 Electron 环境配置。');
  }

  // 设置文件变化监听器
  if (window.electronAPI && typeof window.electronAPI.onDataDirectoryChanged === 'function') {
    window.electronAPI.onDataDirectoryChanged((_event, data) => {
      console.log('[App.vue] 收到文件变化通知:', data); // 保留此日志用于确认接收到通知
      // 使用 Notification 显示持久刷新提示
      ElNotification({
        title: '数据更新提示',
        message: `检测到数据文件变化 ，正在刷新数据...`,
        type: 'success',
        duration: 10000, // 设置为 0 使其不自动关闭
        position: 'bottom-right', // 显示在右下角
      });
      // 调用防抖处理的 getData 函数来刷新数据
      debouncedGetData();
    });
     console.log('[App.vue] 文件变化监听器已设置。'); // 确认监听器设置成功
  } else {
      console.warn('[App.vue] onDataDirectoryChanged API 不可用，无法设置文件变化监听器。');
      // 可以选择性地提示用户
      // ElMessage.warning('无法自动刷新数据，文件监控监听器设置失败。');
  }
});

// 组件卸载前移除监听器 (可选，但推荐)
onUnmounted(() => {
  if (window.electronAPI && typeof window.electronAPI.onDataDirectoryChanged === 'function') {
    // Electron 的 ipcRenderer.on 返回的是 ipcRenderer 自身，
    // 通常移除监听器需要使用 removeListener 或 removeAllListeners。
    // 但 contextBridge 暴露的 API 不直接返回 ipcRenderer，
    // 简单的处理方式是假设 preload.js 内部处理了移除，
    // 或者在 preload.js 中暴露一个移除监听器的方法。
    // 这里暂时不显式移除，依赖 Electron 的垃圾回收机制。
    // 如果需要严格移除，需要修改 preload.js 暴露 removeListener 功能。
    console.log('[App.vue] 组件卸载，理论上应移除文件变化监听器。');
  }
});

</script>

<template>
  <el-config-provider :locale="zhCn"> <!-- 使用 ElConfigProvider 包裹并传入中文语言包 -->
    <div class="report-viewer">
      <el-row :gutter="20" class="controls">
        <el-col :span="6">
        <el-date-picker
          v-model="selectedDate"
          type="date"
          placeholder="选择日期"
          format="YYYY-MM-DD"
          value-format="YYYY-MM-DD"
          :clearable="false"
          style="width: 100%;"
        />
      </el-col>
      <el-col :span="6">
        <el-radio-group v-model="selectedShift">
          <el-radio value="day">白班</el-radio>
          <el-radio value="night">夜班</el-radio>
        </el-radio-group>
      </el-col>
      <el-col :span="12" style="text-align: right;">
        <el-button @click="showSimpleMode" :disabled="selectedRows.length === 0">简易模式</el-button>
        <el-button type="success" @click="exportToExcel" :disabled="selectedRows.length === 0">导出选中项</el-button>
        <el-tooltip
          content="加载昨日7点至今晨7点数据，并过滤样品名含'总'或'z'的记录"
          placement="top"
        >
          <el-button type="warning" @click="loadYesterdayCompleteData" :loading="loading">加载昨日完整数据</el-button>
        </el-tooltip>
      </el-col>
    </el-row>

    <!-- 数据目录设置区域 -->
    <el-row :gutter="20" class="controls" style="margin-top: 10px;">
        <el-col :span="18">
            <el-input v-model="dataPathInput" placeholder="数据目录路径" readonly>
                <template #prepend>数据目录:</template>
            </el-input>
        </el-col>
        <el-col :span="6" style="text-align: right;">
            <el-button @click="openDirectory">浏览</el-button>
            <el-button type="primary" @click="saveDataPath">保存路径</el-button>
        </el-col>
    </el-row>

    <!-- 当前视图提示 -->
    <el-alert
      v-if="currentViewTitle"
      type="info"
      :closable="false"
      show-icon
      style="margin-top: 10px;"
     >
       <span>{{ currentViewTitle }}</span>
       <el-button type="primary" link @click="cancelYesterdayView" size="small" style="margin-left: 10px;">返回标准视图</el-button>
     </el-alert>

    <!-- 文件监控状态提示 -->
     <el-alert
       v-if="monitoringStatusText"
       :title="monitoringStatusText"
       type="success"
       :closable="false"
       show-icon
       style="margin-top: 10px;"
     />

    <el-table
      :data="tableData"
      v-loading="loading"
      border
      stripe
      style="width: 100%; margin-top: 10px;"
      @selection-change="handleSelectionChange"
      height="calc(100vh - 180px)"
      size="small"
      class="compact-table"
    >
      <el-table-column type="selection" width="40" />
      <el-table-column prop="date" label="日期" sortable width="90" />
      <el-table-column prop="time" label="时间" sortable width="80" />
      <el-table-column prop="sampleName" label="样品" width="70" />

      <el-table-column
        v-for="index in 20"
        :key="`test-${index}`"
        :label="`${index}`"
        width="36"
        align="center"
        class-name="test-col"
      >
        <template #default="scope">
          <span>{{ scope.row.testResults && scope.row.testResults[index - 1] ? scope.row.testResults[index - 1].gram : '' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="maxHardness" label="最大" width="60" />
      <el-table-column prop="averageHardness" label="平均" width="60" />
      <el-table-column prop="minHardness" label="最小" width="60" />
    </el-table>

    <el-dialog
      v-model="dialogVisible"
      title="简易模式预览"
      width="60%"
    >
      <div v-if="groupedSimpleModeData.length > 0" style="max-height: 70vh; overflow-y: auto;">
        <el-row :gutter="10" v-for="(row, rowIndex) in groupedSimpleModeData" :key="`sm-row-${rowIndex}`" style="margin-bottom: 10px;">
          <el-col :span="6" v-for="(item, colIndex) in row" :key="`sm-item-${rowIndex}-${colIndex}`">
            <div class="simple-mode-item">
              <h3>{{ item.line }}线</h3>
              <h4>{{ item.date }} {{ item.time }}</h4>

              <div class="test-results-grid">
                 <el-row :gutter="1" v-for="(innerRow, innerRowIndex) in item.groupedTestResults" :key="`sm-test-row-${rowIndex}-${colIndex}-${innerRowIndex}`" class="test-result-row">
                    <el-col :span="4" v-for="(innerItem, innerColIndex) in innerRow" :key="`sm-test-item-${rowIndex}-${colIndex}-${innerRowIndex}-${innerColIndex}`" class="test-result-cell">
                      {{ innerItem.gram }}
                    </el-col>

                    <el-col :span="4 * (5 - innerRow.length)" v-if="innerRow.length < 5"></el-col>
                 </el-row>
              </div>

              <el-row :gutter="5" class="hardness-stats">
                <el-col :span="8">最大: {{ item.maxHardness }}</el-col>
                <el-col :span="8">平均: {{ item.averageHardness }}</el-col>
                <el-col :span="8">最小: {{ item.minHardness }}</el-col>
              </el-row>
            </div>
          </el-col>
        </el-row>
      </div>
      <div v-else>
        没有选中任何行或选中行无数据。
      </div>
      <template #footer>
        <span class="dialog-footer">
          <el-button @click="dialogVisible = false">关闭</el-button>
        </span>
      </template>
      </el-dialog>
    </div>
  </el-config-provider>
</template>

<style scoped>
.report-viewer {
  padding: 10px;
  height: 100vh;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}
.controls {
  margin-bottom: 10px;
  flex-shrink: 0; /* 防止控件行被压缩 */
}
.el-table {
  flex-grow: 1; /* 让表格填充剩余空间 */
}
/* 紧凑表格样式 */
:deep(.compact-table) {
  font-size: 12px;
}
:deep(.compact-table .el-table__cell) {
  padding: 2px 0;
}
:deep(.compact-table .cell) {
  padding-left: 2px;
  padding-right: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:deep(.test-col .cell) {
  padding: 0;
}
.dialog-footer {
  text-align: right;
}
.simple-mode-item {
  border: 1px solid #dcdfe6;
  padding: 10px;
  text-align: center;
  height: 100%; /* 使列内元素高度一致 */
  display: flex;
  flex-direction: column;
  justify-content: space-between; /* 分散对齐内容 */
}
.simple-mode-item h3, .simple-mode-item h4 {
  margin: 5px 0;
}
.test-results-grid {
  margin: 10px 0;
  font-size: 12px; /* 减小字体以便容纳 */
}
.test-result-row {
  margin-bottom: 2px; /* 行间距 */
  display: flex; /* 确保列水平排列 */
  justify-content: center; /* 居中测试结果 */
}
.test-result-cell {
  border: 1px solid #eee;
  padding: 2px;
  min-width: 30px; /* 保证最小宽度 */
  text-align: center;
  background-color: #f8f9fa; /* 轻微背景色 */
  overflow: hidden; /* 防止内容溢出 */
  text-overflow: ellipsis; /* 溢出时显示省略号 */
  white-space: nowrap; /* 防止换行 */
}
.hardness-stats {
  margin-top: 10px;
  font-size: 12px;
  color: #606266;
}
</style>
