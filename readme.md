# 课程表 PDF 表格提取器

一个面向 sep 教务系统通过 Microsoft Excel 导出的课程表、教学日历 PDF 的表格提取器。它直接解析 PDF 内部结构，输出单元格的逻辑行列和合并信息，方便后续还原成 HTML 表格或做选课时间冲突检查。

特点：

- 1700行 Python 代码，零第三方依赖，只用 Python 标准库，需要 Python 3.9+
- 输出 `row_start` / `col_start` / `row_span` / `col_span`，可以据此直接还原合并单元格
- 在 12 份课程表 PDF 样本上，完整提取平均约 1.3 秒
- 使用 DeepSeek V4 Pro、DeepSeek V4 Flash0731 和 Codex(CC-Switch) 进行开发

## 背景

之前看到不少用 HTML 做选课时间冲突检查的小工具，但课程表往往直接写死在 HTML 里。然后就想写一个解析的工具。一开始试了试一些开源库、免费的 PDF 转表格方案，结果总有一些文字定位、OCR 之类的识别错误。我不是很满意，想把这些测试文件做到 100% 正确，于是就Vibe-Coding了这个💩💩💩。后来知道 OpenDataLoader 等库也能做到类似效果，所以这个项目在开源生态面前不值一提🤡🤡🤡。

## 制作过程

一开始直接试了 `pdfplumber`、`camelot`、`tabula`。这些库能拿到文本和矩形，但我当时没能从中找到直接还原合并单元格的 `row_span` / `col_span` 的办法。后来试了 `MinerU`，它有一部分依赖 OCR，文字溢出单元格比重较大时容易识别错。

于是就自己解析 PDF。花了一些时间学习内容流指令、对象结构、字体和 CMap 这些内部格式(实则拷打deepseek)，最终写出这坨💩。

## 用法

示例：

```python
from extract import PDFTableExtractor

extractor = PDFTableExtractor("course_schedule.pdf")

all_pages = extractor.extract_table()          # dict[int, list[dict]]，键是页面索引
page_one = extractor.extract_table(1)          # PDF 第 2 页，返回 list[dict]
first_three = extractor.extract_table(0, 3)    # PDF 第 1~3 页
selected = extractor.extract_table([0, 2])     # PDF 第 1、3 页
```

代码里使用的是 0 起始的页面索引，PDF 页码数字等于页面索引加 1。`extract_table(start, end)` 的区间是左闭右开。

### 输出结构

`extract_table()` 返回的是“页面索引到该页表格列表”的字典：

```python
{
    0: [table, ...],  # 页面索引 0，即 PDF 第 1 页
    1: [table, ...],
}
```

如果只传入一个页面索引，例如 `extract_table(0)`，返回值会少掉外层字典，直接是这一页的 `[table, ...]`。

每个 `table` 的结构：

```python
{
    "total_rows": int,
    "total_cols": int,
    "cells": [
        {
            "row_start": int,
            "col_start": int,
            "row_span": int,
            "col_span": int,
            "bbox": [x1, y1, x2, y2],
            "text": str,
        },
        ...
    ],
}
```

`row_start` / `col_start` 以表格左上角为原点，`bbox` 是 PDF 用户空间坐标。

## 效果与测试数据

测试样本来自选课系统自 2019-2020 春季学期以来的课程开设表 PDF。其中 2019-2020 春没有纳入：它的生成方式推测为 Foxit，而之后导出的文件都由 Microsoft Excel 生成，且其指令格式和特征和之后有较大差异，因此不考虑对其进行支持。2023-2024 春也没有纳入：sep 教务系统上的下载链接异常，因此没有拿到这份文件。

测试样本共 12 份课程表 PDF，每份完整提取 3 次取平均，全部样本平均约 1.3 秒，单份平均耗时约 0.7 到 1.9 秒。当前样本上可以输出包含 `row_span` / `col_span` 的表格结构。

## 实现思路

底层解析由几个类负责：

- `BaseParser` 处理数字、名称、字符串、十六进制字符串等基础 token。
- `DictParser` 解析 PDF 字典和数组，支持嵌套结构与对象引用。
- `ObjStmParser` 解析对象流。
- `CMapParser` 解析 `ToUnicode` CMap，支持 `bfchar` 和 `bfrange`（包括数组形式）。
- `ContentParser` 解析页面内容流，提取矩形、水平/垂直线段、矩形裁剪区域和 `Tj` / `TJ` 文本。

表格结构重建在 `ContentObj.get_cells` 里：

1. 收集纯黑色矩形和线段，把它们覆盖的网格单元标记成黑色。
2. 用并查集把四连通的黑色网格单元合并成连通分量，每个分量当作一张表的边框。
3. 在单个分量内部，再用并查集找被黑色边框包围的白色连通区域，每个白色区域对应一个单元格。
4. 从黑色网格中识别横竖表格线中心，把单元格映射到逻辑行列，得到 `row_span` / `col_span`。

文本定位和解码：

- `TextItem` 记录基线坐标、字体、原始文本，以及生成文本时生效的裁剪区域。
- `ContentObj.get_tables` 负责把标记内容块放到单元格里。优先看某个 `TextItem` 的裁剪区域是否与单元格矩形完全一致；不行就按“基线在单元格内，并且单元格在裁剪区域内”筛选；筛不到就忽略。
- 一开始也想过拿“同一块内的所有文本基线必属于同一个单元格”当规则，后来发现这个前提不一定成立，所以定位时不以基线天然同格为前提，而是把裁剪区域当作更强的信号。
- `ContentParser` 分别维护图形状态栈和标记内容栈，能处理 `q/Q` 与 `BDC/EMC` 交错、嵌套的情况。
- 还有一些琐碎的工作就是通过 CMap 解码：`WinAnsiEncoding` 直接转字符串，`Identity-H` 每 4 个十六进制字符查一次 `ToUnicode` 映射。

`ContentObj.get_cells` 和 `ContentObj.get_tables` 是懒加载，第一次调用时才计算并缓存结果，所以只提取部分页面时，不会把全部页面的表格结构提前重建完。

## 设计假设与局限

这份实现只面向教务系统通过 Microsoft Excel 导出的课程表、教学日历 PDF。为了控制解析范围，我做了这些假设：

- 表格边框由 `re` 绘制的矩形和水平/垂直线段组成，不处理任意多边形路径。
- 表格边框是纯黑色，PDF 未显式设置颜色时也按黑色处理。
- 线条使用非圆头 cap，不支持圆头。
- 文本矩阵只做平移，不处理旋转或倾斜。
- 字体 `Encoding` 只支持 `WinAnsiEncoding` 和 `Identity-H`，不处理 `Differences`；`Identity-H` 必须有 `ToUnicode` CMap。
- 裁剪区域是矩形，不支持复杂裁剪路径。
- 没有处理跨页表格合并等复杂情况。

如果文档不符合这些假设，解析器可能失败或输出不完整。它不是一个通用 PDF 表格解析器，只针对格式规整的课程表、教学日历这类文档。
