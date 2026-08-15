from __future__ import annotations
import zlib
from copy import copy
from typing import overload


# 全局变量
TOLERANCE = 0.7      # 用于识别q/Q的裁剪区域与单元格是否一致时的容许误差
MERGE_GAP = 0.05   # 用于清洗表格边框之间的细小间隙
LINE_MIN_SPAN = 5.0       # 黑色网格中识别表格线所需的最小长边
LINE_EDGE_TOLERANCE = 2.0 # 单元格边与逻辑表格线中心的最大对齐误差

# =======================  解析器类  =======================

class BaseParser:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def skip_whitespace(self):
        """跳过空白字符"""
        while self.pos < len(self.data) and self.data[self.pos] in b' \t\n\r\f':
            self.pos += 1

    def _to_number(self, b: bytes):
        """将数字字节串转为 float 对象"""
        if b'.' in b:
            return float(b)
        return int(b)

    def read_number(self) -> int | float:
        """扫描一个数字字节串, 可能包含符号和小数点"""
        start = self.pos
        if self.pos < len(self.data) and self.data[self.pos] in b'+-':
            self.pos += 1
        while self.pos < len(self.data) and self.data[self.pos] in b'0123456789.':
            self.pos += 1
        return self._to_number(self.data[start:self.pos])

    def read_hexstr(self):
        """
        读取 <hex> 十六进制字符串, 见于 /ID[<......>], [<...>] TJ 指令中
        返回内部 bytes
        """
        assert self.data[self.pos] == ord('<')
        self.pos += 1
        start = self.pos
        while self.pos < len(self.data) and self.data[self.pos] != ord('>'):
            self.pos += 1
        inner = self.data[start:self.pos]
        if self.pos < len(self.data):
            self.pos += 1  # 跳过 '>'
        return inner

    def read_string(self) -> bytes :
        r"""
        读出括号内的内容, 带有转移字符的处理, 应用场景为
        1. 指令 /Lang, /Author, /CreationDate 等等的值
        2. 内容流中的 TJ 指令的文本内容, 例如 [(\\(5)] 中提取出 b'(5'
        """
        assert self.data[self.pos] == ord('(')
        self.pos += 1

        result = bytearray()
        while self.pos < len(self.data):
            ch = self.data[self.pos]
            if ch == ord('\\'):
                # 转义字符情形, 读取下一个被转义的内容
                self.pos += 1
                assert self.data[self.pos] in b'\\()'  
                # 似乎没有除了这些之外的情形
                # 注意: 标准中似乎允许使用 [(ab(cd))] TJ 直接输出 ab(cd) , 但是没有观察到这种情况

                result.append(self.data[self.pos])
            elif ch == ord('('):
                raise ValueError(f"Unexpected '(', it was supported to be '\\(', at pos={self.pos}")
            elif ch == ord(')'):
                break
            else:
                result.append(ch)

            self.pos += 1

        assert self.data[self.pos] == ord(')')
        self.pos += 1
        return bytes(result)

    def read_name(self) -> bytes:
        """
        读取指令或者操作符, 主要应用场景:
        1. 用于读取 /Name, 返回 Name 的 bytes 对象, 兼具读取 /Name/Value 中 Value 的功能
        2. 用于读取内容流中的单个指令, 如 re , begincmap
        """
        if self.data[self.pos] == ord('/'):
            # /Name 的情形
            self.pos += 1
        start = self.pos 

        # 名称结束符：空白、分隔符
        self.pos += 1
        while self.pos < len(self.data) and self.data[self.pos] not in b' \t\n\r\f()<>[]{}/%':
            self.pos += 1
        return self.data[start:self.pos]


class DictParser(BaseParser):
    """
    解析字典 <<...>>, 使用于
    1. pdf 的 Obj 的头部中的 <<...>>
    2. 结构树节点, 其本身就是一个 <<...>>
    3. 内容流的 /P <<...>> BDC...EMC 中的 <<...>>
    """
    def __init__(self, data):
        super().__init__(data)



    def parse_number_or_ref(self):
        """
        根据周边位置判断解析策略, 解析出数字或引用 (a b R)\n
        如果为单个数字则解析数字, 例如b' 1196 /'则解析出 1196\n
        如果为 1 0 R 的模式则解析出元组(1,0,'R')\n
        解析完成后自动移动光标位置 
        """
        assert self.data[self.pos] in b'0123456789'
        a = self.read_number()
        saved_pos = self.pos
        self.skip_whitespace()
        # 尝试匹配引用：第二个数字 + R
        if self.pos < len(self.data) and self.data[self.pos] in b'+-.0123456789':
            b = self.read_number()
            self.skip_whitespace()
            if self.pos < len(self.data) and self.data[self.pos] == ord('R'):
                # R 后面应当是空白或换行符或者列表结束
                assert self.data[self.pos + 1] in b' \t\n\r\f/>]'
                self.pos += 1  # 跳过 R
                    
                return (a, b, 'R')
        # 不是引用，退回
        self.pos = saved_pos
        return a

    def parse_array(self):
        """
        解析数组[......], 根据内容返回数字、元组、列表或原始 bytes\n
        包括以下几种类型的数组
        1. (0,0,800,400), 见于 /MediaBox 这样的恰有四个数的指令中
        2. [(1,0,'R'),(4,0,'R')], 见于 /Kids 这样的指令中
        3. 4, 见于 /K 指令中
        4. [b'1234',b'5678'], 见于 ID 指令, bfrange 等位置中
        """
        assert self.data[self.pos] == ord('[')
        self.pos += 1  # 跳过 '['
        
        # 找到 '[]' 的起点和终点
        start = self.pos
        end = self.data.find(b']',start)

        # 解析内部元素
        elements = []

        while self.pos < end:
            self.skip_whitespace()
            if self.pos >= end:
                break
            elements.append(self.parse_value())

        if self.data[self.pos] == ord(']'):
            self.pos += 1

        # 根据规则判断返回形式
        def is_number(v): return isinstance(v, float)
        def is_ref(v): return isinstance(v, tuple) and len(v) == 3 and v[2] == 'R'

        if len(elements) == 1 and is_number(elements[0]):
            return elements[0]
        if len(elements) == 4 and all(is_number(e) for e in elements):
            return tuple(elements)
        if elements and all(is_ref(e) for e in elements):
            return elements
        # 其他情况：原样返回内部 bytes
        return elements

    def parse_value(self):
        """
        读取一个值，返回 (值, 类型取决于内容) 并将 pos 移动到值结束之后\n
        处理以下情形
        1. '/'开头的值: /Name /Value 中的 Value
        2. 单个数字: 如 /Length 1109 中的1109,
        3. 对象引用: 如 /F1 1 0 R 这样的指令
        4. bool 值: 见于 /Marked 等指令中
        5. (...)中的内容, 见于 /Author 等指令
        6. [...]中的内容, 见于 /Kids 等指令
        7. <...>中的内容, 如 /ID 指令的[<...><...>]
        8. <<...>>中的内容(子字典), 见于 /Resources 等指令
        """
        self.skip_whitespace()
        if self.pos >= len(self.data):
            return None
        
        ch = self.data[self.pos]
        if ch == ord('/'):
            return self.read_name()
        elif ch == ord('('):
            return self.read_string()
        elif ch == ord('['):
            parsed_array =  self.parse_array()

            return parsed_array
        elif ch == ord('<'):
            if self.pos + 1 < len(self.data) and self.data[self.pos + 1] == ord('<'):
                # 嵌套字典 <<...>>
                return self.parse_dict()
            else:
                # 十六进制字符串
                return self.read_hexstr()
        elif ch == ord('t'):
            if self.data[self.pos:self.pos + 4] == b'true':
                self.pos += 4
                return True
            raise ValueError("Expected 'true'")
        elif ch == ord('f'):
            if self.data[self.pos:self.pos + 5] == b'false':
                self.pos += 5
                return False
            raise ValueError("Expected 'false'")
        elif ch in b'+-.0123456789':
            return self.parse_number_or_ref()
        else:
            raise ValueError(f"Unexpected byte {chr(ch)!r} at position {self.pos}")

    def parse_dict(self):
        """ 解析 <<...>> 字典，返回 dict, pos 应指向 '<<' """
        assert self.data[self.pos:self.pos + 2] == b'<<'
        self.pos += 2
        result = {}
        while True:
            self.skip_whitespace()
            if self.pos >= len(self.data):
                break
            if self.data[self.pos:self.pos + 2] == b'>>':
                self.pos += 2
                break
            # 键必须是名称
            if self.data[self.pos] != ord('/'):
                raise ValueError("Expected '/' for key")
            key = self.read_name()
            self.skip_whitespace()
            value = self.parse_value()
            result[key] = value
        return result        

class ObjStmParser(BaseParser):
    r"""解析 /Type 为 /ObjStm 的内容流"""
    def  __init__(self, raw_data: bytes = bytes(), data: bytes = bytes()):
        """
        :param raw_data: 未被解压的内容流二进制数据
        :param data: 已经解压的内容流二进制数据
        """
        if raw_data:
            self.raw_data = raw_data
            decoded_data = zlib.decompress(self.raw_data)
            super().__init__(decoded_data)
        elif data:
            super().__init__(data)
        else:
            raise ValueError("ObjStmParser requires at least one argument, raw_data or data.")

        self.offset_map = self.get_offset_map()   # obj_id -> (start, end)
        self.obj_map: dict[int, PDFObj] = {}

    def get_offset_map(self) -> dict[int, tuple[int, int]]:
        """解析偏移表，返回 {obj_id: (start, end)}，区间为 self.data 的索引范围"""
        self.pos = 0
        pairs = []
        # 读取所有 (对象编号, 偏移量) 对，直到遇到非数字内容
        while True:
            self.skip_whitespace()
            if self.pos >= len(self.data) or self.data[self.pos] not in b'0123456789':
                break
            obj_id = self.read_number()
            self.skip_whitespace()
            offset = self.read_number()
            pairs.append((obj_id, offset))

        # 对象数据开始的基础位置
        self.skip_whitespace()
        base = self.pos

        # 按偏移量排序，确保顺序处理
        pairs.sort(key=lambda x: x[1])

        offset_map = {}
        for i, (obj_id, offset) in enumerate(pairs):
            start = base + offset
            # 下一个对象的起始位置即当前对象的结束位置，最后一个对象到数据末尾
            if i + 1 < len(pairs):
                end = base + pairs[i+1][1]
            else:
                end = len(self.data)
            offset_map[obj_id] = (start, end)
        return offset_map

    def parse_obj(self, id: int) -> PDFObj | None:
        """按需解析并缓存单个对象，返回 PDFObj 或 None"""
        if id in self.obj_map:
            return self.obj_map[id]
        if id not in self.offset_map:
            return None
        start, end = self.offset_map[id]
        obj_bytes = self.data[start:end]
        obj = PDFObj(obj_bytes, id)
        self.obj_map[id] = obj
        return obj

    def parse(self) -> dict[int, PDFObj]:
        """解析全部对象并缓存，返回 {obj_id: PDFObj} 字典"""
        for obj_id in self.offset_map:
            self.parse_obj(obj_id)
        return self.obj_map


class CMapParser(DictParser):
    """解析CMap流对象的内容流"""
    def __init__(self, raw_data: bytes = bytes(), data: bytes = bytes()):
        """
        :param raw_data: 未被解压的内容流二进制数据
        :param data: 已经解压的内容流二进制数据
        """
        if raw_data:
            self.raw_data = raw_data
            decoded_data = zlib.decompress(self.raw_data)
            super().__init__(decoded_data)
        elif data:
            super().__init__(data)
        else:
            raise ValueError("ContentParser requires at least one argument, raw_data or data.")
        self._cmap: dict[int, int] | None = None
        self._info: dict = {}

    def parse_codespacerange(self, n: int):
        """解析 begincodespacerange...endcodespacerange, 断言编码空间为 0000~FFFF"""
        for _ in range(n):
            self.skip_whitespace()
            start = self.read_hexstr()
            self.skip_whitespace()
            end = self.read_hexstr()
            assert start == b'0000' and end == b'FFFF'
        self.skip_whitespace()
        w = self.read_name()
        assert w == b'endcodespacerange'

    def parse_bfchar(self, cmap: dict[int, int], n: int):
        """解析 beginbfchar...endbfchar, 将 n 对映射加入 cmap"""
        for _ in range(n):
            self.skip_whitespace()
            src = self.read_hexstr()
            self.skip_whitespace()
            dst = self.read_hexstr()
            cmap[int(src, 16)] = int(dst, 16)
        self.skip_whitespace()
        w = self.read_name()
        assert w == b'endbfchar'

    def parse_bfrange(self, cmap: dict[int, int], n: int):
        """解析 beginbfrange...endbfrange, 将 n 个范围的映射加入 cmap"""
        for _ in range(n):
            self.skip_whitespace()
            src_start = self.read_hexstr()
            self.skip_whitespace()
            src_end = self.read_hexstr()
            self.skip_whitespace()

            s = int(src_start, 16)
            e = int(src_end, 16)
            if self.data[self.pos] == ord('<'):
                dst_start = self.read_hexstr()
                d = int(dst_start, 16)
                for i in range(e - s + 1):
                    cmap[s + i] = d + i
            elif self.data[self.pos] == ord('['):
                dst_list = self.parse_array()
                d = [int(j,16) for j in dst_list]
                for i in range(e - s + 1):
                    cmap[s + i] = d[i]
        self.skip_whitespace()
        w = self.read_name()
        assert w == b'endbfrange'

    def get_cmap(self) -> dict[int, int]:
        """返回 CMap 映射表, int->int 字典，结果会被缓存"""
        if self._cmap is not None:
            return copy(self._cmap)

        self.pos = 0
        cmap: dict[int, int] = {}

        while self.pos < len(self.data):
            self.skip_whitespace()
            if self.pos >= len(self.data):
                break

            ch = self.data[self.pos]

            if ch == ord('/'):
                name = self.read_name()
                if name == b'CIDSystemInfo':
                    self.skip_whitespace()
                    info = self.parse_dict()
                    self._info = info
                    assert info.get(b'Ordering') == b'UCS'
                elif name == b'CMapType':
                    self.skip_whitespace()
                    val = self.read_number()
                    assert val == 2
                elif name == b'CMapName':
                    self.skip_whitespace()
                    cmap_name = self.read_name()
                    assert cmap_name == b'Adobe-Identity-UCS'
            elif ch in b'0123456789':
                n = self.read_number()
                self.skip_whitespace()
                w = self.read_name()
                if w == b'beginbfchar':
                    self.parse_bfchar(cmap, n)
                elif w == b'beginbfrange':
                    self.parse_bfrange(cmap, n)
                elif w == b'begincodespacerange':
                    self.parse_codespacerange(n)
                # 其他如 'dict' 直接忽略，后续 'begin' 由外层循环作为普通单词跳过
            else:
                w = self.read_name()
                if w == b'endcmap':
                    break
                # 其他单词如 begin, def, findresource, pop 等直接忽略

        self._cmap = cmap
        return cmap


class ContentParser(DictParser):
    """解析页面内容流对象的内容流"""
    def __init__(self, raw_data: bytes = bytes(), data: bytes = bytes()):
        """
        :param raw_data: 未被解压的内容流二进制数据
        :param data: 已经解压的内容流二进制数据
        """
        if raw_data:
            self.raw_data = raw_data
            decoded_data = zlib.decompress(self.raw_data)
            super().__init__(decoded_data)
        elif data:
            super().__init__(data)
        else:
            raise ValueError("ContentParser requires at least one argument, raw_data or data.")

    def parse(self):
        """遍历整个内容流一次, 提取绘制指令与标记内容块

        解析结果保存在:
        - self.rects: 使用 f* 填充的矩形列表, 将计算出指令中裁剪后的结果
        - self.lines: 使用 m l S 画出的线列表(保存时附带当时的裁剪区域)
        - self.marked_blocks: /P <<...>> BDC...EMC 标记内容块列表
        """
        self.pos = 0
        self.rects: list[Rect] = []
        self.lines: list[Line] = []
        self.marked_blocks: list[MarkedContentBlock] = []

        # q/Q 与 BDC/EMC 各自成对、可以互相交错(如 q...BDC...Q...EMC),
        # 因此分别使用图形状态栈与标记内容栈进行管理
        self._gs_stack: list[_Scope] = []
        self._mc_stack: list[_Scope] = []
        self._clip: Rect | None = None
        self._line_width = None
        self._cap_style = 0
        self._join_style = 0
        self._fill_color = None
        self._stroke_color = None

        # 待完成的路径
        self._pending_rect: Rect | None = None
        self._pending_line_start: tuple[float, float] | None = None
        self._pending_line: Line | None = None

        # 文本状态
        self._font: bytes | None = None
        # 文本对象栈: BT 压入新帧, ET 弹出。帧内保存 Tm 设置的基线坐标,
        # BT 时重置为 None(文本矩阵为单位矩阵), 因此 Tm 只在当前 BT...ET 内有效
        self._text_stack: list[tuple[float, float] | None] = []
        self._active_mc_block: MarkedContentBlock | None = None

        operands = []
        while self.pos < len(self.data):
            self.skip_whitespace()
            if self.pos >= len(self.data):
                break

            ch = self.data[self.pos]
            if ch in b'+-.0123456789':
                # 数字: 指令的操作数先入栈, 读到运算符再出栈
                operands.append(self.read_number())
            elif ch == ord('/'):
                # 名称: 可能是 /P /Artifact, 也可能是 Tf 的字体名等操作数
                operands.append(self.read_name())
            elif ch == ord('('):
                operands.append((self.read_string(), b'()'))
            elif ch == ord('<'):
                if self.data[self.pos:self.pos + 2] == b'<<':
                    operands.append(self.parse_dict())
                else:
                    operands.append((self.read_hexstr(), b'<>'))
            elif ch == ord('['):
                operands.append(self.read_text_array())
            else:
                op = self.read_name()
                self._execute(op, operands)

    def read_text_array(self) -> list:
        """
        解析 TJ 指令的数组, 以列表形式返回结果, 列表中元素格式为: 
        1. 以元组 (b'...',b'()') 表示此为 TJ 指令值中的()中的内容
        2. 以元组 (b'...',b'<>') 表示此为 TJ 指令值中的<>中的内容
        3. 以数字表示此为 TJ 指令值中的<>中的间距调整值. 

        示例 
        1. b'[(2025-)18(2026)]' 解析出 [ (b'2025-',b'()') , 18 , (b'2026',b'()')] \n
        2. b'[<119C14AA>]' 解析出 [(b'119C14AA',b'<>')]
        """
        assert self.data[self.pos] == ord('[')
        self.pos += 1
        elements = []
        while True:
            self.skip_whitespace()
            if self.pos >= len(self.data):
                break
            ch = self.data[self.pos]
            if ch == ord(']'):
                self.pos += 1
                break
            elif ch == ord('('):
                elements.append((self.read_string(), b'()'))
            elif ch == ord('<'):
                elements.append((self.read_hexstr(), b'<>'))
            elif ch in b'+-.0123456789':
                elements.append(self.read_number())
            else:
                raise ValueError(f"Unexpected byte {chr(ch)!r} in TJ array at pos={self.pos}")
        return elements

    def _ignoring(self) -> bool:
        """当前是否位于被忽略的构件(如 /Artifact BMC...EMC)内部"""
        return any(frame.kind == 'ignore' for frame in self._mc_stack)

    def _nearest_mc_block(self) -> MarkedContentBlock | None:
        """返回仍在解析中的最内层 BDC 标记内容块, 没有则返回 None"""
        for frame in reversed(self._mc_stack):
            if frame.kind == 'BDC' and frame.block is not None:
                return frame.block
        return None

    def _execute(self, op: bytes, operands: list):
        """执行内容流运算符, 操作数已按出现顺序压入 operands 栈"""
        ignoring = self._ignoring()

        if op == b'q':
            if ignoring:
                return
            self._gs_stack.append(_Scope('q', clip=self._clip,
                                         line_width=self._line_width,
                                         cap_style=self._cap_style,
                                         join_style=self._join_style,
                                         fill_color=self._fill_color,
                                         stroke_color=self._stroke_color,
                                         font=self._font))
        elif op == b'Q':
            if ignoring:
                return
            frame = self._gs_stack.pop()
            assert frame.kind == 'q'
            self._clip = frame.clip
            self._line_width = frame.line_width
            self._cap_style = frame.cap_style
            self._join_style = frame.join_style
            self._fill_color = frame.fill_color
            self._stroke_color = frame.stroke_color
            self._font = frame.font

        elif op == b'BMC':
            operands.pop()      # /Artifact 等构件名称, 忽略
            self._mc_stack.append(_Scope('ignore'))

        elif op == b'BDC':
            props = operands.pop()
            name = operands.pop()
            assert name in (b'P',b'Span')
            block = None
            if not self._ignoring():
                block = MarkedContentBlock(mark_type=name, mcid=props.get(b'MCID'))
                self._active_mc_block = block
            self._mc_stack.append(_Scope('BDC', block=block))

        elif op == b'EMC':
            frame = self._mc_stack.pop()
            assert frame.kind in ('BDC', 'ignore')
            if frame.kind == 'BDC' and frame.block is not None:
                self.marked_blocks.append(frame.block)
            self._active_mc_block = self._nearest_mc_block()

        elif op == b'BT':
            if ignoring:
                return
            block = self._active_mc_block

            # 新文本对象: 文本矩阵/文本行矩阵重置为单位矩阵
            self._text_stack.append(None)

        elif op == b'ET':
            if ignoring:
                return
            assert self._text_stack
            self._text_stack.pop()

        elif op == b'Tf':
            size = operands.pop()
            font = operands.pop()
            if ignoring:
                return
            self._font = font

        elif op == b'Tm':
            f_ = operands.pop()
            e_ = operands.pop()
            d_ = operands.pop()
            c_ = operands.pop()
            b_ = operands.pop()
            a_ = operands.pop()
            assert (a_, b_, c_, d_) == (1, 0, 0, 1)
            if ignoring:
                return
            assert self._text_stack
            self._text_stack[-1] = (e_, f_)

        elif op == b'TJ':
            elements = operands.pop()
            if ignoring:
                return
            
            assert self._text_stack
            baseline = self._text_stack[-1]
            assert baseline is not None
            x, y = baseline

            block = self._active_mc_block
            assert block is not None

            # 连续同源段将合并为一个 TextItem
            groups: list[tuple[bytes, list[bytes]]] = []
            # groups 中单个元素的格式为 元组(来源 , 内容)
            # 例如 ( b'2025-', b'()' ) 或者 ( b'119C103A', b'<>')
            for element in elements:
                if not isinstance(element, tuple):
                    # 为字距调整数字, 不需要
                    continue    
                data, source = element
                if groups and groups[-1][0] == source:
                    # 按相同进行合并
                    # 即同为b'()'类型或者同为b'<>'类型则直接合并
                    groups[-1][1].append(data)
                else:
                    groups.append((source, [data]))

            # 翻译成对应的 TextItem 类
            for source, parts in groups:
                block.text_items.append(TextItem(self._font, x, y,
                                                 b''.join(parts), parts, source, 
                                                 self._clip))

        elif op == b'Tj':
            data, source = operands.pop()
            if ignoring:
                return
            assert self._text_stack
            baseline = self._text_stack[-1]
            assert baseline is not None
            x, y = baseline
            block = self._active_mc_block
            assert block is not None
            block.text_items.append(TextItem(self._font, x, y, data, [data], source, 
                                             self._clip))

        elif op == b'Tc':
            operands.pop()
        elif op == b'Tr':
            operands.pop()

        elif op == b're':
            height = operands.pop()
            width = operands.pop()
            y = operands.pop()
            x = operands.pop()
            if not ignoring:
                self._pending_rect = Rect(x, y, width, height)

        elif op == b'W*':
            if ignoring:
                return
            assert self._pending_rect is not None
            clip = self._pending_rect
            if self._clip is None:
                self._clip = clip
            else:
                # 嵌套裁剪: 新裁剪区域与已有裁剪区域求交
                self._clip = Rect(self._clip.x1, self._clip.y1,
                                  self._clip.x2 - self._clip.x1,
                                  self._clip.y2 - self._clip.y1, clip)
            self._pending_rect = None

        elif op == b'n':
            if not ignoring:
                self._pending_rect = None
                self._pending_line = None

        elif op == b'f*':
            if ignoring:
                return
            assert self._pending_rect is not None
            pending = self._pending_rect
            rect = Rect(pending.x1, pending.y1,
                        pending.x2 - pending.x1, pending.y2 - pending.y1,
                        clip=self._clip, fill_color=self._fill_color)
            self.rects.append(rect)
            self._pending_rect = None

        elif op == b'm':
            y = operands.pop()
            x = operands.pop()
            if not ignoring:
                self._pending_line_start = (x, y)
                self._pending_line = None

        elif op == b'l':
            y2 = operands.pop()
            x2 = operands.pop()
            if not ignoring:
                assert self._pending_line_start is not None
                x1, y1 = self._pending_line_start
                self._pending_line = Line((x1, y1), (x2, y2),
                                          width=self._line_width,
                                          cap_style=self._cap_style,
                                          join_style=self._join_style,
                                          clip=self._clip,
                                          stroke_color=self._stroke_color)
                self._pending_line_start = None

        elif op == b'S':
            if ignoring:
                return
            assert self._pending_line is not None
            line = self._pending_line
            self.lines.append(line)
            self._pending_line = None

        elif op == b'w':
            value = operands.pop()
            if not ignoring:
                self._line_width = value
        elif op == b'J':
            value = operands.pop()
            if not ignoring:
                self._cap_style = value
        elif op == b'j':
            value = operands.pop()
            if not ignoring:
                self._join_style = value
        elif op == b'g':
            value = operands.pop()
            if not ignoring:
                self._fill_color = value
        elif op == b'G':
            value = operands.pop()
            if not ignoring:
                self._stroke_color = value
        elif op == b'rg':
            blue = operands.pop()
            green = operands.pop()
            red = operands.pop()
            if not ignoring:
                self._fill_color = (red, green, blue)
        elif op == b'RG':
            blue = operands.pop()
            green = operands.pop()
            red = operands.pop()
            if not ignoring:
                self._stroke_color = (red, green, blue)

        else:
            # 未出现的其它指令按设计原则无需处理, 直接忽略
            pass


# =======================  辅助类  =======================
class Line:
    @overload
    def __init__(self, x1: float, y1: float, x2: float, y2: float,
                  width: float, cap_style: int = 2, join_style: int = 1,
                  clip: Rect | None = None, stroke_color=None): ...

    @overload
    def __init__(self, p1: tuple[float, float], p2: tuple[float, float], 
                  width: float, cap_style: int = 2, join_style: int = 1,
                  clip: Rect | None = None, stroke_color=None): ...

    def __init__(self, *args, width: float, cap_style: int = 2, join_style: int = 1,
                 clip: Rect | None = None, stroke_color=None):
        if len(args) == 4:  # (x1, y1, x2, y2)
            self.x1, self.y1, self.x2, self.y2 = args
        elif len(args) == 2:  # ((x1,y1), (x2,y2))
            (self.x1, self.y1), (self.x2, self.y2) = args
        else:
            raise TypeError(f"Line() takes 2 or 4 positional arguments, but {len(args)} were given")
        
        self.width = width
        self.cap_style = cap_style
        self.join_style = join_style
        self.clip = clip    # 构造时输入的 W* 裁剪矩形, rect() 使用它计算实际占据区域
        self.stroke_color = stroke_color    # 描边色: G 的灰度值 / RG 的 (r,g,b), None 表示默认(黑)

    def rect(self) -> Rect:
        """返回该线所占据的矩形区域, 不是水平或竖直线, 或者 J 指令为 1 时报错

        构造 Line 时传入 clip(内容流 W* 指令建立的裁剪区域)的话,
        将按照裁剪区域计算实际占据区域
        """
        # 检查 cap_style 是否为 1(圆头)
        if self.cap_style == 1:
            raise ValueError("cap_style 1 (round cap) is not supported for rect() because the occupied area is not rectangular")

        half = self.width / 2

        # 竖直线：x1 == x2
        if self.x1 == self.x2:
            y_min = min(self.y1, self.y2)
            y_max = max(self.y1, self.y2)
            x_left = self.x1 - half
            x_right = self.x1 + half

            if self.cap_style == 2:   # square cap: extend along y direction
                y_min -= half
                y_max += half
            return Rect(x_left, y_min, self.width, y_max - y_min, self.clip)
        # 水平线：y1 == y2
        elif self.y1 == self.y2:
            x_min = min(self.x1, self.x2)
            x_max = max(self.x1, self.x2)
            y_top = self.y1 - half
            y_bottom = self.y1 + half

            if self.cap_style == 2:   # square cap: extend along x direction
                x_min -= half
                x_max += half
            return Rect(x_min, y_top, x_max - x_min, self.width, self.clip)
        else:
            raise ValueError("Line is neither horizontal nor vertical; cannot compute a rectangular bounding box")

class Rect:
    """用于代表表格中的单元格/W*裁剪区域/re填充矩形占据区域"""
    def __init__(self, x: float, y: float, width: float, height: float,
                 clip: "Rect | None" = None, fill_color=None):
        if clip is None:
            self.x1 = x
            self.y1 = y
            self.x2 = self.x1 + width
            self.y2 = self.y1 + height
        else:
            # 输入裁剪区域时, 按裁剪区域计算实际占据区域(与原区域求交)
            self.x1 = max(x, clip.x1)
            self.y1 = max(y, clip.y1)
            self.x2 = min(x + width, clip.x2)
            self.y2 = min(y + height, clip.y2)
            assert self.x1 <= self.x2 and self.y1 <= self.y2, \
                f"矩形 ({x}, {y}, {width}, {height}) 与裁剪区域无交集"
        self.fill_color = fill_color    # 填充色: g 的灰度值 / rg 的 (r,g,b), None 表示默认(黑)

    def __contains__(self, item: tuple[int,int] | Rect):
        if isinstance(item, tuple):
            x, y = item
            return (self.x1 <= x <= self.x2) and (self.y1 <= y <= self.y2)
        elif isinstance(item, Rect):
            return ((self.x1 - TOLERANCE <= item.x1) and (item.x2 <= self.x2 + TOLERANCE) 
                    and (self.y1 - TOLERANCE <= item.y1) and (item.y2 <= self.y2 + TOLERANCE))

    def __eq__(self, value):
        if not isinstance(value, Rect):
            return False
        else:
            return ((abs(value.x1 - self.x1) <= TOLERANCE) 
                    and (abs(value.x2 - self.x2) <= TOLERANCE) 
                    and (abs(value.y1 - self.y1) <= TOLERANCE) 
                    and (abs(value.y2 - self.y2) <= TOLERANCE))

    def __str__(self):
        return f'Rect: x1={self.x1}, x2={self.x2}, y1={self.y1}, y2={self.y2}, fill_color={self.fill_color}'

    def __repr__(self):
        return f'Rect: x1={self.x1}, x2={self.x2}, y1={self.y1}, y2={self.y2}, fill_color={self.fill_color}'


class _Scope:
    """解析过程中的作用域帧

    kind:
        'q'      -- q...Q 图形状态作用域, 保存/恢复裁剪区域与线宽等状态
        'BDC'    -- /P <<...>> BDC...EMC 标记内容块, block 保存解析结果
        'ignore' -- BMC...EMC(/Artifact 等)被整体忽略的构件

    q/Q 帧放入图形状态栈, BDC/BMC 帧放入标记内容栈, 两类栈相互独立,
    以支持 q...BDC...Q...EMC 这样的交错结构。
    """
    __slots__ = ('kind', 'clip', 'line_width', 'cap_style', 'join_style',
                 'fill_color', 'stroke_color', 'font', 'block')

    def __init__(self, kind: str, clip=None, line_width=None, cap_style=None,
                 join_style=None, fill_color=None, stroke_color=None,
                 font=None, block=None):
        self.kind = kind
        self.clip = clip
        self.line_width = line_width
        self.cap_style = cap_style
        self.join_style = join_style
        self.fill_color = fill_color
        self.stroke_color = stroke_color
        self.font = font
        self.block = block


class TextItem:
    """一个 Tm + TJ/Tj 对应的文本片段"""
    def __init__(self, font: bytes | None, x: float, y: float, text: bytes,
                 parts: list[bytes], source: bytes, 
                 clip: Rect):
        """
        :param font: 字体名
        :param x:    基线坐标x
        :param y:    基线坐标y
        :param text: 已经拼合的文字内容
        :param: parts: 尚未拼合的文字内容
        :param source: 来源信息, 值为b'()'或 b'<>'
        """
        self.font = font      # 当前字体名, 如 b'F1', 未设置 Tf 时为 None
        self.x = x            # Tm 基线坐标
        self.y = y
        self.text = text      # 文字内容
        self.parts = parts    # 每个TJ/Tj指令的值, 或者说尚未进行拼合的具体内容
        self.source = source  # 来源信息, 为 b'()' 或 b'<>'

        self.clip = clip      # 裁剪矩形

    def __str__(self):
        return f'text: font={self.font}, base_line=({self.x},{self.y}), text={self.text}, source={self.source}, clip={self.clip}'

    def __repr__(self):
        return f'text: font={self.font}, base_line=({self.x},{self.y}), text={self.text}, source={self.source}, clip={self.clip}'

class MarkedContentBlock:
    """代表一个 /P <<...>> BDC...EMC 或 /Span <<...>> BDC...EMC 标记内容块"""
    def __init__(self, mark_type: bytes , mcid=None):
        self.mark_type = mark_type               # 进入 BDC 时的裁剪区域
        self.mcid = mcid                    # /MCID 值, 未给出时为 None
        self.text_items: list[TextItem] = []

    def __str__(self):
        return f'MarkedContentBlock: mcid={self.mcid},type={self.mark_type}, text_items={self.text_items}'

    def __repr__(self):
        return f'MarkedContentBlock: mcid={self.mcid},type={self.mark_type}, text_items={self.text_items}'

# =======================  pdf 对象类  =======================

class PDFObj:
    def __init__(self, data: bytes, id: int = None):
        self.data = data
        self.parser = DictParser(data)
        self.id = id if id is not None else self._get_id()
        self.dict = self._get_dict()

        self.raw_stream = self._get_stream()
        

    def _get_id(self) -> int:
        self.parser.skip_whitespace()
        id = self.parser.read_number()

        self.parser.skip_whitespace()
        gen_number = self.parser.read_number()
        assert gen_number == 0

        self.parser.skip_whitespace()
        keyword = self.parser.read_name()
        assert keyword == b'obj'

        return id

    def _get_dict(self) -> dict:
        self.parser.skip_whitespace()
        return self.parser.parse_dict()

    def _get_stream(self) -> bytes | None:
        self.parser.skip_whitespace()
        if self.parser.pos >= len(self.data)-1:
            # 没有内容流的情形
            return 
        keyword = self.parser.read_name()

        if keyword == b'endobj':
            return
        elif keyword == b'stream':
            self.parser.skip_whitespace()
            start = self.parser.pos
            end = self.data.find(b'endstream')
            return self.data[start:end]
        else:
            raise ValueError(f"Unexpect keyword {keyword} in obj{self.id}")
        


class ContentObj(PDFObj):
    def __init__(self, data, id = None):
        super().__init__(data, id)
        assert self.raw_stream is not None
        self.content_parser = ContentParser(self.raw_stream)
        self.content_parser.parse()

        self._cells: list[dict] = None

        self._tables: list[dict] = None

    def get_cells(self) -> list[dict]:
        """
        从content_parser中解析出的lines和rects重建表格
        重建逻辑
        1. 预处理, 丢弃非纯黑色的矩形或线条
        2. 将纯黑色网格单元按四连通分组, 每个黑色连通分量视为一个表格
        3. 在每个黑色连通分量内部以黑色作为“墙”切割出单元格
        4. 从黑色网格中识别横竖表格线, 建立逻辑行列
        5. 将每个单元格映射到逻辑行列, 得到 row_start/col_start/row_span/col_span
        """

        if self._cells is not None:
            return self._cells

        def _is_pure_black(color) -> bool:
            """
            预处理函数: 用于判断填充/描边色是否为纯黑
            g/G 指令记录单个灰度值, rg/RG 指令记录 (r,g,b) 元组;
            None 表示该指令未出现, 按 PDF 规范图形状态默认填充/描边色为黑色。
            """
            if color is None:
                return True
            if isinstance(color, tuple):
                return all(c == 0 for c in color)
            return color == 0 

        black_rects = [r for r in self.content_parser.rects 
                           if _is_pure_black(r.fill_color)]
        black_rects.extend(ln.rect() for ln in self.content_parser.lines
                           if _is_pure_black(ln.stroke_color))
        if not black_rects:
            return []
        # 网格边界: 所有黑色矩形在 x/y 方向的边s
        xs = sorted({round(v,6) for r in black_rects for v in (r.x1, r.x2)})
        ys = sorted({round(v,6) for r in black_rects for v in (r.y1, r.y2)})
        nx = len(xs) - 1
        ny = len(ys) - 1

        assert nx > 0 and ny > 0

        # 标记黑色网格单元: 网格单元被某一黑色矩形(含容差)完全覆盖即为边框
        black = [[False] * nx for _ in range(ny)]
        for r in black_rects:
            for j in range(ny):
                y1, y2 = ys[j], ys[j + 1]

                # 清洗表格边框之间的不可见空隙
                if not (r.y1 - MERGE_GAP <= y1 and y2 <= r.y2 + MERGE_GAP):
                    continue
                for i in range(nx):
                    x1, x2 = xs[i], xs[i + 1]
                    if r.x1 - MERGE_GAP <= x1 and x2 <= r.x2 + MERGE_GAP:
                        black[j][i] = True
        
        # 并查集: 合并相邻(四连通)的黑色网格单元, 得到表格边框连通分量
        parent = list(range(nx * ny))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra

        for j in range(ny):
            for i in range(nx):
                if not black[j][i]:
                    continue
                idx = j * nx + i
                if i + 1 < nx and black[j][i + 1]:
                    union(idx, idx + 1)
                if j + 1 < ny and black[j + 1][i]:
                    union(idx, idx + nx)

        black_components: dict[int, list[tuple[int, int]]] = {}
        for j in range(ny):
            for i in range(nx):
                if black[j][i]:
                    black_components.setdefault(find(j * nx + i), []).append((i, j))

        def extract_cells(component: list[tuple[int, int]]) -> dict:
            """对一个黑色连通分量执行原有的白色区域提取逻辑"""
            i_min = min(i for i, _ in component)
            i_max = max(i for i, _ in component)
            j_min = min(j for _, j in component)
            j_max = max(j for _, j in component)
            width = i_max - i_min + 1
            height = j_max - j_min + 1
            local_xs = xs[i_min:i_min + width + 1]
            local_ys = ys[j_min:j_min + height + 1]

            # 只保留当前表格边框的黑色网格单元
            local_black = [[False] * width for _ in range(height)]
            for i, j in component:
                local_black[j - j_min][i - i_min] = True

            def get_runs(values: list[bool]) -> list[tuple[int, int]]:
                runs = []
                start = None
                for index, marked in enumerate(values):
                    if marked and start is None:
                        start = index
                    if not marked and start is not None:
                        runs.append((start, index - 1))
                        start = None
                if start is not None:
                    runs.append((start, len(values) - 1))
                return runs

            def get_horizontal_boundaries() -> list[float]:
                """从黑色网格行中识别横向表格线"""
                boundaries = []
                band = None
                for j in range(height):
                    is_line_row = any(
                        local_xs[end + 1] - local_xs[start] >= LINE_MIN_SPAN
                        for start, end in get_runs(local_black[j])
                    )
                    if is_line_row:
                        if band is not None and j == band[-1] + 1:
                            band.append(j)
                        else:
                            band = [j]
                            boundaries.append(band)
                    else:
                        band = None
                return [(local_ys[rows[0]] + local_ys[rows[-1] + 1]) / 2
                        for rows in boundaries][::-1]

            def get_vertical_boundaries() -> list[float]:
                """从黑色网格列中识别纵向表格线"""
                boundaries = []
                band = None
                for i in range(width):
                    column = [local_black[j][i] for j in range(height)]
                    is_line_column = any(
                        local_ys[end + 1] - local_ys[start] >= LINE_MIN_SPAN
                        for start, end in get_runs(column)
                    )
                    if is_line_column:
                        if band is not None and i == band[-1] + 1:
                            band.append(i)
                        else:
                            band = [i]
                            boundaries.append(band)
                    else:
                        band = None
                return [(local_xs[cols[0]] + local_xs[cols[-1] + 1]) / 2
                        for cols in boundaries]

            row_boundaries = get_horizontal_boundaries()
            col_boundaries = get_vertical_boundaries()

            def nearest_index(boundaries: list[float], value: float) -> int:
                index = min(range(len(boundaries)), key=lambda k: abs(boundaries[k] - value))
                if abs(boundaries[index] - value) > LINE_EDGE_TOLERANCE:
                    raise ValueError(
                        f"cell edge {value} is too far from any table line"
                    )
                return index

            # 并查集: 合并当前表格内相邻(四连通)的白色网格单元
            local_parent = list(range(width * height))

            def local_find(a):
                while local_parent[a] != a:
                    local_parent[a] = local_parent[local_parent[a]]
                    a = local_parent[a]
                return a

            def local_union(a, b):
                ra, rb = local_find(a), local_find(b)
                if ra != rb:
                    local_parent[rb] = ra

            for j in range(height):
                for i in range(width):
                    if local_black[j][i]:
                        continue
                    idx = j * width + i
                    if i + 1 < width and not local_black[j][i + 1]:
                        local_union(idx, idx + 1)
                    if j + 1 < height and not local_black[j + 1][i]:
                        local_union(idx, idx + width)

            # 每个白色连通分量的包围盒即一个单元格
            groups: dict[int, list[tuple[int, int]]] = {}
            for j in range(height):
                for i in range(width):
                    if not local_black[j][i]:
                        groups.setdefault(local_find(j * width + i), []).append((i, j))

            cells: list[dict] = []
            for members in groups.values():
                li_min = min(i for i, _ in members)
                li_max = max(i for i, _ in members)
                lj_min = min(j for _, j in members)
                lj_max = max(j for _, j in members)
                x1, x2 = local_xs[li_min], local_xs[li_max + 1]
                y1, y2 = local_ys[lj_min], local_ys[lj_max + 1]
                if li_min == 0 or li_max == width - 1 or lj_min == 0 or lj_max == height - 1:
                    continue
                cell = Rect(x1, y1, x2 - x1, y2 - y1)

                # 此处认为 row_start 和 col_start 的原点位于表格左上角
                col_start = nearest_index(col_boundaries, cell.x1)
                col_end = nearest_index(col_boundaries, cell.x2)
                row_start = nearest_index(row_boundaries, cell.y2)
                row_end = nearest_index(row_boundaries, cell.y1)
                assert col_start < col_end and row_start < row_end
                cells.append({
                    "row_start": row_start,
                    "col_start": col_start,
                    "row_span": row_end - row_start,
                    "col_span": col_end - col_start,
                    "bbox": [cell.x1, cell.y1, cell.x2, cell.y2],
                    "rect": cell,
                })

            # 按阅读顺序: 从上到下, 同一行内从左到右
            cells.sort(key=lambda entry: (-entry["rect"].y1, entry["rect"].x1))
            return {
                "total_rows": len(row_boundaries) - 1,
                "total_cols": len(col_boundaries) - 1,
                "cells": cells,
            }

        tables = [extract_cells(members) for members in black_components.values()]
        tables = [table for table in tables if table["cells"]]
        # 按阅读顺序排列表格本身
        tables.sort(key=lambda table: (
            -min(cell["rect"].y1 for cell in table["cells"]),
            min(cell["rect"].x1 for cell in table["cells"]),
        ))

        self._cells = tables
        return tables

    def get_tables(self) -> list[dict]:
        """
        将 marked_blocks 定位到 get_cells 得到的单元格中

        定位优先级顺序:
        1. clip 与某个单元格矩形相等
        2. 根据包含基线坐标 + 位于裁剪区域内部进行筛选, 能确定出唯一单元格
        3. 无法定位时认为该 block 不在表格当中
        """
        if self._tables is not None:
            return self._tables

        self._cells = self.get_cells()

        tables = []
        for table in self._cells:
            cells = []
            for cell in table["cells"]:
                cell_copy = dict(cell)
                cell_copy["marked_blocks"] = []
                cells.append(cell_copy)
            cells.sort(key=lambda cell: (cell["row_start"], cell["col_start"]))
            tables.append({
                "total_rows": table["total_rows"],
                "total_cols": table["total_cols"],
                "cells": cells,
            })

        all_cells = [cell for table in tables for cell in table["cells"]]

        def locate_block(block: MarkedContentBlock) -> dict | None:
            # 1. 若某个 TextItem 的裁剪区域与某个单元格一致, 则认为所有 Textitem 属于该单元格
            for item in block.text_items:
                for cell in all_cells:
                    if item.clip == cell["rect"]:
                        return cell

            # 2. 若无法找到完全一致的单元格, 则根据包含基线坐标 + 位于裁剪区域内部进行筛选
            # 断言此类单元格只有一个
            located_cell = None
            for item in block.text_items:
                matches = [
                    cell for cell in all_cells
                    if (item.x, item.y) in cell["rect"] and cell["rect"] in item.clip
                ]

                if len(matches) != 1:
                    continue

                match = matches[0]

                if located_cell is None:
                    located_cell = match
                elif match != located_cell:
                    raise AssertionError(
                        "all text baselines in one marked content block "
                        "must be in the same cell"
                    )
            return located_cell

        def block_reading_key(block: MarkedContentBlock):
            if not block.text_items:
                return (0.0, 0.0)
            return (
                -max(item.y for item in block.text_items),
                min(item.x for item in block.text_items),
            )

        for block in self.content_parser.marked_blocks:
            cell = locate_block(block)
            if cell is not None:
                cell["marked_blocks"].append(block)

        for table in tables:
            for cell in table["cells"]:
                cell["marked_blocks"].sort(key=block_reading_key)

        self._tables = tables
        return tables

        
class ObjStm(PDFObj):
    def __init__(self, data, id = None):
        super().__init__(data, id)
        assert self.raw_stream is not None
        assert self.dict[b'Type'] == b'ObjStm'
        self.objstm_parser = ObjStmParser(self.raw_stream)

    def get_obj(self, id: int) -> PDFObj | None:
        return self.objstm_parser.parse_obj(id)

class CMapObj(PDFObj):
    def __init__(self, data, id = None):
        super().__init__(data, id)
        assert self.raw_stream is not None
        self.cmap_parser = CMapParser(self.raw_stream)
        self.cmap = self.cmap_parser.get_cmap()

class XRefObj(PDFObj):
    def __init__(self, data, id = None):
        super().__init__(data, id)
        assert self.raw_stream is not None
        assert self.dict[b'Type'] == b'XRef'

        self.w = self.dict[b'W']
        assert len(self.w) == 3 and all(isinstance(v,int) for v in self.w)

        self.stream = zlib.decompress(self.raw_stream)

        self.xref = self.get_xref()

    def get_xref(self) -> dict[int,tuple[int, int, int]]:
        """
        根据 id 解析偏移量, 返回xref交叉引用表id->offset, offset为元组, 第一位为生成号, 第二位按照不同情况为
        1. 类型为 1 (普通对象), 第二位为(start,gen_number), 表示起始索引和生成号
        2. 类型为 2 (压缩对象), 第二位为(所在ObjStm对象编号, 索引)
        """
        width = sum(self.w)  # 存储映射 obj_id -> start_offset
        result = {} 
        for i in range(0, len(self.stream), width):
            obj_type = int.from_bytes(self.stream[i : i + self.w[0]])
            if obj_type == 0:
                continue
            elif obj_type in (1, 2):
                num2 = int.from_bytes(self.stream[i + self.w[0] : i + self.w[0] + self.w[1]])
                num3 = int.from_bytes(self.stream[i + self.w[0] + self.w[1] : i + width])
                result[i//width] = (obj_type, num2, num3)
        
        return result


# ======================= PDF 文档类及页面类 =======================

class Page:
    def __init__(self, page_index: int, 
                 page_obj: PDFObj, 
                 content_obj: ContentObj, 
                 decode_map: dict):
        self.page_index = page_index
        self.page_obj = page_obj
        self.content_obj = content_obj
        self.decode_map = decode_map

        self.raw_tables = None
        self.tables = None

    def decode_text(self,block: MarkedContentBlock) -> str:
        text = ''.join(
            self.decode_map[text_item.font](text_item.text) for text_item in block.text_items
            )
        return text

    def get_tables(self) -> list[dict]:
        if self.tables is not None:
            return self.tables

        raw_tables = self.content_obj.get_tables()
        tables = []
        for raw_table in raw_tables:
            table = {
                'total_rows': raw_table['total_rows'],
                'total_cols': raw_table['total_cols']
            }
            cells = [{
                'row_start': raw_cell['row_start'],
                'col_start': raw_cell['col_start'],
                'row_span':  raw_cell['row_span'],
                'col_span':  raw_cell['col_span'],
                'bbox':      raw_cell['bbox'],
                'text':      self.decode_text(raw_cell['marked_blocks'][0]) if raw_cell['marked_blocks'] else ''
            } for raw_cell in raw_table['cells']]

            table['cells'] = cells
            tables.append(table)

        self.tables = tables
        return tables
            

class PDFTableExtractor:
    def __init__(self, path_or_fp: str | bytes):
        """
        :param path_or_fp: pdf 文件路径或二进制 pdf 字节流
        """
        if isinstance(path_or_fp, str):
            with open(path_or_fp,'rb') as f:
                self.data = f.read()
        elif isinstance(path_or_fp, bytes):
            self.data = path_or_fp
        else:
            raise ValueError("")


        self._parser = DictParser(self.data)

        self._xref = self._get_xref()
        self._xref_obj: XRefObj

        self._obj_map: dict[int, PDFObj | CMapObj | ObjStm | ContentObj] = {}

        self._catalog_obj: PDFObj = self._get_obj(self._xref_obj.dict[b'Root'], 'PDFObj')
        self._metadata_obj: PDFObj = self._get_obj(self._xref_obj.dict[b'Info'], 'PDFObj')

        self.metadata = self._get_metadata()

        self._pages_root: PDFObj = self._get_obj(self._catalog_obj.dict[b'Pages'],'PDFObj')

        self.pages = self._get_pages()

    def _get_xref(self):
        pos = self.data.rfind(b'startxref')
        assert pos != -1
        self._parser.pos = pos
        self._parser.read_name()
        self._parser.skip_whitespace()

        startxref = self._parser.read_number()
        self._parser.pos = startxref

        keyword1 = self._parser.read_name()
        assert keyword1 == b'xref'
        self._parser.skip_whitespace()

        num1 = self._parser.read_number()
        self._parser.skip_whitespace()
        num2 = self._parser.read_number()
        self._parser.skip_whitespace()

        keyword2 = self._parser.read_name()
        self._parser.skip_whitespace()
        assert keyword2 == b'trailer'
        
        trailer_dict = self._parser.parse_dict()

        start = trailer_dict[b'XRefStm']
        end = self.data.find(b'endobj',start) + 6
        self._xref_obj = XRefObj(self.data[start:end])

        return self._xref_obj.get_xref()

    def _get_obj(self, id_or_ref: int | tuple[int, int, str], type: str) -> PDFObj | CMapObj | ObjStm | ContentObj:
        if isinstance(id_or_ref, int):
            obj_id = id_or_ref
        elif isinstance(id_or_ref, tuple):
            obj_id = id_or_ref[0]

        if obj_id in self._obj_map.keys():
            return self._obj_map[obj_id]

        if self._xref[obj_id][0] == 1:
            start = self._xref[obj_id][1]
            end = self.data.find(b'endobj',start) + 6

            if type == 'PDFObj':
                obj = PDFObj(self.data[start:end])
            elif type == 'CMapObj':
                obj = CMapObj(self.data[start:end])
            elif type == 'ObjStm':
                obj = ObjStm(self.data[start:end])
            elif type == 'ContentObj':
                obj = ContentObj(self.data[start:end])
            else:
                raise ValueError(f'Unsupported obj type {type}')
            self._obj_map[obj.id] = obj

        elif self._xref[obj_id][0] == 2:
            parent_id = self._xref[obj_id][1]
            parent_obj: ObjStm = self._get_obj(parent_id, 'ObjStm')
            obj = parent_obj.get_obj(obj_id)
            self._obj_map[obj.id] = obj

        return obj

    def _get_metadata(self) -> dict:
        meta_data = self._metadata_obj.dict
        metadata = {}

        for key, value in meta_data.items():
            if key in (b'Producer',b'Creator') and value[:2] == b'\xfe\xff':
                metadata[key.decode()] = value.decode('utf-16')
            else:
                metadata[key.decode()] = value.decode()
        return metadata
                
    def _get_pages(self) -> list[Page]:

        page_list = []

        for index, ref in enumerate(self._pages_root.dict[b'Kids']):
            page_obj_id = ref[0]
            page_obj: PDFObj = self._get_obj(page_obj_id,'PDFObj')

            content_ref = page_obj.dict[b'Contents']
            content_obj: ContentObj = self._get_obj(content_ref, 'ContentObj')

            font_refs: dict[bytes,tuple[int,int,str]] = page_obj.dict[b'Resources'][b'Font']

            decode_map: dict = {}  # font_name -> decode_callback, font_name为 bytes
            for font_name, font_ref in font_refs.items():
                font_obj: PDFObj = self._get_obj(font_ref, 'PDFObj')
                encoding = font_obj.dict[b'Encoding']
                assert encoding in (b'WinAnsiEncoding', b'Identity-H')
                assert b'Differences' not in font_obj.dict.keys()

                if encoding == b"WinAnsiEncoding":
                    decode_callback = lambda text: text.decode()
                elif encoding == b"Identity-H":
                    cmap_ref: tuple[int,int,str] = font_obj.dict[b'ToUnicode']
                    cmap_obj: CMapObj = self._get_obj(cmap_ref,'CMapObj')
                    cmap_dict = cmap_obj.cmap
                    def decode_callback(text: bytes, cmap=cmap_dict) -> str:
                        # 每4个十六进制字符转为一个CID
                        return ''.join(
                            chr(cmap[int(text[i:i+4], 16)])
                            for i in range(0, len(text), 4)
                        )

                decode_map[font_name] = decode_callback

            page_list.append(Page(index, page_obj, content_obj, decode_map))

        return page_list


    @overload
    def extract_table(self) -> dict[int, list[dict]]:
        """提取所有页面的表格"""
        ...

    @overload
    def extract_table(self, index: int) -> list[dict]:
        """
        :param index: 页面索引(零索引)
        """
        ...

    @overload
    def extract_table(self, start: int, end: int) -> dict[int, list[dict]]:
        """提取 [start:end] 页面索引的表格"""
        ...

    @overload
    def extract_table(self, index_list: list[int]) -> dict[int, list[dict]]:
        """
        :param index_list: 待提取页面索引列表(零索引)
        """
        ...

    @overload
    def extract_table(self, index_range: range) -> dict[int, list[dict]]:
        """
        :param index_range: 索引 range 对象(零索引)
        """
        ...

    def extract_table(self, *args):
        """
        提取指定页面中的表格，每个表格为一个 dict, 格式: 
        ```
        {
            'total_rows': 总(逻辑)行数,
            'total_cols': 总(逻辑)列数,
            'cells': [{
                'row_start': 行起始,
                'col_start': 列起始,
                'row_span': 行合并数,
                'col_span': 列合并数,
                'bbox': [x1, y1, x2, y2],
                'text': 文本内容
            }]
        }
        ```
        """
        # 解析参数
        if len(args) == 0:
            index_list = range(len(self.pages))
        elif len(args) == 1:
            arg = args[0]
            if isinstance(arg, int):
                index = arg
                if not (0 <= index < len(self.pages)):
                    raise IndexError(f"Page index {index} out of range")
                return self.pages[index].get_tables()
            elif isinstance(arg, list):
                if not all(isinstance(p, int) for p in arg):
                    raise TypeError("List elements must be integers")
                index_list = arg
            elif isinstance(arg, range):
                index_list = arg
            else:
                raise TypeError(f"Unsupported argument type: {type(arg)}")
        elif len(args) == 2:
            start, end = args
            if not (isinstance(start, int) and isinstance(end, int)):
                raise TypeError("start and end must be integers")
            index_list = range(len(self.pages))[start:end]
        else:
            raise TypeError("Expected 0, 1, or 2 arguments")

        # 统一处理可迭代的 pages（列表或 range）
        tables = {}
        for i in index_list:
            if not (0 <= i < len(self.pages)):
                raise IndexError(f"Page index {i} out of range")
            tables[i] = self.pages[i].get_tables()
        return tables