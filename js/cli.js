#!/usr/bin/env node
/* =============================================================================
 * SEP 课程表 PDF 表格提取器 —— Node.js 命令行入口
 *
 * 用法：
 *   node cli.js <pdf文件>              提取全部页面 -> 页面索引到表格列表的 JSON
 *   node cli.js <pdf文件> <页面索引>    提取单页（0 起始）-> 该页表格列表 JSON
 *   node cli.js <pdf文件> <起始> <结束> 提取 [起始, 结束) 区间页面 -> JSON
 * ============================================================================= */
'use strict';

const { PDFTableExtractor } = require('./extract.js');

async function main(argv) {
  const file = argv[0];
  if (!file) {
    console.error('用法: node cli.js <pdf文件> [页面索引] [结束索引]');
    process.exit(1);
  }

  const extractor = await PDFTableExtractor.create(file);

  let result;
  if (argv.length === 1) {
    result = extractor.extract_table();
  } else if (argv.length === 2) {
    result = extractor.extract_table(parseInt(argv[1], 10));
  } else {
    result = extractor.extract_table(parseInt(argv[1], 10), parseInt(argv[2], 10));
  }

  process.stdout.write(JSON.stringify(result, null, 1) + '\n');
}

main(process.argv.slice(2)).catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
