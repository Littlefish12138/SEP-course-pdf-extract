/* =============================================================================
 * SEP 教务系统课程表 PDF 表格提取器 —— JavaScript 迁移版
 *
 * 由 python/extract.py 迁移而来。迁移原则：
 *  - 不是逐行翻译：以 JavaScript 原生方式表达同样的解析逻辑
 *  - 底层解析器用"一个数据流 + 一个游标"的方式，对二进制内容流只扫描一遍
 *  - 指令处理逻辑与 Python 版一一对应，不多也不少
 *  - 关键工程细节（边框连通域 -> 区分表格 -> 白色单元格 -> 识别表格线 ->
 *    逻辑行列；MarkedContentBlock 定位到单元格）完整还原
 *
 * 本文件不依赖任何 Node.js 专有语法，可在浏览器与 Node.js 中运行：
 *  - Node.js 下自动使用内置 zlib 解压
 *  - 浏览器下自动使用全局 pako.inflate（见 html/index.html 中的内联版本）
 *
 * 对外暴露 PDFTableExtractor 等类，接口与 Python 版一致：
 *   const ex = new PDFTableExtractor(path_or_bytes);
 *   ex.extract_table()            // 全部页面 -> {pageIndex: [table, ...]}
 *   ex.extract_table(1)           // 单页 -> [table, ...]
 *   ex.extract_table(0, 3)        // 左闭右开区间 -> {0: ..., 1: ..., 2: ...}
 *   ex.extract_table([0, 2])      // 指定页面列表
 * ============================================================================= */

"use strict";

// ---------------- 全局常量 ----------------
var TOLERANCE = 0.7; // 识别 q/Q 的裁剪区域与单元格是否一致时的容许误差
var MERGE_GAP = 0.05; // 清洗表格边框之间的细小间隙
var LINE_MIN_SPAN = 5.0; // 黑色网格中识别表格线所需的最小长边
var LINE_EDGE_TOLERANCE = 2.0; // 单元格边与逻辑表格线中心的最大对齐误差

// ---------------- 基础工具 ----------------

/** 断言：条件不成立时抛出 Error（对应 Python 的 assert） */
function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg !== undefined ? msg : "AssertionError");
  }
}

// 数字字节集合（对应 Python 的 b'+-.0123456789'）
var NUM_CODES = new Set([
  0x2b, 0x2d, 0x2e, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
]);
// 纯数字字节集合（0-9，对应 Python 的 b'0123456789'）
var DIGIT_CODES = new Set([
  0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
]);
// 空白字节集合（对应 Python 的 b' \t\n\r\f'）
var WS_CODES = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0c]);
// 名称结束符集合（对应 Python 的 b' \t\n\r\f()<>[]{}/%'）
var NAME_END_CODES = new Set([
  0x20, 0x09, 0x0a, 0x0d, 0x0c, 0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d,
  0x2f, 0x25,
]);
// read_string 中允许的转义字符（对应 Python 的 b'\\()'）
var ESC_CODES = new Set([0x5c, 0x28, 0x29]);

/** 二进制字节 -> latin1 字符串（逐字节映射，保证字节语义与 Python bytes 一致） */
function bytesToLatin1(bytes) {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(bytes)) {
    return bytes.toString("latin1");
  }
  if (bytes instanceof Uint8Array) {
    var s = "";
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(
        null,
        bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
      );
    }
    return s;
  }
  if (bytes instanceof ArrayBuffer) {
    return bytesToLatin1(new Uint8Array(bytes));
  }
  throw new Error("bytesToLatin1: unsupported input");
}

/** latin1 字符串 -> 二进制字节 */
function latin1ToBytes(s) {
  var out = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i) & 0xff;
  }
  return out;
}

/** utf-8 解码（对应 Python bytes.decode() 的默认编码） */
function utf8Decode(s) {
  return new TextDecoder("utf-8").decode(latin1ToBytes(s));
}

/** utf-16(BE, 带 BOM) 解码：输入为以 \uFEFF 开头的 latin1 字符串 */
function utf16beDecode(s) {
  var out = "";
  for (var i = 2; i + 1 < s.length; i += 2) {
    out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
  }
  return out;
}

/** 大端读取 Uint8Array 中的 n 字节整数（对应 Python int.from_bytes） */
function readBigEndian(bytes, offset, n) {
  var v = 0;
  for (var i = 0; i < n; i++) {
    v = v * 256 + bytes[offset + i];
  }
  return v;
}

/** 四舍五入到 6 位小数（对应 Python round(v, 6)） */
function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

/** 模拟 Python range(len)[start:end] 的切片语义 */
function sliceRange(len, start, end) {
  var s = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
  var e = end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
  var out = [];
  for (var i = s; i < e; i++) {
    out.push(i);
  }
  return out;
}

// ---------------- zlib inflate 钩子 ----------------
// 对应 Python 的 zlib.decompress：
// - Node.js 用内置 zlib
// - 浏览器可用全局 pako（旧方案），或先通过 PDFTableExtractor.prepareStreams()
//   用原生 DecompressionStream 预解压全部流并填充 inflateCache（新方案）
var inflateImpl = null;
var inflateCache = null; // Map: 原始流 latin1 字符串 -> 已解压 Uint8Array（预解压缓存）

function inflate(latin1Str) {
  if (inflateCache !== null && inflateCache.has(latin1Str)) {
    return inflateCache.get(latin1Str);
  }
  if (!inflateImpl) {
    throw new Error(
      "zlib inflate implementation not available (need Node.js zlib or global pako)",
    );
  }
  return inflateImpl(latin1Str);
}

/** 设置/清空预解压缓存（配合 PDFTableExtractor.prepareStreams 使用） */
function setInflateCache(cache) {
  inflateCache = cache;
}

(function installInflate() {
  if (
    typeof process !== "undefined" &&
    process.versions &&
    process.versions.node
  ) {
    // Node.js 环境
    var zlib = require("zlib");
    inflateImpl = function (s) {
      return zlib.inflateSync(latin1ToBytes(s));
    };
  } else if (
    typeof globalThis !== "undefined" &&
    globalThis.pako &&
    typeof globalThis.pako.inflate === "function"
  ) {
    // 浏览器环境：全局 pako（未内联 pako 时此分支不生效）。
    // pako 不忽略 deflate 流之后的尾随数据（Python/Node 的 zlib 会忽略），
    // 因此失败时从尾部逐字节截断重试，找到真正的流结束位置。
    inflateImpl = function (s) {
      var bytes = latin1ToBytes(s);
      var pako = globalThis.pako;
      var out = null;
      try {
        out = pako.inflate(bytes);
      } catch (e) {
        out = null;
      }
      if (out) {
        return out;
      }
      for (var n = bytes.length - 1; n >= Math.max(0, bytes.length - 64); n--) {
        try {
          out = pako.inflate(bytes.subarray(0, n));
        } catch (e2) {
          out = null;
        }
        if (out) {
          return out;
        }
      }
      throw new Error("zlib inflate failed: " + bytes.length + " bytes");
    };
  }
})();

/**
 * 用浏览器原生 DecompressionStream('deflate') 解压（异步）。
 * 与 pako 相同，DecompressionStream 不忽略 deflate 流之后的尾随数据
 * （Python/Node 的 zlib 会忽略，此处报 "Junk found after end of compressed data."），
 * 因此失败时从尾部逐字节截断重试，找到真正的流结束位置。
 */
async function inflateWithDecompressionStream(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream is not supported in this browser");
  }
  async function inflateOnce(data) {
    var ds = new DecompressionStream("deflate");
    var stream = new Blob([data]).stream().pipeThrough(ds);
    var buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  try {
    return await inflateOnce(bytes);
  } catch (e) {
    for (var n = bytes.length - 1; n >= Math.max(0, bytes.length - 64); n--) {
      try {
        return await inflateOnce(bytes.subarray(0, n));
      } catch (e2) {
        /* 继续截断 */
      }
    }
    throw e;
  }
}

// =======================  解析器类  =======================

/**
 * 基础解析器：持有整个数据流（latin1 字符串）与游标 pos，
 * 负责数字、名称、字符串、十六进制字符串等基础 token 的读取。
 * 所有方法只向前移动游标，对数据流只扫描一遍。
 */
function BaseParser(data) {
  this.data = data;
  this.pos = 0;
}

BaseParser.prototype.skipWhitespace = function () {
  while (
    this.pos < this.data.length &&
    WS_CODES.has(this.data.charCodeAt(this.pos))
  ) {
    this.pos += 1;
  }
};

/**
 * 扫描一个数字字节串（可能包含符号和小数点），返回 number。
 * 对应 Python read_number / _to_number（int 与 float 在 JS 中统一为 number）。
 */
BaseParser.prototype.readNumber = function () {
  var start = this.pos;
  if (this.pos < this.data.length) {
    var c = this.data.charCodeAt(this.pos);
    if (c === 0x2b || c === 0x2d) {
      this.pos += 1;
    }
  }
  while (
    this.pos < this.data.length &&
    NUM_CODES.has(this.data.charCodeAt(this.pos))
  ) {
    this.pos += 1;
  }
  var s = this.data.substring(start, this.pos);
  var v = s.indexOf(".") !== -1 ? parseFloat(s) : parseInt(s, 10);
  if (Number.isNaN(v)) {
    throw new Error("invalid number " + JSON.stringify(s) + " at pos " + start);
  }
  return v;
};

/**
 * 读取 <hex> 十六进制字符串（如 /ID[<......>]、TJ 指令中的 <...>）。
 * 返回内部的十六进制字符（不包含 <>）。
 */
BaseParser.prototype.readHexStr = function () {
  assert(this.data.charCodeAt(this.pos) === 0x3c, "expected '<'");
  this.pos += 1;
  var start = this.pos;
  while (
    this.pos < this.data.length &&
    this.data.charCodeAt(this.pos) !== 0x3e
  ) {
    this.pos += 1;
  }
  var inner = this.data.substring(start, this.pos);
  if (this.pos < this.data.length) {
    this.pos += 1; // 跳过 '>'
  }
  return inner;
};

/**
 * 读出括号内的内容，带转义字符处理。应用场景：
 * 1. 指令 /Lang, /Author, /CreationDate 等等的值
 * 2. 内容流中 TJ 指令的文本内容，例如 [(\\(5)] 中提取出 b'(5'
 * 返回 latin1 字符串（保持字节原样）。
 */
BaseParser.prototype.readString = function () {
  assert(this.data.charCodeAt(this.pos) === 0x28, "expected '('");
  this.pos += 1;

  var result = "";
  while (this.pos < this.data.length) {
    var ch = this.data.charCodeAt(this.pos);
    if (ch === 0x5c) {
      // 转义字符情形，读取下一个被转义的内容
      this.pos += 1;
      assert(
        this.pos < this.data.length &&
          ESC_CODES.has(this.data.charCodeAt(this.pos)),
        "unexpected escape character in string",
      );
      result += this.data.charAt(this.pos);
    } else if (ch === 0x28) {
      throw new Error(
        "Unexpected '(', it was supported to be '\\\\(', at pos=" + this.pos,
      );
    } else if (ch === 0x29) {
      break;
    } else {
      result += this.data.charAt(this.pos);
    }
    this.pos += 1;
  }

  assert(this.data.charCodeAt(this.pos) === 0x29, "expected ')'");
  this.pos += 1;
  return result;
};

/**
 * 读取名称（指令或操作符），返回 latin1 字符串。应用场景：
 * 1. 读取 /Name，兼具读取 /Name/Value 中 Value 的功能
 * 2. 读取内容流中的单个指令，如 re, begincmap
 */
BaseParser.prototype.readName = function () {
  if (this.data.charCodeAt(this.pos) === 0x2f) {
    // /Name 的情形
    this.pos += 1;
  }
  var start = this.pos;

  // 名称结束符：空白、分隔符
  this.pos += 1;
  while (
    this.pos < this.data.length &&
    !NAME_END_CODES.has(this.data.charCodeAt(this.pos))
  ) {
    this.pos += 1;
  }
  return this.data.substring(start, this.pos);
};

/**
 * 字典解析器：解析 <<...>>，用于
 * 1. pdf 的 Obj 的头部中的 <<...>>
 * 2. 结构树节点，其本身就是一个 <<...>>
 * 3. 内容流的 /P <<...>> BDC...EMC 中的 <<...>>
 */
function DictParser(data) {
  BaseParser.call(this, data);
}

DictParser.prototype = Object.create(BaseParser.prototype);
DictParser.prototype.constructor = DictParser;

/**
 * 根据周边位置判断解析策略，解析出数字或引用 (a b R)。
 * 单个数字 -> number；1 0 R 模式 -> [a, b, 'R']（对应 Python 元组 (a, b, 'R')）。
 * 解析完成后自动移动游标。
 */
DictParser.prototype.parseNumberOrRef = function () {
  assert(DIGIT_CODES.has(this.data.charCodeAt(this.pos)), "expected a digit");
  var a = this.readNumber();
  var savedPos = this.pos;
  this.skipWhitespace();
  // 尝试匹配引用：第二个数字 + R
  if (
    this.pos < this.data.length &&
    NUM_CODES.has(this.data.charCodeAt(this.pos))
  ) {
    var b = this.readNumber();
    this.skipWhitespace();
    if (
      this.pos < this.data.length &&
      this.data.charCodeAt(this.pos) === 0x52
    ) {
      // 'R'
      // R 后面应当是空白或换行符或者列表结束
      assert(
        this.pos + 1 >= this.data.length ||
          " \t\n\r\f/>]".indexOf(this.data.charAt(this.pos + 1)) !== -1,
        "unexpected byte after 'R'",
      );
      this.pos += 1; // 跳过 R
      return [a, b, "R"];
    }
  }
  // 不是引用，退回
  this.pos = savedPos;
  return a;
};

/**
 * 解析数组 [......]，根据内容返回数字、引用列表、数组或原始字节串。
 */
DictParser.prototype.parseArray = function () {
  assert(this.data.charCodeAt(this.pos) === 0x5b, "expected '['");
  this.pos += 1; // 跳过 '['

  // 找到 '[]' 的起点和终点
  var end = this.data.indexOf("]", this.pos);

  // 解析内部元素
  var elements = [];

  while (this.pos < end) {
    this.skipWhitespace();
    if (this.pos >= end) {
      break;
    }
    elements.push(this.parseValue());
  }

  if (this.data.charCodeAt(this.pos) === 0x5d) {
    this.pos += 1;
  }

  // 根据规则判断返回形式
  function isNumber(v) {
    return typeof v === "number";
  }
  function isRef(v) {
    return Array.isArray(v) && v.length === 3 && v[2] === "R";
  }

  if (elements.length === 1 && isNumber(elements[0])) {
    return elements[0];
  }
  if (elements.length === 4 && elements.every(isNumber)) {
    return elements;
  }
  if (elements.length && elements.every(isRef)) {
    return elements;
  }
  // 其他情况：原样返回内部元素
  return elements;
};

/**
 * 读取一个值并移动游标到值结束之后，处理以下情形：
 * 1. '/' 开头的值: /Name /Value 中的 Value
 * 2. 单个数字: 如 /Length 1109 中的 1109
 * 3. 对象引用: 如 /F1 1 0 R
 * 4. bool 值: 见于 /Marked 等指令中
 * 5. (...) 中的内容: 见于 /Author 等指令
 * 6. [...] 中的内容: 见于 /Kids 等指令
 * 7. <...> 中的内容: 如 /ID 指令的 [<...><...>]
 * 8. <<...>> 中的内容（子字典）: 见于 /Resources 等指令
 */
DictParser.prototype.parseValue = function () {
  this.skipWhitespace();
  if (this.pos >= this.data.length) {
    return null;
  }

  var ch = this.data.charCodeAt(this.pos);
  if (ch === 0x2f) {
    return this.readName();
  } else if (ch === 0x28) {
    return this.readString();
  } else if (ch === 0x5b) {
    return this.parseArray();
  } else if (ch === 0x3c) {
    if (
      this.pos + 1 < this.data.length &&
      this.data.charCodeAt(this.pos + 1) === 0x3c
    ) {
      // 嵌套字典 <<...>>
      return this.parseDict();
    } else {
      // 十六进制字符串
      return this.readHexStr();
    }
  } else if (ch === 0x74) {
    // 't'
    if (this.data.substr(this.pos, 4) === "true") {
      this.pos += 4;
      return true;
    }
    throw new Error("Expected 'true'");
  } else if (ch === 0x66) {
    // 'f'
    if (this.data.substr(this.pos, 5) === "false") {
      this.pos += 5;
      return false;
    }
    throw new Error("Expected 'false'");
  } else if (NUM_CODES.has(ch)) {
    return this.parseNumberOrRef();
  } else {
    throw new Error(
      "Unexpected byte " +
        JSON.stringify(String.fromCharCode(ch)) +
        " at position " +
        this.pos,
    );
  }
};

/** 解析 <<...>> 字典，返回对象，pos 应指向 '<<' */
DictParser.prototype.parseDict = function () {
  assert(this.data.substr(this.pos, 2) === "<<", "expected '<<'");
  this.pos += 2;
  var result = {};
  while (true) {
    this.skipWhitespace();
    if (this.pos >= this.data.length) {
      break;
    }
    if (this.data.substr(this.pos, 2) === ">>") {
      this.pos += 2;
      break;
    }
    // 键必须是名称
    if (this.data.charCodeAt(this.pos) !== 0x2f) {
      throw new Error("Expected '/' for key");
    }
    var key = this.readName();
    this.skipWhitespace();
    var value = this.parseValue();
    result[key] = value;
  }
  return result;
};

/**
 * 对象流解析器：解析 /Type 为 /ObjStm 的内容流。
 * 按需解析并缓存内部对象，offset_map: obj_id -> [start, end]。
 */
function ObjStmParser(rawData, data) {
  if (rawData) {
    this.rawData = rawData;
    var decoded = inflate(rawData);
    BaseParser.call(this, bytesToLatin1(decoded));
  } else if (data) {
    BaseParser.call(this, data);
  } else {
    throw new Error(
      "ObjStmParser requires at least one argument, rawData or data.",
    );
  }

  this.offsetMap = this.getOffsetMap(); // obj_id -> [start, end]
  this.objMap = new Map(); // obj_id -> PDFObj
}

ObjStmParser.prototype = Object.create(BaseParser.prototype);
ObjStmParser.prototype.constructor = ObjStmParser;

/**
 * 解析偏移表，返回 {obj_id: [start, end]}，区间为 this.data 的索引范围。
 * 注意：内部对象的切片包含对象内容之后的换行符，
 * 因此 PDFObj 解析完字典后 skipWhitespace 会越过 len-1，从而判定为无内容流。
 */
ObjStmParser.prototype.getOffsetMap = function () {
  this.pos = 0;
  var pairs = [];
  // 读取所有 (对象编号, 偏移量) 对，直到遇到非数字内容
  while (true) {
    this.skipWhitespace();
    if (
      this.pos >= this.data.length ||
      !DIGIT_CODES.has(this.data.charCodeAt(this.pos))
    ) {
      break;
    }
    var objId = this.readNumber();
    this.skipWhitespace();
    var offset = this.readNumber();
    pairs.push([objId, offset]);
  }

  // 对象数据开始的基础位置
  this.skipWhitespace();
  var base = this.pos;

  // 按偏移量排序，确保顺序处理
  pairs.sort(function (x, y) {
    return x[1] - y[1];
  });

  var offsetMap = new Map();
  for (var i = 0; i < pairs.length; i++) {
    var objId = pairs[i][0];
    var start = base + pairs[i][1];
    // 下一个对象的起始位置即当前对象的结束位置，最后一个对象到数据末尾
    var end = i + 1 < pairs.length ? base + pairs[i + 1][1] : this.data.length;
    offsetMap.set(objId, [start, end]);
  }
  return offsetMap;
};

/** 按需解析并缓存单个对象，返回 PDFObj 或 null */
ObjStmParser.prototype.parseObj = function (id) {
  if (this.objMap.has(id)) {
    return this.objMap.get(id);
  }
  if (!this.offsetMap.has(id)) {
    return null;
  }
  var range = this.offsetMap.get(id);
  var objBytes = this.data.substring(range[0], range[1]);
  var obj = new PDFObj(objBytes, id);
  this.objMap.set(id, obj);
  return obj;
};

/** 解析全部对象并缓存，返回 {obj_id: PDFObj} 字典 */
ObjStmParser.prototype.parse = function () {
  var self = this;
  this.offsetMap.forEach(function (_, objId) {
    self.parseObj(objId);
  });
  return this.objMap;
};

/**
 * CMap 解析器：解析 ToUnicode CMap 内容流，支持 bfchar 与 bfrange（含数组形式）。
 */
function CMapParser(rawData, data) {
  if (rawData) {
    this.rawData = rawData;
    var decoded = inflate(rawData);
    DictParser.call(this, bytesToLatin1(decoded));
  } else if (data) {
    DictParser.call(this, data);
  } else {
    throw new Error(
      "CMapParser requires at least one argument, rawData or data.",
    );
  }
  this._cmap = null; // Map: int -> int
  this._info = {};
}

CMapParser.prototype = Object.create(DictParser.prototype);
CMapParser.prototype.constructor = CMapParser;

/** 解析 begincodespacerange...endcodespacerange，断言编码空间为 0000~FFFF */
CMapParser.prototype.parseCodeSpaceRange = function (n) {
  for (var i = 0; i < n; i++) {
    this.skipWhitespace();
    var start = this.readHexStr();
    this.skipWhitespace();
    var end = this.readHexStr();
    assert(
      start === "0000" && end === "FFFF",
      "codespacerange must be 0000~FFFF",
    );
  }
  this.skipWhitespace();
  var w = this.readName();
  assert(w === "endcodespacerange");
};

/** 解析 beginbfchar...endbfchar，将 n 对映射加入 cmap */
CMapParser.prototype.parseBfChar = function (cmap, n) {
  for (var i = 0; i < n; i++) {
    this.skipWhitespace();
    var src = this.readHexStr();
    this.skipWhitespace();
    var dst = this.readHexStr();
    cmap.set(parseInt(src, 16), parseInt(dst, 16));
  }
  this.skipWhitespace();
  var w = this.readName();
  assert(w === "endbfchar");
};

/** 解析 beginbfrange...endbfrange，将 n 个范围的映射加入 cmap */
CMapParser.prototype.parseBfRange = function (cmap, n) {
  for (var i = 0; i < n; i++) {
    this.skipWhitespace();
    var srcStart = this.readHexStr();
    this.skipWhitespace();
    var srcEnd = this.readHexStr();
    this.skipWhitespace();

    var s = parseInt(srcStart, 16);
    var e = parseInt(srcEnd, 16);
    if (this.data.charCodeAt(this.pos) === 0x3c) {
      var dstStart = this.readHexStr();
      var d = parseInt(dstStart, 16);
      for (var k = 0; k <= e - s; k++) {
        cmap.set(s + k, d + k);
      }
    } else if (this.data.charCodeAt(this.pos) === 0x5b) {
      var dstList = this.parseArray();
      for (var k = 0; k <= e - s; k++) {
        cmap.set(s + k, parseInt(dstList[k], 16));
      }
    }
  }
  this.skipWhitespace();
  var w = this.readName();
  assert(w === "endbfrange");
};

/** 返回 CMap 映射表（int->int 的 Map），结果会被缓存 */
CMapParser.prototype.getCmap = function () {
  if (this._cmap !== null) {
    return new Map(this._cmap);
  }

  this.pos = 0;
  var cmap = new Map();

  while (this.pos < this.data.length) {
    this.skipWhitespace();
    if (this.pos >= this.data.length) {
      break;
    }

    var ch = this.data.charCodeAt(this.pos);

    if (ch === 0x2f) {
      var name = this.readName();
      if (name === "CIDSystemInfo") {
        this.skipWhitespace();
        var info = this.parseDict();
        this._info = info;
        assert(info["Ordering"] === "UCS");
      } else if (name === "CMapType") {
        this.skipWhitespace();
        var val = this.readNumber();
        assert(val === 2);
      } else if (name === "CMapName") {
        this.skipWhitespace();
        var cmapName = this.readName();
        assert(cmapName === "Adobe-Identity-UCS");
      }
    } else if (DIGIT_CODES.has(ch)) {
      var n = this.readNumber();
      this.skipWhitespace();
      var w = this.readName();
      if (w === "beginbfchar") {
        this.parseBfChar(cmap, n);
      } else if (w === "beginbfrange") {
        this.parseBfRange(cmap, n);
      } else if (w === "begincodespacerange") {
        this.parseCodeSpaceRange(n);
      }
      // 其他如 'dict' 直接忽略，后续 'begin' 由外层循环作为普通单词跳过
    } else {
      var w2 = this.readName();
      if (w2 === "endcmap") {
        break;
      }
      // 其他单词如 begin, def, findresource, pop 等直接忽略
    }
  }

  this._cmap = cmap;
  return cmap;
};

// =======================  辅助类  =======================

/**
 * 代表表格中的单元格 / W* 裁剪区域 / re 填充矩形占据区域。
 * 传入 clip 时按裁剪区域求交得到实际占据区域。
 */
function Rect(x, y, width, height, clip, fillColor) {
  if (clip === null || clip === undefined) {
    this.x1 = x;
    this.y1 = y;
    this.x2 = this.x1 + width;
    this.y2 = this.y1 + height;
  } else {
    // 输入裁剪区域时，按裁剪区域计算实际占据区域（与原区域求交）
    this.x1 = Math.max(x, clip.x1);
    this.y1 = Math.max(y, clip.y1);
    this.x2 = Math.min(x + width, clip.x2);
    this.y2 = Math.min(y + height, clip.y2);
    assert(
      this.x1 <= this.x2 && this.y1 <= this.y2,
      "矩形 (" +
        x +
        ", " +
        y +
        ", " +
        width +
        ", " +
        height +
        ") 与裁剪区域无交集",
    );
  }
  this.fillColor = fillColor === undefined ? null : fillColor; // 填充色: g 灰度 / rg (r,g,b)，null 表示默认(黑)
}

/** 点是否在矩形内（含边界） */
Rect.prototype.containsPoint = function (x, y) {
  return this.x1 <= x && x <= this.x2 && this.y1 <= y && y <= this.y2;
};

/** 矩形是否被本矩形包含（含 TOLANCE 容许误差） */
Rect.prototype.containsRect = function (r) {
  return (
    this.x1 - TOLERANCE <= r.x1 &&
    r.x2 <= this.x2 + TOLERANCE &&
    this.y1 - TOLERANCE <= r.y1 &&
    r.y2 <= this.y2 + TOLERANCE
  );
};

/** 两个矩形是否一致（含 TOLANCE 容许误差） */
Rect.prototype.equals = function (r) {
  return (
    Math.abs(r.x1 - this.x1) <= TOLERANCE &&
    Math.abs(r.x2 - this.x2) <= TOLERANCE &&
    Math.abs(r.y1 - this.y1) <= TOLERANCE &&
    Math.abs(r.y2 - this.y2) <= TOLERANCE
  );
};

Rect.prototype.toString = function () {
  return (
    "Rect: x1=" +
    this.x1 +
    ", x2=" +
    this.x2 +
    ", y1=" +
    this.y1 +
    ", y2=" +
    this.y2 +
    ", fill_color=" +
    this.fillColor
  );
};

/**
 * 一条线段（由 m/l/S 指令产生），保存绘制时的图形状态。
 */
function Line(x1, y1, x2, y2, opts) {
  opts = opts || {};
  this.x1 = x1;
  this.y1 = y1;
  this.x2 = x2;
  this.y2 = y2;
  this.width = opts.width;
  this.capStyle = opts.capStyle !== undefined ? opts.capStyle : 2;
  this.joinStyle = opts.joinStyle !== undefined ? opts.joinStyle : 1;
  this.clip = opts.clip === undefined ? null : opts.clip; // 构造时输入的 W* 裁剪矩形
  this.strokeColor = opts.strokeColor === undefined ? null : opts.strokeColor; // 描边色: G 灰度 / RG (r,g,b)，null 表示默认(黑)
}

/**
 * 返回该线所占据的矩形区域。
 * 不是水平或竖直线，或者 J 指令为 1（圆头）时报错。
 */
Line.prototype.rect = function () {
  // 检查 cap_style 是否为 1（圆头）
  if (this.capStyle === 1) {
    throw new Error(
      "cap_style 1 (round cap) is not supported for rect() because the occupied area is not rectangular",
    );
  }

  var half = this.width / 2;

  // 竖直线：x1 == x2
  if (this.x1 === this.x2) {
    var yMin = Math.min(this.y1, this.y2);
    var yMax = Math.max(this.y1, this.y2);
    var xLeft = this.x1 - half;
    var xRight = this.x1 + half;

    if (this.capStyle === 2) {
      // square cap: extend along y direction
      yMin -= half;
      yMax += half;
    }
    return new Rect(xLeft, yMin, this.width, yMax - yMin, this.clip);
  }
  // 水平线：y1 == y2
  else if (this.y1 === this.y2) {
    var xMin = Math.min(this.x1, this.x2);
    var xMax = Math.max(this.x1, this.x2);
    var yTop = this.y1 - half;
    var yBottom = this.y1 + half;

    if (this.capStyle === 2) {
      // square cap: extend along x direction
      xMin -= half;
      xMax += half;
    }
    return new Rect(xMin, yTop, xMax - xMin, this.width, this.clip);
  } else {
    throw new Error(
      "Line is neither horizontal nor vertical; cannot compute a rectangular bounding box",
    );
  }
};

/**
 * 解析过程中的作用域帧：
 * kind:
 *   'q'      -- q...Q 图形状态作用域，保存/恢复裁剪区域与线宽等状态
 *   'BDC'    -- /P <<...>> BDC...EMC 标记内容块，block 保存解析结果
 *   'ignore' -- BMC...EMC(/Artifact 等)被整体忽略的构件
 * q/Q 帧放入图形状态栈，BDC/BMC 帧放入标记内容栈，两类栈相互独立，
 * 以支持 q...BDC...Q...EMC 这样的交错结构。
 */
function makeScope(kind, state) {
  state = state || {};
  return {
    kind: kind,
    clip: state.clip !== undefined ? state.clip : null,
    lineWidth: state.lineWidth !== undefined ? state.lineWidth : null,
    capStyle: state.capStyle !== undefined ? state.capStyle : null,
    joinStyle: state.joinStyle !== undefined ? state.joinStyle : null,
    fillColor: state.fillColor !== undefined ? state.fillColor : null,
    strokeColor: state.strokeColor !== undefined ? state.strokeColor : null,
    font: state.font !== undefined ? state.font : null,
    block: state.block !== undefined ? state.block : null,
  };
}

/** 一个 Tm + TJ/Tj 对应的文本片段 */
function TextItem(font, x, y, text, parts, source, clip) {
  this.font = font; // 当前字体名，如 'F1'，未设置 Tf 时为 null
  this.x = x; // Tm 基线坐标
  this.y = y;
  this.text = text; // 已经拼合的文字内容
  this.parts = parts; // 每个 TJ/Tj 指令的值，或者说尚未进行拼合的具体内容
  this.source = source; // 来源信息，为 '()' 或 '<>'
  this.clip = clip; // 裁剪矩形
}

TextItem.prototype.toString = function () {
  return (
    "text: font=" +
    this.font +
    ", base_line=(" +
    this.x +
    "," +
    this.y +
    "), text=" +
    this.text +
    ", source=" +
    this.source +
    ", clip=" +
    this.clip
  );
};

/** 代表一个 /P <<...>> BDC...EMC 或 /Span <<...>> BDC...EMC 标记内容块 */
function MarkedContentBlock(markType, mcid) {
  this.markType = markType; // BDC 的构件名称：'P' 或 'Span'
  this.mcid = mcid; // /MCID 值，未给出时为 undefined
  this.textItems = [];
}

MarkedContentBlock.prototype.toString = function () {
  return (
    "MarkedContentBlock: mcid=" +
    this.mcid +
    ",type=" +
    this.markType +
    ", text_items=" +
    this.textItems
  );
};

/**
 * 页面内容流解析器：遍历整个内容流一次，提取绘制指令与标记内容块。
 * 解析结果保存在：
 * - rects: 使用 f* 填充的矩形列表（将计算出指令中裁剪后的结果）
 * - lines: 使用 m l S 画出的线列表（保存时附带当时的裁剪区域）
 * - markedBlocks: /P <<...>> BDC...EMC 标记内容块列表
 */
function ContentParser(rawData, data) {
  if (rawData) {
    this.rawData = rawData;
    var decoded = inflate(rawData);
    DictParser.call(this, bytesToLatin1(decoded));
  } else if (data) {
    DictParser.call(this, data);
  } else {
    throw new Error(
      "ContentParser requires at least one argument, rawData or data.",
    );
  }
}

ContentParser.prototype = Object.create(DictParser.prototype);
ContentParser.prototype.constructor = ContentParser;

ContentParser.prototype.parse = function () {
  this.pos = 0;
  this.rects = [];
  this.lines = [];
  this.markedBlocks = [];

  // q/Q 与 BDC/EMC 各自成对、可以互相交错（如 q...BDC...Q...EMC），
  // 因此分别使用图形状态栈与标记内容栈进行管理
  this._gsStack = [];
  this._mcStack = [];
  this._clip = null;
  this._lineWidth = null;
  this._capStyle = 0;
  this._joinStyle = 0;
  this._fillColor = null;
  this._strokeColor = null;

  // 待完成的路径
  this._pendingRect = null;
  this._pendingLineStart = null;
  this._pendingLine = null;

  // 文本状态
  this._font = null;
  // 文本对象栈: BT 压入新帧, ET 弹出。帧内保存 Tm 设置的基线坐标,
  // BT 时重置为 null（文本矩阵为单位矩阵），因此 Tm 只在当前 BT...ET 内有效
  this._textStack = [];
  this._activeMcBlock = null;

  var operands = [];
  while (this.pos < this.data.length) {
    this.skipWhitespace();
    if (this.pos >= this.data.length) {
      break;
    }

    var ch = this.data.charCodeAt(this.pos);
    if (NUM_CODES.has(ch)) {
      // 数字: 指令的操作数先入栈, 读到运算符再出栈
      operands.push(this.readNumber());
    } else if (ch === 0x2f) {
      // 名称: 可能是 /P /Artifact, 也可能是 Tf 的字体名等操作数
      operands.push(this.readName());
    } else if (ch === 0x28) {
      operands.push([this.readString(), "()"]);
    } else if (ch === 0x3c) {
      if (this.data.substr(this.pos, 2) === "<<") {
        operands.push(this.parseDict());
      } else {
        operands.push([this.readHexStr(), "<>"]);
      }
    } else if (ch === 0x5b) {
      operands.push(this.readTextArray());
    } else {
      var op = this.readName();
      this._execute(op, operands);
    }
  }
};

/**
 * 解析 TJ 指令的数组，返回元素列表，元素格式为：
 * 1. [text, '()'] 表示 TJ 指令值中的 () 中的内容
 * 2. [text, '<>'] 表示 TJ 指令值中的 <> 中的内容
 * 3. number      表示 TJ 指令值中的间距调整值
 */
ContentParser.prototype.readTextArray = function () {
  assert(this.data.charCodeAt(this.pos) === 0x5b, "expected '['");
  this.pos += 1;
  var elements = [];
  while (true) {
    this.skipWhitespace();
    if (this.pos >= this.data.length) {
      break;
    }
    var ch = this.data.charCodeAt(this.pos);
    if (ch === 0x5d) {
      this.pos += 1;
      break;
    } else if (ch === 0x28) {
      elements.push([this.readString(), "()"]);
    } else if (ch === 0x3c) {
      elements.push([this.readHexStr(), "<>"]);
    } else if (NUM_CODES.has(ch)) {
      elements.push(this.readNumber());
    } else {
      throw new Error(
        "Unexpected byte " +
          JSON.stringify(String.fromCharCode(ch)) +
          " in TJ array at pos=" +
          this.pos,
      );
    }
  }
  return elements;
};

/** 当前是否位于被忽略的构件（如 /Artifact BMC...EMC）内部 */
ContentParser.prototype._ignoring = function () {
  for (var i = 0; i < this._mcStack.length; i++) {
    if (this._mcStack[i].kind === "ignore") {
      return true;
    }
  }
  return false;
};

/** 返回仍在解析中的最内层 BDC 标记内容块，没有则返回 null */
ContentParser.prototype._nearestMcBlock = function () {
  for (var i = this._mcStack.length - 1; i >= 0; i--) {
    var frame = this._mcStack[i];
    if (frame.kind === "BDC" && frame.block !== null) {
      return frame.block;
    }
  }
  return null;
};

/** 执行内容流运算符，操作数已按出现顺序压入 operands 栈 */
ContentParser.prototype._execute = function (op, operands) {
  var ignoring = this._ignoring();

  if (op === "q") {
    if (ignoring) {
      return;
    }
    this._gsStack.push(
      makeScope("q", {
        clip: this._clip,
        lineWidth: this._lineWidth,
        capStyle: this._capStyle,
        joinStyle: this._joinStyle,
        fillColor: this._fillColor,
        strokeColor: this._strokeColor,
        font: this._font,
      }),
    );
  } else if (op === "Q") {
    if (ignoring) {
      return;
    }
    var frame = this._gsStack.pop();
    assert(frame !== undefined && frame.kind === "q");
    this._clip = frame.clip;
    this._lineWidth = frame.lineWidth;
    this._capStyle = frame.capStyle;
    this._joinStyle = frame.joinStyle;
    this._fillColor = frame.fillColor;
    this._strokeColor = frame.strokeColor;
    this._font = frame.font;
  } else if (op === "BMC") {
    operands.pop(); // /Artifact 等构件名称, 忽略
    this._mcStack.push(makeScope("ignore"));
  } else if (op === "BDC") {
    var props = operands.pop();
    var name = operands.pop();
    assert(name === "P" || name === "Span", "BDC name must be 'P' or 'Span'");
    var block = null;
    if (!this._ignoring()) {
      block = new MarkedContentBlock(name, props["MCID"]);
      this._activeMcBlock = block;
    }
    this._mcStack.push(makeScope("BDC", { block: block }));
  } else if (op === "EMC") {
    var frame2 = this._mcStack.pop();
    assert(
      frame2 !== undefined &&
        (frame2.kind === "BDC" || frame2.kind === "ignore"),
    );
    if (frame2.kind === "BDC" && frame2.block !== null) {
      this.markedBlocks.push(frame2.block);
    }
    this._activeMcBlock = this._nearestMcBlock();
  } else if (op === "BT") {
    if (ignoring) {
      return;
    }
    // 新文本对象: 文本矩阵/文本行矩阵重置为单位矩阵
    this._textStack.push(null);
  } else if (op === "ET") {
    if (ignoring) {
      return;
    }
    assert(this._textStack.length > 0);
    this._textStack.pop();
  } else if (op === "Tf") {
    var size = operands.pop();
    var font = operands.pop();
    if (ignoring) {
      return;
    }
    this._font = font;
  } else if (op === "Tm") {
    var f = operands.pop();
    var e = operands.pop();
    var d = operands.pop();
    var c = operands.pop();
    var b = operands.pop();
    var a = operands.pop();
    assert(
      a === 1 && b === 0 && c === 0 && d === 1,
      "Tm matrix must be identity (translation only)",
    );
    if (ignoring) {
      return;
    }
    assert(this._textStack.length > 0);
    this._textStack[this._textStack.length - 1] = [e, f];
  } else if (op === "TJ") {
    var elements = operands.pop();
    if (ignoring) {
      return;
    }

    assert(this._textStack.length > 0);
    var baseline = this._textStack[this._textStack.length - 1];
    assert(baseline !== null && baseline !== undefined, "TJ without Tm");
    var x = baseline[0];
    var y = baseline[1];

    var block = this._activeMcBlock;
    assert(
      block !== null && block !== undefined,
      "TJ outside marked content block",
    );

    // 连续同源段将合并为一个 TextItem
    var groups = []; // 单个元素为 [source, [content, ...]]
    for (var i = 0; i < elements.length; i++) {
      var element = elements[i];
      if (!Array.isArray(element)) {
        // 为字距调整数字, 不需要
        continue;
      }
      var data = element[0];
      var source = element[1];
      if (groups.length > 0 && groups[groups.length - 1][0] === source) {
        // 按相同来源进行合并（同为 '()' 类型或者同为 '<>' 类型则直接合并）
        groups[groups.length - 1][1].push(data);
      } else {
        groups.push([source, [data]]);
      }
    }

    // 翻译成对应的 TextItem 类
    for (var gi = 0; gi < groups.length; gi++) {
      var group = groups[gi];
      block.textItems.push(
        new TextItem(
          this._font,
          x,
          y,
          group[1].join(""),
          group[1],
          group[0],
          this._clip,
        ),
      );
    }
  } else if (op === "Tj") {
    var tjOperand = operands.pop();
    if (ignoring) {
      return;
    }
    assert(this._textStack.length > 0);
    var baseline2 = this._textStack[this._textStack.length - 1];
    assert(baseline2 !== null && baseline2 !== undefined, "Tj without Tm");
    var x2 = baseline2[0];
    var y2 = baseline2[1];
    var block2 = this._activeMcBlock;
    assert(
      block2 !== null && block2 !== undefined,
      "Tj outside marked content block",
    );
    block2.textItems.push(
      new TextItem(
        this._font,
        x2,
        y2,
        tjOperand[0],
        [tjOperand[0]],
        tjOperand[1],
        this._clip,
      ),
    );
  } else if (op === "Tc") {
    operands.pop();
  } else if (op === "Tr") {
    operands.pop();
  } else if (op === "re") {
    var height = operands.pop();
    var width = operands.pop();
    var ry = operands.pop();
    var rx = operands.pop();
    if (!ignoring) {
      this._pendingRect = new Rect(rx, ry, width, height);
    }
  } else if (op === "W*") {
    if (ignoring) {
      return;
    }
    assert(this._pendingRect !== null, "W* without re");
    var clip = this._pendingRect;
    if (this._clip === null) {
      this._clip = clip;
    } else {
      // 嵌套裁剪: 新裁剪区域与已有裁剪区域求交
      this._clip = new Rect(
        this._clip.x1,
        this._clip.y1,
        this._clip.x2 - this._clip.x1,
        this._clip.y2 - this._clip.y1,
        clip,
      );
    }
    this._pendingRect = null;
  } else if (op === "n") {
    if (!ignoring) {
      this._pendingRect = null;
      this._pendingLine = null;
    }
  } else if (op === "f*") {
    if (ignoring) {
      return;
    }
    assert(this._pendingRect !== null, "f* without re");
    var pending = this._pendingRect;
    var rect = new Rect(
      pending.x1,
      pending.y1,
      pending.x2 - pending.x1,
      pending.y2 - pending.y1,
      this._clip,
      this._fillColor,
    );
    this.rects.push(rect);
    this._pendingRect = null;
  } else if (op === "m") {
    var my = operands.pop();
    var mx = operands.pop();
    if (!ignoring) {
      this._pendingLineStart = [mx, my];
      this._pendingLine = null;
    }
  } else if (op === "l") {
    var ly2 = operands.pop();
    var lx2 = operands.pop();
    if (!ignoring) {
      assert(this._pendingLineStart !== null, "l without m");
      var x1 = this._pendingLineStart[0];
      var y1 = this._pendingLineStart[1];
      this._pendingLine = new Line(x1, y1, lx2, ly2, {
        width: this._lineWidth,
        capStyle: this._capStyle,
        joinStyle: this._joinStyle,
        clip: this._clip,
        strokeColor: this._strokeColor,
      });
      this._pendingLineStart = null;
    }
  } else if (op === "S") {
    if (ignoring) {
      return;
    }
    assert(this._pendingLine !== null, "S without l");
    this.lines.push(this._pendingLine);
    this._pendingLine = null;
  } else if (op === "w") {
    var value = operands.pop();
    if (!ignoring) {
      this._lineWidth = value;
    }
  } else if (op === "J") {
    var value2 = operands.pop();
    if (!ignoring) {
      this._capStyle = value2;
    }
  } else if (op === "j") {
    var value3 = operands.pop();
    if (!ignoring) {
      this._joinStyle = value3;
    }
  } else if (op === "g") {
    var value4 = operands.pop();
    if (!ignoring) {
      this._fillColor = value4;
    }
  } else if (op === "G") {
    var value5 = operands.pop();
    if (!ignoring) {
      this._strokeColor = value5;
    }
  } else if (op === "rg") {
    var blue = operands.pop();
    var green = operands.pop();
    var red = operands.pop();
    if (!ignoring) {
      this._fillColor = [red, green, blue];
    }
  } else if (op === "RG") {
    var blue2 = operands.pop();
    var green2 = operands.pop();
    var red2 = operands.pop();
    if (!ignoring) {
      this._strokeColor = [red2, green2, blue2];
    }
  } else {
    // 未出现的其它指令按设计原则无需处理, 直接忽略
    // 注意: 与 Python 版一致, 此处不弹出操作数——未知指令的操作数
    // 会残留在栈底, 但后续指令总是弹出恰好等于自身操作数个数的值,
    // 因此残留操作数不影响解析结果
  }
};

// =======================  pdf 对象类  =======================

/**
 * 一个 PDF 间接对象：解析 "N G obj <<...>> [stream ... endstream] endobj"。
 * 也用于对象流内部的压缩对象（此时传入 id，跳过头部解析）。
 */
function PDFObj(data, id) {
  this.data = data;
  this.parser = new DictParser(data);
  this.id = id !== undefined && id !== null ? id : this._getId();
  this.dict = this._getDict();

  this.rawStream = this._getStream();
}

PDFObj.prototype._getId = function () {
  this.parser.skipWhitespace();
  var id = this.parser.readNumber();

  this.parser.skipWhitespace();
  var genNumber = this.parser.readNumber();
  assert(genNumber === 0, "generation number must be 0");

  this.parser.skipWhitespace();
  var keyword = this.parser.readName();
  assert(keyword === "obj", "expected 'obj'");

  return id;
};

PDFObj.prototype._getDict = function () {
  this.parser.skipWhitespace();
  return this.parser.parseDict();
};

PDFObj.prototype._getStream = function () {
  this.parser.skipWhitespace();
  if (this.parser.pos >= this.data.length - 1) {
    // 没有内容流的情形（对象流内部对象的切片以换行结尾时也会走到这里）
    return null;
  }
  var keyword = this.parser.readName();

  if (keyword === "endobj") {
    return null;
  } else if (keyword === "stream") {
    this.parser.skipWhitespace();
    var start = this.parser.pos;
    var end = this.data.indexOf("endstream");
    return this.data.substring(start, end);
  } else {
    throw new Error(
      "Unexpected keyword " + JSON.stringify(keyword) + " in obj" + this.id,
    );
  }
};

/**
 * 内容对象：解析内容流，并据此重建表格结构（懒加载并缓存）。
 */
function ContentObj(data, id) {
  PDFObj.call(this, data, id);
  assert(this.rawStream !== null, "ContentObj requires a stream");
  this.contentParser = new ContentParser(this.rawStream);
  this.contentParser.parse();

  this._cells = null;
  this._tables = null;
}

ContentObj.prototype = Object.create(PDFObj.prototype);
ContentObj.prototype.constructor = ContentObj;

/**
 * 从 contentParser 解析出的 lines 和 rects 重建表格。
 * 重建逻辑：
 * 1. 预处理, 丢弃非纯黑色的矩形或线条
 * 2. 将纯黑色网格单元按四连通分组, 每个黑色连通分量视为一个表格
 * 3. 在每个黑色连通分量内部以黑色作为"墙"切割出单元格
 * 4. 从黑色网格中识别横竖表格线, 建立逻辑行列
 * 5. 将每个单元格映射到逻辑行列, 得到 row_start/col_start/row_span/col_span
 */
ContentObj.prototype.getCells = function () {
  if (this._cells !== null) {
    return this._cells;
  }

  var self = this;

  // 预处理函数: 用于判断填充/描边色是否为纯黑。
  // g/G 指令记录单个灰度值, rg/RG 指令记录 [r,g,b]; null 表示该指令未出现,
  // 按 PDF 规范图形状态默认填充/描边色为黑色。
  function isPureBlack(color) {
    if (color === null || color === undefined) {
      return true;
    }
    if (Array.isArray(color)) {
      return color.every(function (c) {
        return c === 0;
      });
    }
    return color === 0;
  }

  var blackRects = this.contentParser.rects.filter(function (r) {
    return isPureBlack(r.fillColor);
  });
  var lines = this.contentParser.lines;
  for (var li = 0; li < lines.length; li++) {
    if (isPureBlack(lines[li].strokeColor)) {
      blackRects.push(lines[li].rect());
    }
  }
  if (blackRects.length === 0) {
    return [];
  }

  // 网格边界: 所有黑色矩形在 x/y 方向的边
  var xsSet = new Set();
  var ysSet = new Set();
  for (var bi = 0; bi < blackRects.length; bi++) {
    var r = blackRects[bi];
    xsSet.add(round6(r.x1));
    xsSet.add(round6(r.x2));
    ysSet.add(round6(r.y1));
    ysSet.add(round6(r.y2));
  }
  var xs = Array.from(xsSet).sort(function (a, b) {
    return a - b;
  });
  var ys = Array.from(ysSet).sort(function (a, b) {
    return a - b;
  });
  var nx = xs.length - 1;
  var ny = ys.length - 1;

  assert(nx > 0 && ny > 0, "nx and ny must be positive");

  // 标记黑色网格单元: 网格单元被某一黑色矩形(含容差)完全覆盖即为边框
  var black = [];
  for (var jj = 0; jj < ny; jj++) {
    var row = new Array(nx);
    for (var ii = 0; ii < nx; ii++) {
      row[ii] = false;
    }
    black.push(row);
  }
  for (var bj = 0; bj < blackRects.length; bj++) {
    var r2 = blackRects[bj];
    for (var j = 0; j < ny; j++) {
      var y1 = ys[j];
      var y2 = ys[j + 1];

      // 清洗表格边框之间的不可见空隙
      if (!(r2.y1 - MERGE_GAP <= y1 && y2 <= r2.y2 + MERGE_GAP)) {
        continue;
      }
      for (var i = 0; i < nx; i++) {
        var x1 = xs[i];
        var x2 = xs[i + 1];
        if (r2.x1 - MERGE_GAP <= x1 && x2 <= r2.x2 + MERGE_GAP) {
          black[j][i] = true;
        }
      }
    }
  }

  // 并查集: 合并相邻(四连通)的黑色网格单元, 得到表格边框连通分量
  var parent = [];
  for (var pi = 0; pi < nx * ny; pi++) {
    parent.push(pi);
  }

  function find(a) {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  }

  function union(a, b) {
    var ra = find(a);
    var rb = find(b);
    if (ra !== rb) {
      parent[rb] = ra;
    }
  }

  for (var uj = 0; uj < ny; uj++) {
    for (var ui = 0; ui < nx; ui++) {
      if (!black[uj][ui]) {
        continue;
      }
      var idx = uj * nx + ui;
      if (ui + 1 < nx && black[uj][ui + 1]) {
        union(idx, idx + 1);
      }
      if (uj + 1 < ny && black[uj + 1][ui]) {
        union(idx, idx + nx);
      }
    }
  }

  var blackComponents = new Map(); // root -> [[i, j], ...]
  for (var cj = 0; cj < ny; cj++) {
    for (var ci = 0; ci < nx; ci++) {
      if (black[cj][ci]) {
        var root = find(cj * nx + ci);
        if (!blackComponents.has(root)) {
          blackComponents.set(root, []);
        }
        blackComponents.get(root).push([ci, cj]);
      }
    }
  }

  /** 对一个黑色连通分量执行白色区域提取逻辑 */
  function extractCells(component) {
    var iMin = Infinity;
    var iMax = -Infinity;
    var jMin = Infinity;
    var jMax = -Infinity;
    for (var ci2 = 0; ci2 < component.length; ci2++) {
      var cell = component[ci2];
      if (cell[0] < iMin) {
        iMin = cell[0];
      }
      if (cell[0] > iMax) {
        iMax = cell[0];
      }
      if (cell[1] < jMin) {
        jMin = cell[1];
      }
      if (cell[1] > jMax) {
        jMax = cell[1];
      }
    }
    var width = iMax - iMin + 1;
    var height = jMax - jMin + 1;
    var localXs = xs.slice(iMin, iMin + width + 1);
    var localYs = ys.slice(jMin, jMin + height + 1);

    // 只保留当前表格边框的黑色网格单元
    var localBlack = [];
    for (var lj = 0; lj < height; lj++) {
      var lrow = new Array(width);
      for (var li = 0; li < width; li++) {
        lrow[li] = false;
      }
      localBlack.push(lrow);
    }
    for (var cj2 = 0; cj2 < component.length; cj2++) {
      var c2 = component[cj2];
      localBlack[c2[1] - jMin][c2[0] - iMin] = true;
    }

    function getRuns(values) {
      var runs = [];
      var start = null;
      for (var index = 0; index < values.length; index++) {
        var marked = values[index];
        if (marked && start === null) {
          start = index;
        }
        if (!marked && start !== null) {
          runs.push([start, index - 1]);
          start = null;
        }
      }
      if (start !== null) {
        runs.push([start, values.length - 1]);
      }
      return runs;
    }

    /** 从黑色网格行中识别横向表格线 */
    function getHorizontalBoundaries() {
      var boundaries = [];
      var band = null;
      for (var j = 0; j < height; j++) {
        var isLineRow = false;
        var rowRuns = getRuns(localBlack[j]);
        for (var ri = 0; ri < rowRuns.length; ri++) {
          var run = rowRuns[ri];
          if (localXs[run[1] + 1] - localXs[run[0]] >= LINE_MIN_SPAN) {
            isLineRow = true;
            break;
          }
        }
        if (isLineRow) {
          if (band !== null && j === band[band.length - 1] + 1) {
            band.push(j);
          } else {
            band = [j];
            boundaries.push(band);
          }
        } else {
          band = null;
        }
      }
      var centers = [];
      for (var bi2 = 0; bi2 < boundaries.length; bi2++) {
        var rows = boundaries[bi2];
        centers.push(
          (localYs[rows[0]] + localYs[rows[rows.length - 1] + 1]) / 2,
        );
      }
      return centers.reverse();
    }

    /** 从黑色网格列中识别纵向表格线 */
    function getVerticalBoundaries() {
      var boundaries = [];
      var band = null;
      for (var i = 0; i < width; i++) {
        var column = [];
        for (var j = 0; j < height; j++) {
          column.push(localBlack[j][i]);
        }
        var isLineColumn = false;
        var colRuns = getRuns(column);
        for (var ri2 = 0; ri2 < colRuns.length; ri2++) {
          var run2 = colRuns[ri2];
          if (localYs[run2[1] + 1] - localYs[run2[0]] >= LINE_MIN_SPAN) {
            isLineColumn = true;
            break;
          }
        }
        if (isLineColumn) {
          if (band !== null && i === band[band.length - 1] + 1) {
            band.push(i);
          } else {
            band = [i];
            boundaries.push(band);
          }
        } else {
          band = null;
        }
      }
      var centers = [];
      for (var bi3 = 0; bi3 < boundaries.length; bi3++) {
        var cols = boundaries[bi3];
        centers.push(
          (localXs[cols[0]] + localXs[cols[cols.length - 1] + 1]) / 2,
        );
      }
      return centers;
    }

    var rowBoundaries = getHorizontalBoundaries();
    var colBoundaries = getVerticalBoundaries();

    function nearestIndex(boundaries, value) {
      var index = 0;
      var best = Infinity;
      for (var k = 0; k < boundaries.length; k++) {
        var d = Math.abs(boundaries[k] - value);
        if (d < best) {
          best = d;
          index = k;
        }
      }
      if (best > LINE_EDGE_TOLERANCE) {
        throw new Error(
          "cell edge " + value + " is too far from any table line",
        );
      }
      return index;
    }

    // 并查集: 合并当前表格内相邻(四连通)的白色网格单元
    var localParent = [];
    for (var lp = 0; lp < width * height; lp++) {
      localParent.push(lp);
    }

    function localFind(a) {
      while (localParent[a] !== a) {
        localParent[a] = localParent[localParent[a]];
        a = localParent[a];
      }
      return a;
    }

    function localUnion(a, b) {
      var ra = localFind(a);
      var rb = localFind(b);
      if (ra !== rb) {
        localParent[rb] = ra;
      }
    }

    for (var wj = 0; wj < height; wj++) {
      for (var wi = 0; wi < width; wi++) {
        if (localBlack[wj][wi]) {
          continue;
        }
        var widx = wj * width + wi;
        if (wi + 1 < width && !localBlack[wj][wi + 1]) {
          localUnion(widx, widx + 1);
        }
        if (wj + 1 < height && !localBlack[wj + 1][wi]) {
          localUnion(widx, widx + width);
        }
      }
    }

    // 每个白色连通分量的包围盒即一个单元格
    var groups = new Map(); // root -> [[i, j], ...]
    for (var gj = 0; gj < height; gj++) {
      for (var gi = 0; gi < width; gi++) {
        if (!localBlack[gj][gi]) {
          var groot = localFind(gj * width + gi);
          if (!groups.has(groot)) {
            groups.set(groot, []);
          }
          groups.get(groot).push([gi, gj]);
        }
      }
    }

    var cells = [];
    groups.forEach(function (members) {
      var liMin = Infinity;
      var liMax = -Infinity;
      var ljMin = Infinity;
      var ljMax = -Infinity;
      for (var mi = 0; mi < members.length; mi++) {
        var m = members[mi];
        if (m[0] < liMin) {
          liMin = m[0];
        }
        if (m[0] > liMax) {
          liMax = m[0];
        }
        if (m[1] < ljMin) {
          ljMin = m[1];
        }
        if (m[1] > ljMax) {
          ljMax = m[1];
        }
      }
      var x1 = localXs[liMin];
      var x2 = localXs[liMax + 1];
      var y1 = localYs[ljMin];
      var y2 = localYs[ljMax + 1];
      if (
        liMin === 0 ||
        liMax === width - 1 ||
        ljMin === 0 ||
        ljMax === height - 1
      ) {
        return; // 贴边的白色区域不是被四面包围的单元格
      }
      var cellRect = new Rect(x1, y1, x2 - x1, y2 - y1);

      // 此处认为 row_start 和 col_start 的原点位于表格左上角
      var colStart = nearestIndex(colBoundaries, cellRect.x1);
      var colEnd = nearestIndex(colBoundaries, cellRect.x2);
      var rowStart = nearestIndex(rowBoundaries, cellRect.y2);
      var rowEnd = nearestIndex(rowBoundaries, cellRect.y1);
      assert(
        colStart < colEnd && rowStart < rowEnd,
        "invalid cell logical range",
      );
      cells.push({
        row_start: rowStart,
        col_start: colStart,
        row_span: rowEnd - rowStart,
        col_span: colEnd - colStart,
        bbox: [cellRect.x1, cellRect.y1, cellRect.x2, cellRect.y2],
        rect: cellRect,
      });
    });

    // 按阅读顺序: 从上到下, 同一行内从左到右
    cells.sort(function (a, b) {
      return b.rect.y1 - a.rect.y1 || a.rect.x1 - b.rect.x1;
    });
    return {
      total_rows: rowBoundaries.length - 1,
      total_cols: colBoundaries.length - 1,
      cells: cells,
    };
  }

  var tables = [];
  blackComponents.forEach(function (members) {
    tables.push(extractCells(members));
  });
  tables = tables.filter(function (table) {
    return table.cells.length > 0;
  });

  // 按阅读顺序排列表格本身（先预计算排序键）
  var tableKeys = tables.map(function (table) {
    var minY = Infinity;
    var minX = Infinity;
    for (var ci3 = 0; ci3 < table.cells.length; ci3++) {
      var cell = table.cells[ci3];
      if (cell.rect.y1 < minY) {
        minY = cell.rect.y1;
      }
      if (cell.rect.x1 < minX) {
        minX = cell.rect.x1;
      }
    }
    return [minY, minX];
  });
  var order = tables.map(function (_, idx) {
    return idx;
  });
  order.sort(function (a, b) {
    return (
      tableKeys[b][0] - tableKeys[a][0] || tableKeys[a][1] - tableKeys[b][1]
    );
  });
  var sortedTables = [];
  for (var oi = 0; oi < order.length; oi++) {
    sortedTables.push(tables[order[oi]]);
  }
  tables = sortedTables;

  this._cells = tables;
  return tables;
};

/**
 * 将 markedBlocks 定位到 getCells 得到的单元格中。
 * 定位优先级顺序：
 * 1. clip 与某个单元格矩形相等
 * 2. 根据包含基线坐标 + 位于裁剪区域内部进行筛选, 能确定出唯一单元格
 * 3. 无法定位时认为该 block 不在表格当中
 */
ContentObj.prototype.getTables = function () {
  if (this._tables !== null) {
    return this._tables;
  }

  this._cells = this.getCells();

  var tables = [];
  var self = this;
  for (var ti = 0; ti < this._cells.length; ti++) {
    var table = this._cells[ti];
    var cells = [];
    for (var ci = 0; ci < table.cells.length; ci++) {
      var cell = table.cells[ci];
      var cellCopy = {};
      for (var key in cell) {
        if (Object.prototype.hasOwnProperty.call(cell, key)) {
          cellCopy[key] = cell[key];
        }
      }
      cellCopy.marked_blocks = [];
      cells.push(cellCopy);
    }
    cells.sort(function (a, b) {
      return a.row_start - b.row_start || a.col_start - b.col_start;
    });
    tables.push({
      total_rows: table.total_rows,
      total_cols: table.total_cols,
      cells: cells,
    });
  }

  var allCells = [];
  for (var t2 = 0; t2 < tables.length; t2++) {
    var table2 = tables[t2];
    for (var c2 = 0; c2 < table2.cells.length; c2++) {
      allCells.push(table2.cells[c2]);
    }
  }

  /** 将单个标记内容块定位到单元格，无法定位时返回 null */
  function locateBlock(block) {
    // 1. 若某个 TextItem 的裁剪区域与某个单元格一致, 则认为所有 TextItem 属于该单元格
    for (var i = 0; i < block.textItems.length; i++) {
      var item = block.textItems[i];
      for (var j = 0; j < allCells.length; j++) {
        var cell = allCells[j];
        if (
          item.clip !== null &&
          item.clip !== undefined &&
          item.clip.equals(cell.rect)
        ) {
          return cell;
        }
      }
    }

    // 2. 若无法找到完全一致的单元格, 则根据包含基线坐标 + 位于裁剪区域内部进行筛选
    // 断言此类单元格只有一个
    var locatedCell = null;
    for (var i2 = 0; i2 < block.textItems.length; i2++) {
      var item2 = block.textItems[i2];
      var matches = [];
      for (var j2 = 0; j2 < allCells.length; j2++) {
        var cell2 = allCells[j2];
        if (
          cell2.rect.containsPoint(item2.x, item2.y) &&
          item2.clip !== null &&
          item2.clip !== undefined &&
          item2.clip.containsRect(cell2.rect)
        ) {
          matches.push(cell2);
        }
      }

      if (matches.length !== 1) {
        continue;
      }

      var match = matches[0];
      if (locatedCell === null) {
        locatedCell = match;
      } else if (!match.rect.equals(locatedCell.rect)) {
        throw new Error(
          "all text baselines in one marked content block must be in the same cell",
        );
      }
    }
    return locatedCell;
  }

  /** 标记内容块的阅读顺序键 */
  function blockReadingKey(block) {
    if (block.textItems.length === 0) {
      return [0.0, 0.0];
    }
    var maxY = -Infinity;
    var minX = Infinity;
    for (var i = 0; i < block.textItems.length; i++) {
      var item = block.textItems[i];
      if (item.y > maxY) {
        maxY = item.y;
      }
      if (item.x < minX) {
        minX = item.x;
      }
    }
    return [-maxY, minX];
  }

  for (var b = 0; b < this.contentParser.markedBlocks.length; b++) {
    var block = this.contentParser.markedBlocks[b];
    var cell = locateBlock(block);
    if (cell !== null) {
      cell.marked_blocks.push(block);
    }
  }

  for (var t3 = 0; t3 < tables.length; t3++) {
    var table3 = tables[t3];
    for (var c3 = 0; c3 < table3.cells.length; c3++) {
      var cell3 = table3.cells[c3];
      cell3.marked_blocks.sort(function (a, b) {
        var ka = blockReadingKey(a);
        var kb = blockReadingKey(b);
        return ka[0] - kb[0] || ka[1] - kb[1];
      });
    }
  }

  this._tables = tables;
  return tables;
};

/** 对象流对象：/Type 为 ObjStm 的间接对象 */
function ObjStm(data, id) {
  PDFObj.call(this, data, id);
  assert(this.rawStream !== null, "ObjStm requires a stream");
  assert(this.dict["Type"] === "ObjStm", "Type must be ObjStm");
  this.objstmParser = new ObjStmParser(this.rawStream);
}

ObjStm.prototype = Object.create(PDFObj.prototype);
ObjStm.prototype.constructor = ObjStm;

ObjStm.prototype.getObj = function (id) {
  return this.objstmParser.parseObj(id);
};

/** CMap 对象：/ToUnicode 引用的间接对象 */
function CMapObj(data, id) {
  PDFObj.call(this, data, id);
  assert(this.rawStream !== null, "CMapObj requires a stream");
  this.cmapParser = new CMapParser(this.rawStream);
  this.cmap = this.cmapParser.getCmap();
}

CMapObj.prototype = Object.create(PDFObj.prototype);
CMapObj.prototype.constructor = CMapObj;

/** 交叉引用流对象：/Type 为 XRef 的间接对象 */
function XRefObj(data, id) {
  PDFObj.call(this, data, id);
  assert(this.rawStream !== null, "XRefObj requires a stream");
  assert(this.dict["Type"] === "XRef", "Type must be XRef");

  this.w = this.dict["W"];
  assert(
    Array.isArray(this.w) &&
      this.w.length === 3 &&
      this.w.every(function (v) {
        return Number.isInteger(v);
      }),
    "W must be a 3-element integer array",
  );

  this.stream = inflate(this.rawStream);

  this.xref = this.getXref();
}

XRefObj.prototype = Object.create(PDFObj.prototype);
XRefObj.prototype.constructor = XRefObj;

/**
 * 根据 id 解析偏移量，返回 xref 交叉引用表 obj_id -> [type, num2, num3]：
 * - 类型为 1（普通对象），num2 为对象起始偏移，num3 为生成号
 * - 类型为 2（压缩对象），num2 为所在 ObjStm 对象编号，num3 为索引
 */
XRefObj.prototype.getXref = function () {
  var width = this.w[0] + this.w[1] + this.w[2]; // 每个记录占用的字节数
  var result = new Map();
  var n = Math.floor(this.stream.length / width);
  for (var i = 0; i < n * width; i += width) {
    var objType = readBigEndian(this.stream, i, this.w[0]);
    if (objType === 0) {
      continue;
    } else if (objType === 1 || objType === 2) {
      var num2 = readBigEndian(this.stream, i + this.w[0], this.w[1]);
      var num3 = readBigEndian(
        this.stream,
        i + this.w[0] + this.w[1],
        this.w[2],
      );
      result.set(Math.floor(i / width), [objType, num2, num3]);
    }
  }
  return result;
};

// ======================= PDF 文档类及页面类 =======================

/** 一页 PDF：持有页面对象、内容对象与字体解码映射表 */
function Page(pageIndex, pageObj, contentObj, decodeMap) {
  this.pageIndex = pageIndex;
  this.pageObj = pageObj;
  this.contentObj = contentObj;
  this.decodeMap = decodeMap;

  this.rawTables = null;
  this.tables = null;
}

/** 将标记内容块中的所有文本按字体解码拼接为字符串 */
Page.prototype.decodeText = function (block) {
  var text = "";
  for (var i = 0; i < block.textItems.length; i++) {
    var item = block.textItems[i];
    text += this.decodeMap[item.font](item.text);
  }
  return text;
};

Page.prototype.getTables = function () {
  if (this.tables !== null) {
    return this.tables;
  }

  var rawTables = this.contentObj.getTables();
  var tables = [];
  var self = this;
  for (var ti = 0; ti < rawTables.length; ti++) {
    var rawTable = rawTables[ti];
    var table = {
      total_rows: rawTable.total_rows,
      total_cols: rawTable.total_cols,
    };
    var cells = [];
    for (var ci = 0; ci < rawTable.cells.length; ci++) {
      var rawCell = rawTable.cells[ci];
      cells.push({
        row_start: rawCell.row_start,
        col_start: rawCell.col_start,
        row_span: rawCell.row_span,
        col_span: rawCell.col_span,
        bbox: rawCell.bbox,
        text:
          rawCell.marked_blocks.length > 0
            ? self.decodeText(rawCell.marked_blocks[0])
            : "",
      });
    }
    table.cells = cells;
    tables.push(table);
  }

  this.tables = tables;
  return tables;
};

/**
 * PDF 表格提取器：入口类。
 * 对外接口与 Python 版一致：
 *   new PDFTableExtractor(path_or_bytes)
 *   .metadata       Info 字典（Producer/Creator 等）
 *   .pages          页面列表
 *   .extract_table()                    -> {pageIndex: [table, ...]}
 *   .extract_table(index)               -> [table, ...]
 *   .extract_table(start, end)          -> {start..end-1: [table, ...]}（左闭右开）
 *   .extract_table([index, ...])        -> {pageIndex: [table, ...]}
 */
function PDFTableExtractor(pathOrBytes) {
  if (typeof pathOrBytes === "string") {
    if (
      typeof process !== "undefined" &&
      process.versions &&
      process.versions.node
    ) {
      // Node.js 环境：按路径读取文件
      var fs = require("fs");
      this.data = bytesToLatin1(fs.readFileSync(pathOrBytes));
    } else {
      throw new Error(
        "PDFTableExtractor: a file path is only supported in Node.js; pass bytes (Uint8Array/ArrayBuffer) in the browser",
      );
    }
  } else if (pathOrBytes instanceof Uint8Array) {
    this.data = bytesToLatin1(pathOrBytes);
  } else if (pathOrBytes instanceof ArrayBuffer) {
    this.data = bytesToLatin1(new Uint8Array(pathOrBytes));
  } else {
    throw new Error("PDFTableExtractor: expected a file path or binary bytes");
  }

  this._parser = new DictParser(this.data);

  this._xref = this._getXref(); // 内部会设置 this._xrefObj

  this._objMap = new Map();

  this._catalogObj = this._getObj(this._xrefObj.dict["Root"], "PDFObj");
  this._metadataObj = this._getObj(this._xrefObj.dict["Info"], "PDFObj");

  this.metadata = this._getMetadata();

  this._pagesRoot = this._getObj(this._catalogObj.dict["Pages"], "PDFObj");

  this.pages = this._getPages();
}

PDFTableExtractor.prototype._getXref = function () {
  var pos = this.data.lastIndexOf("startxref");
  assert(pos !== -1, "startxref not found");
  this._parser.pos = pos;
  this._parser.readName(); // 'startxref'
  this._parser.skipWhitespace();

  var startxref = this._parser.readNumber();
  this._parser.pos = startxref;

  var keyword1 = this._parser.readName();
  assert(keyword1 === "xref", "expected 'xref'");
  this._parser.skipWhitespace();

  this._parser.readNumber(); // 子区段起始对象号
  this._parser.skipWhitespace();
  this._parser.readNumber(); // 子区段对象数量
  this._parser.skipWhitespace();

  var keyword2 = this._parser.readName();
  this._parser.skipWhitespace();
  assert(keyword2 === "trailer", "expected 'trailer'");

  var trailerDict = this._parser.parseDict();

  var start = trailerDict["XRefStm"];
  var end = this.data.indexOf("endobj", start) + 6;
  this._xrefObj = new XRefObj(this.data.substring(start, end));

  return this._xrefObj.getXref();
};

/**
 * 获取（并缓存）一个间接对象。
 * id_or_ref: 对象编号，或引用 [obj_id, gen, 'R']
 * type: 'PDFObj' | 'CMapObj' | 'ObjStm' | 'ContentObj'
 */
PDFTableExtractor.prototype._getObj = function (idOrRef, type) {
  var objId;
  if (typeof idOrRef === "number") {
    objId = idOrRef;
  } else if (Array.isArray(idOrRef)) {
    objId = idOrRef[0];
  } else {
    throw new Error("invalid object reference: " + idOrRef);
  }

  if (this._objMap.has(objId)) {
    return this._objMap.get(objId);
  }

  var entry = this._xref.get(objId);
  if (entry === undefined) {
    throw new Error("object " + objId + " not found in xref");
  }

  var obj;
  if (entry[0] === 1) {
    var start = entry[1];
    var end = this.data.indexOf("endobj", start) + 6;
    var slice = this.data.substring(start, end);

    if (type === "PDFObj") {
      obj = new PDFObj(slice);
    } else if (type === "CMapObj") {
      obj = new CMapObj(slice);
    } else if (type === "ObjStm") {
      obj = new ObjStm(slice);
    } else if (type === "ContentObj") {
      obj = new ContentObj(slice);
    } else {
      throw new Error("Unsupported obj type " + type);
    }
    this._objMap.set(obj.id, obj);
  } else if (entry[0] === 2) {
    var parentId = entry[1];
    var parentObj = this._getObj(parentId, "ObjStm");
    obj = parentObj.getObj(objId);
    this._objMap.set(obj.id, obj);
  } else {
    throw new Error("unsupported xref entry type " + entry[0]);
  }

  return obj;
};

/** 从 Info 对象提取文档元数据 */
PDFTableExtractor.prototype._getMetadata = function () {
  var metaData = this._metadataObj.dict;
  var metadata = {};
  for (var key in metaData) {
    if (!Object.prototype.hasOwnProperty.call(metaData, key)) {
      continue;
    }
    var value = metaData[key];
    if (
      (key === "Producer" || key === "Creator") &&
      value.length >= 2 &&
      value.charCodeAt(0) === 0xfe &&
      value.charCodeAt(1) === 0xff
    ) {
      metadata[key] = utf16beDecode(value);
    } else {
      metadata[key] = utf8Decode(value);
    }
  }
  return metadata;
};

/** 构建页面列表：解析每个页面对象的 Contents、Resources/Font，建立解码映射 */
PDFTableExtractor.prototype._getPages = function () {
  var pageList = [];
  var self = this;
  var kids = this._pagesRoot.dict["Kids"];

  for (var index = 0; index < kids.length; index++) {
    var ref = kids[index];
    var pageObjId = ref[0];
    var pageObj = this._getObj(pageObjId, "PDFObj");

    var contentRef = pageObj.dict["Contents"];
    var contentObj = this._getObj(contentRef, "ContentObj");

    var fontRefs = pageObj.dict["Resources"]["Font"];

    var decodeMap = {}; // font_name -> decode callback
    for (var fontName in fontRefs) {
      if (!Object.prototype.hasOwnProperty.call(fontRefs, fontName)) {
        continue;
      }
      var fontRef = fontRefs[fontName];
      var fontObj = this._getObj(fontRef, "PDFObj");
      var encoding = fontObj.dict["Encoding"];
      assert(
        encoding === "WinAnsiEncoding" || encoding === "Identity-H",
        "unsupported font encoding " + encoding,
      );
      assert(
        !Object.prototype.hasOwnProperty.call(fontObj.dict, "Differences"),
        "Differences is not supported",
      );

      if (encoding === "WinAnsiEncoding") {
        decodeMap[fontName] = function (text) {
          return utf8Decode(text);
        };
      } else if (encoding === "Identity-H") {
        var cmapRef = fontObj.dict["ToUnicode"];
        var cmapObj = this._getObj(cmapRef, "CMapObj");
        var cmap = cmapObj.cmap;
        decodeMap[fontName] = (function (cmap) {
          return function (text) {
            // 每 4 个十六进制字符转为一个 CID
            var out = "";
            for (var i = 0; i < text.length; i += 4) {
              out += String.fromCodePoint(
                cmap.get(parseInt(text.substr(i, 4), 16)),
              );
            }
            return out;
          };
        })(cmap);
      }
    }

    pageList.push(new Page(index, pageObj, contentObj, decodeMap));
  }

  return pageList;
};

/**
 * 提取指定页面中的表格。
 * - 无参数: 全部页面 -> {pageIndex: [table, ...]}
 * - 一个整数: 该页 -> [table, ...]
 * - 两个整数: 左闭右开区间 [start, end) -> {pageIndex: [table, ...]}
 * - 一个数组: 指定页面索引列表 -> {pageIndex: [table, ...]}
 *
 * 每个 table 的格式：
 * {
 *   'total_rows': 总(逻辑)行数,
 *   'total_cols': 总(逻辑)列数,
 *   'cells': [{
 *     'row_start': 行起始,
 *     'col_start': 列起始,
 *     'row_span': 行合并数,
 *     'col_span': 列合并数,
 *     'bbox': [x1, y1, x2, y2],
 *     'text': 文本内容
 *   }, ...]
 * }
 */
PDFTableExtractor.prototype.extract_table = function () {
  var indexList;
  var args = Array.prototype.slice.call(arguments);

  if (args.length === 0) {
    indexList = [];
    for (var i = 0; i < this.pages.length; i++) {
      indexList.push(i);
    }
  } else if (args.length === 1) {
    var arg = args[0];
    if (Number.isInteger(arg)) {
      var index = arg;
      if (!(0 <= index && index < this.pages.length)) {
        throw new RangeError("Page index " + index + " out of range");
      }
      return this.pages[index].getTables();
    } else if (Array.isArray(arg)) {
      if (
        !arg.every(function (p) {
          return Number.isInteger(p);
        })
      ) {
        throw new TypeError("List elements must be integers");
      }
      indexList = arg;
    } else {
      throw new TypeError(
        "Unsupported argument type: " +
          (typeof arg === "number" ? "float" : typeof arg),
      );
    }
  } else if (args.length === 2) {
    var start = args[0];
    var end = args[1];
    if (typeof start !== "number" || typeof end !== "number") {
      throw new TypeError("start and end must be integers");
    }
    indexList = sliceRange(this.pages.length, start, end);
  } else {
    throw new TypeError("Expected 0, 1, or 2 arguments");
  }

  // 统一处理页面索引列表
  var tables = {};
  for (var j = 0; j < indexList.length; j++) {
    var i2 = indexList[j];
    if (!(0 <= i2 && i2 < this.pages.length)) {
      throw new RangeError("Page index " + i2 + " out of range");
    }
    tables[i2] = this.pages[i2].getTables();
  }
  return tables;
};

// 与 Python 版一致的 snake_case 接口
PDFTableExtractor.prototype.extractTable =
  PDFTableExtractor.prototype.extract_table;

/**
 * 预解压（浏览器）：解析 xref 并收集 PDF 中全部流对象，
 * 用原生 DecompressionStream 异步并行解压，返回解压缓存。
 *
 * 由于 DecompressionStream 是异步 API，而解析器是同步单遍扫描，
 * 因此采用"先预解压、后同步解析"的两段式：
 * 1. prepareStreams(bytes)  -> 返回 inflate 缓存（原始流 -> 解压结果）
 * 2. setInflateCache(cache) -> 同步构造 PDFTableExtractor 时直接命中缓存
 *
 * 本项目样本中所有带流的对象（XRef / ObjStm / CMap / Contents）都是
 * type-1 普通对象，因此遍历 xref 中全部 type-1 对象即可收集所有流。
 */
PDFTableExtractor.prepareStreams = async function (bytes) {
  var data = bytesToLatin1(bytes);
  var parser = new DictParser(data);

  // 1. startxref -> xref 表 -> trailer -> XRefStm（与 _getXref 相同的解析路径）
  var pos = data.lastIndexOf("startxref");
  assert(pos !== -1, "startxref not found");
  parser.pos = pos;
  parser.readName(); // 'startxref'
  parser.skipWhitespace();
  var startxref = parser.readNumber();
  parser.pos = startxref;
  assert(parser.readName() === "xref", "expected 'xref'");
  parser.skipWhitespace();
  parser.readNumber(); // 子区段起始对象号
  parser.skipWhitespace();
  parser.readNumber(); // 子区段对象数量
  parser.skipWhitespace();
  assert(parser.readName() === "trailer", "expected 'trailer'");
  parser.skipWhitespace();
  var trailerDict = parser.parseDict();
  var xrefStm = trailerDict["XRefStm"];
  var xrefEnd = data.indexOf("endobj", xrefStm) + 6;
  var xrefSlice = data.substring(xrefStm, xrefEnd);

  // 2. 解析 xref 对象（字典 + 原始流），先解压 xref 流以得到交叉引用表
  var xrefObj = new PDFObj(xrefSlice);
  assert(xrefObj.dict["Type"] === "XRef", "Type must be XRef");
  var w = xrefObj.dict["W"];
  assert(
    Array.isArray(w) &&
      w.length === 3 &&
      w.every(function (v) {
        return Number.isInteger(v);
      }),
    "W must be a 3-element integer array",
  );
  var width = w[0] + w[1] + w[2];

  var xrefBytes = await inflateWithDecompressionStream(
    latin1ToBytes(xrefObj.rawStream),
  );
  var xref = new Map(); // obj_id -> [type, num2, num3]
  for (var i = 0; i + width <= xrefBytes.length; i += width) {
    var objType = readBigEndian(xrefBytes, i, w[0]);
    if (objType === 0) {
      continue;
    } else if (objType === 1 || objType === 2) {
      xref.set(Math.floor(i / 7), [
        objType,
        readBigEndian(xrefBytes, i + w[0], w[1]),
        readBigEndian(xrefBytes, i + w[0] + w[1], w[2]),
      ]);
    }
  }

  // 3. 遍历全部 type-1 对象，收集所有带流对象的原始流。
  //    注意不能对每个对象都做完整 PDFObj 解析：部分对象（如字体 Widths 数组、
  //    FontDescriptor 字典）含有本解析器不支持的结构（# 转义名、非 ASCII 名等），
  //    主解析器从不构造它们。这里只按 'stream' / 'endobj' 关键字顺序判断是否为
  //    流对象，并提取原始流字节（与 PDFObj._getStream 的取流逻辑一致）。
  function extractRawStream(slice) {
    var s = slice.indexOf("stream");
    var e = slice.indexOf("endobj");
    if (s === -1 || (e !== -1 && e < s)) {
      return null;
    }
    var p = s + 6; // 'stream' 之后
    while (p < slice.length && WS_CODES.has(slice.charCodeAt(p))) {
      p += 1;
    }
    var es = slice.indexOf("endstream");
    if (es === -1 || es < p) {
      return null;
    }
    return slice.substring(p, es);
  }

  var rawList = [xrefObj.rawStream];
  xref.forEach(function (entry) {
    if (entry[0] !== 1) {
      return;
    }
    var start2 = entry[1];
    var end2 = data.indexOf("endobj", start2) + 6;
    var raw = extractRawStream(data.substring(start2, end2));
    if (raw !== null) {
      rawList.push(raw);
    }
  });
  // 去重（xref 流对象自身也出现在 type-1 条目中）
  rawList = Array.from(new Set(rawList));

  // 4. 异步并行解压全部流
  var cache = new Map();
  await Promise.all(
    rawList.map(function (raw) {
      return inflateWithDecompressionStream(latin1ToBytes(raw)).then(
        function (decoded) {
          cache.set(raw, decoded);
        },
      );
    }),
  );

  return cache;
};

/**
 * 异步工厂（浏览器）：使用原生 DecompressionStream 预解压全部流后构造提取器。
 * 与同步构造函数等价，仅在浏览器（存在 DecompressionStream）时可用。
 */
PDFTableExtractor.create = async function (bytes) {
  var cache = await PDFTableExtractor.prepareStreams(bytes);
  setInflateCache(cache);
  return new PDFTableExtractor(bytes);
};

// ---------------- 导出 ----------------
// 兼容 Node.js（CommonJS）与浏览器（直接作为全局使用）
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PDFTableExtractor: PDFTableExtractor,
    Page: Page,
    PDFObj: PDFObj,
    ContentObj: ContentObj,
    ObjStm: ObjStm,
    CMapObj: CMapObj,
    XRefObj: XRefObj,
    BaseParser: BaseParser,
    DictParser: DictParser,
    ObjStmParser: ObjStmParser,
    CMapParser: CMapParser,
    ContentParser: ContentParser,
    Rect: Rect,
    Line: Line,
    TextItem: TextItem,
    MarkedContentBlock: MarkedContentBlock,
    bytesToLatin1: bytesToLatin1,
    readBigEndian: readBigEndian,
    setInflateCache: setInflateCache,
  };
}
