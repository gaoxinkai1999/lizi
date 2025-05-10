import fs from 'fs/promises';
import path from 'path';
import iconv from 'iconv-lite';

/**
 * 读取指定目录下所有文件的内容（假定为 GBK 编码）
 * @param {string} directoryPath 目录路径
 * @returns {Promise<Array<{name: string, content: string}>>} 包含文件名和解码后内容的数组
 */
async function readDirectoryFiles(directoryPath) {
  // console.log(`尝试从以下路径读取文件: ${directoryPath}`); // 移除调试日志
  let filesData = [];
  try {
    const fileNames = await fs.readdir(directoryPath);
    // console.log(`找到文件: ${fileNames.join(', ')}`); // 移除调试日志

    for (const fileName of fileNames) {
      const filePath = path.join(directoryPath, fileName);
      try {
        // 检查是否为文件，而不是目录
        const stats = await fs.stat(filePath);
        if (stats.isFile()) {
          const buffer = await fs.readFile(filePath);
          const content = iconv.decode(buffer, 'gbk'); // 使用 GBK 解码
          filesData.push({ name: fileName, content: content });
          // console.log(`成功读取并解码: ${fileName}`); // 移除调试日志
        } else {
          // console.log(`跳过目录: ${fileName}`); // 移除调试日志
        }
      } catch (fileReadError) {
        console.error(`读取或解码文件 ${fileName} 时出错:`, fileReadError); // 保留错误日志
        // 记录错误并继续处理其他文件
      }
    }
  } catch (dirReadError) {
    console.error(`读取目录 ${directoryPath} 时出错:`, dirReadError); // 保留错误日志
    // 如果目录读取失败，向上抛出错误
    throw dirReadError; // 或者返回空数组 return [];
  }
  return filesData;
}

/**
 * 解析单个报告文件的文本内容
 * @param {string} content 文件内容
 * @returns {object | null} 解析后的报告对象，如果解析失败则返回 null
 */
function parseReportContent(content) {
  // console.log('尝试解析报告内容...'); // 移除调试日志
  try {
    const report = {};

    // 辅助函数：使用正则表达式提取单个值
    const extractSingle = (text, regex) => {
      const pattern = new RegExp(regex);
      const match = pattern.exec(text);
      // 如果找到匹配项，则返回第一个捕获组（去除首尾空格），否则返回 null
      return match ? match[1]?.trim() : null;
    };

    // 提取基本信息
    report.operator = extractSingle(content, "Operator\\s+(\\w+)"); // 操作员

    // 解析日期和时间
    const dateTimeStr = extractSingle(content, "Date\\s+([\\d\\-_]+)"); // 提取日期时间字符串
    if (dateTimeStr) {
      const parts = dateTimeStr.split("_");
      if (parts.length === 2) {
        let datePart = parts[0];
        let timePart = parts[1];
        // 如果需要，填充时间 (HH-mm-ss)
        if (timePart.length < 8) {
           // 根据 HH-mm-ss 格式检查是否需要填充前导零
           const timeComponents = timePart.split('-');
           if (timeComponents.length === 3 && timeComponents[0].length === 1) { // 例如 9-30-15
               timePart = `0${timePart}`; // 填充为 09-30-15
           } else if (timeComponents.length !== 3) {
               console.warn(`[警告] 意外的时间格式，跳过填充: ${timePart}`); // 保留警告日志
           }
        }
        // 解析前对日期和时间格式进行基本验证
        if (/^\d{4}-\d{2}-\d{2}$/.test(datePart) && /^\d{2}-\d{2}-\d{2}$/.test(timePart)) {
            report.date = datePart; // 保留为字符串 YYYY-MM-DD
            report.time = timePart.replace(/-/g, ':'); // 替换分隔符，保留为字符串 HH:MM:SS
        } else {
            console.warn(`[警告] 发现无效的日期/时间格式: Date='${datePart}', Time='${timePart}'`); // 保留警告日志
            report.date = null;
            report.time = null;
        }
      } else {
        console.warn(`[警告] 意外的日期/时间字符串格式: ${dateTimeStr}`); // 保留警告日志
        report.date = null;
        report.time = null;
      }
    } else {
        report.date = null;
        report.time = null;
    }


    report.cup = parseInt(extractSingle(content, "CUP\\s+(\\d+)"), 10) || null; // 杯号
    report.sampleName = extractSingle(content, "Sample Name\\s+(.+)"); // 样品名称
    // 如果可能，从样品名称中提取产线号 (1-10)
    const lineMatch = /Sample Name\s+(10|[1-9])(?:\s+.*)?/.exec(content);
    report.line = lineMatch ? parseInt(lineMatch[1], 10) : null; // 产线号

    report.effectiveTests = parseInt(extractSingle(content, "Effective Tests\\s+(\\d+)"), 10) || null; // 有效测试数
    report.testStandard = extractSingle(content, "Test Standard\\s+([\\w\\/\\s]+)"); // 测试标准

    // 硬度值 (四舍五入到整数)
    report.maxHardness = Math.round(parseFloat(extractSingle(content, "MAX HARDNESS\\s+(\\d+\\.\\d+)"))) || null; // 最大硬度
    report.minHardness = Math.round(parseFloat(extractSingle(content, "MIN HARDNESS\\s+(\\d+\\.\\d+)"))) || null; // 最小硬度
    report.averageHardness = Math.round(parseFloat(extractSingle(content, "AVERAGE HARDNESS\\s+(\\d+\\.\\d+)"))) || null; // 平均硬度
    report.hardnessDeviation = parseFloat(extractSingle(content, "HARDNESS DEVIATION\\s+(\\d+\\.\\d+)")) || null; // 硬度偏差

    // 直径值
    report.maxDiameter = parseFloat(extractSingle(content, "MAX DIAMETER\\s+(\\d+\\.\\d+)")) || null; // 最大直径
    report.minDiameter = parseFloat(extractSingle(content, "MIN DIAMETER\\s+(\\d+\\.\\d+)")) || null; // 最小直径
    report.averageDiameter = parseFloat(extractSingle(content, "AVERAGE DIAMETER\\s+(\\d+\\.\\d+)")) || null; // 平均直径
    report.diameterDeviation = parseFloat(extractSingle(content, "DIAMETER DEVIATION\\s+(\\d+\\.\\d+)")) || null; // 直径偏差

    // 前 25% 的值
    report.averageOfTop25 = parseFloat(extractSingle(content, "AVERAGE OF TOP 25%\\s+(\\d+\\.\\d+)")) || null; // 前25%平均值
    report.deviationOfTop25 = parseFloat(extractSingle(content, "DEVIATION OF TOP 25%\\s+(\\d+\\.\\d+)")) || null; // 前25%偏差

    // 测试计数
    report.totalTests = parseInt(extractSingle(content, "TOTAL TESTS\\s+(\\d+)"), 10) || null; // 总测试数
    report.invalidTests = parseInt(extractSingle(content, "INVALID TESTS\\s+(\\d+)"), 10) || null; // 无效测试数

    // 其他参数
    report.crushDiameter = extractSingle(content, "CRUSH DIAMETER\\s+(\\d+%)"); // 压碎直径百分比
    report.breakAt = extractSingle(content, "BREAK AT\\s+(\\d+\\s*g)"); // 破碎点 (允许 g 前面有可选空格)
    report.step = parseFloat(extractSingle(content, "STEP\\s+(\\d+\\.\\d+)")) || null; // 步长

    // 解析单个测试结果
    report.testResults = [];
    const testPattern = /(\d+)\s+(\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)/g; // 使用全局标志匹配测试结果行
    let testMatch;
    while ((testMatch = testPattern.exec(content)) !== null) {
      // 检查匹配项是否在预期部分内 (启发式：在 "DIAMETER DEVIATION" 之后，"Segment Analysis" 之前)
      const deviationIndex = content.indexOf("DIAMETER DEVIATION");
      const segmentIndex = content.indexOf("Segment Analysis"); // 或下一个部分的标记
      if (deviationIndex !== -1 && testMatch.index > deviationIndex && (segmentIndex === -1 || testMatch.index < segmentIndex)) {
          const testResult = {
            number: parseInt(testMatch[1], 10), // 编号
            test: parseInt(testMatch[2], 10), // 测试号
            gram: Math.round(parseFloat(testMatch[3])), // 克数 (四舍五入)
            mm: parseFloat(testMatch[4]) // 毫米数
          };
          report.testResults.push(testResult);
      }
    }
    // 按编号对测试结果进行排序
    report.testResults.sort((a, b) => a.number - b.number);


    // 解析段信息 (Segment Analysis)
    report.segmentInfoList = [];
    const segmentPattern = /(\d+-\d+)\s+([\*]+)/g; // 使用全局标志匹配段信息行
    let segmentMatch;
    // 如果存在 "Segment Analysis" 部分，则专门在该部分内查找段信息
    const segmentAnalysisSection = content.match(/Segment Analysis[\s\S]*/);
    const textToSearchSegments = segmentAnalysisSection ? segmentAnalysisSection[0] : content; // 在该部分或整个内容中搜索

    while ((segmentMatch = segmentPattern.exec(textToSearchSegments)) !== null) {
      const segmentInfo = {
        range: segmentMatch[1], // 范围，例如 "0-100"
        stars: segmentMatch[2] // 星号字符串
      };
      report.segmentInfoList.push(segmentInfo);
    }

    // console.log(`成功解析报告，操作员: ${report.operator}, 日期: ${report.date}`); // 移除调试日志
    return report;

  } catch (error) {
    console.error("解析报告内容时出错:", error); // 保留错误日志
    // 可选地包含部分内容用于调试，注意大小/敏感性
    // console.error("内容片段:", content.substring(0, 200));
    return null; // 解析失败时返回 null
  }
}

/**
 * 读取并解析指定基础路径和日期下的所有报告文件
 * @param {string} basePath 报告文件的基础路径
 * @param {string} date 日期字符串 (格式：'YYYY-MM-DD')
 * @returns {Promise<Array<object>>} 解析后的报告对象数组
 */
export async function readAndParseReports(basePath, date) {
  // console.log(`读取并解析日期为 ${date} 的报告，路径: ${basePath}`); // 移除调试日志
  const targetDatePath = path.join(basePath, date); // 构建目标日期目录路径
  let allParsedReports = []; // 存储所有解析成功的报告

  try {
    // 读取目标日期目录下的所有子目录
    const subdirectories = (await fs.readdir(targetDatePath, { withFileTypes: true }))
      .filter(dirent => dirent.isDirectory()) // 只保留目录
      .map(dirent => dirent.name); // 获取目录名

    if (subdirectories.length === 0) {
      console.warn(`[警告] 在 ${targetDatePath} 中未找到子目录`); // 保留警告日志
      return []; // 没有子目录则返回空数组
    }

    // 遍历每个子目录
    for (const subDir of subdirectories) {
      const subDirPath = path.join(targetDatePath, subDir); // 构建子目录路径
      try {
        // 读取子目录下的所有文件内容
        const files = await readDirectoryFiles(subDirPath);
        // 解析每个文件的内容
        for (const file of files) {
          const parsedReport = parseReportContent(file.content);
          if (parsedReport) {
            // 可以选择性地添加来源信息到报告对象中
            // parsedReport.sourceFile = file.name; // 来源文件名
            // parsedReport.sourceDirectory = subDir; // 来源子目录
            allParsedReports.push(parsedReport); // 添加到结果数组
          }
        }
      } catch (readError) {
        console.error(`读取子目录 ${subDir} 中的文件时出错:`, readError); // 保留错误日志
        // 可以选择继续处理其他子目录
      }
    }

  } catch (error) {
    if (error.code === 'ENOENT') {
      // 目标日期目录不存在是正常情况（例如当天还没有数据）
      console.log(`[信息] 目录未找到 (可能尚无数据): ${targetDatePath}`); // 修改为信息日志
    } else {
      // 其他访问错误需要记录
      console.error(`访问目录 ${targetDatePath} 时出错:`, error); // 保留错误日志
    }
    // 发生错误时返回空数组
    return [];
  }

  return allParsedReports; // 返回所有解析成功的报告
}

// 如果需要单独测试或使用，也可以导出其他辅助函数
// export { readDirectoryFiles, parseReportContent };
