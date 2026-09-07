# VHDL Align

按 `=>`、`<=`、`:=`、`:`、`--` 及关键字 `when/else/elsif/then` 对齐 VHDL 代码的小型 VSCode 扩展。纯 JavaScript，零依赖。

## 用法

| 命令 | 快捷键 | 作用 |
|------|--------|------|
| `VHDL: Align Block` | `Ctrl+Alt+A` | 对齐选区；无选区时对齐光标所在连续非空块 |
| `VHDL: Align Whole Document` | `Ctrl+Alt+Shift+A` | 对齐整个文件（按空行分块，块内独立对齐） |

命令面板（`Ctrl+Shift+P`）输入 `VHDL` 即可看到。

## 对齐规则

- 按空行分块，每块独立对齐（不跨块拉齐）。
- 块内按锚点顺序（默认 `:= => <= : when else elsif then --`）从左到右串行对齐。
- 对齐前先把整行 tab 按 `vhdlAlign.tabSize`（默认4）展开为空格，缩进统一为空格、不保留 tab。
- case-when 块：`when` 行缩进统一为 `case` 行缩进 **+2**，`when` 内首层代码（if/赋值）本就在 `when+2`，故 `case→when→if` 每级 +2（步长固定 2，与 tabSize 无关）。
- `when xxx =>` 的 `=>` 不对齐成列（保持紧跟）；端口映射 `a => b` 的 `=>` 仍对齐。
- process 块：`process` / `begin` / `end process` 对齐到同一列（`begin` 不缩进），并把 `[process..end process]` 区间内各行整体上移使每级保持 +2。
- 每个锚点取行内**首个**出现位置（字符串 `"..."` 与注释 `--` 之后的不算）。
- `:` 自动排除 `:=`；关键字要求词边界匹配。
- 不足 `vhdlAlign.minLines`（默认 2）行含该锚点则跳过。

## 配置（settings.json）

```json
"vhdlAlign.anchors": [":=", "=>", "<=", ":", "when", "else", "elsif", "then", "--"],
"vhdlAlign.minLines": 2,
"vhdlAlign.tabSize": 4
```

## 效果示例

对齐前：
```vhdl
signal a1_round_out : std_logic_vector(31 downto 0);
signal b_round_out  : std_logic_vector(31 downto 0);
clka   => ui_clk,
wea(0) => '1',
addra  => status_addra,
```

对齐后：
```vhdl
signal a1_round_out : std_logic_vector(31 downto 0);
signal b_round_out  : std_logic_vector(31 downto 0);
clka   => ui_clk,
wea(0) => '1',
addra  => status_addra,
```

## 安装/卸载

- 方式一（推荐，`.vsix`）：本目录下取 `vhdl-align-0.0.1.vsix`，VS Code 扩展面板 `···` → `Install from VSIX...` 选择该文件即可。
- 方式二（源码）：把本 `vhdl-align/` 目录复制到 `C:\Users\<用户名>\.vscode\extensions\`，`Ctrl+Shift+P` → `Reload Window`。
- 卸载：扩展面板中找到 VHDL Align 卸载；源码方式则删除扩展目录后 Reload Window。
