'use strict';

const vscode = require('vscode');

const DEFAULT_ANCHORS = [":=", "=>", "<=", ":", "when", "else", "elsif", "then", "--"];

let TAB_SIZE = 4;
const CASE_WHEN_STEP = 2;   // case→when→if 每级缩进步长（空格），固定 2，与 tabSize 无关

function activate(ctx) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('vhdlAlign.align', alignSelection),
    vscode.commands.registerCommand('vhdlAlign.alignDocument', alignDocument),
    vscode.commands.registerCommand('vhdlAlign.translateComments', translateComments)
  );
}

function deactivate() {}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('vhdlAlign');
  TAB_SIZE = Number(cfg.get('tabSize', 4)) || 4;   // 缩进统一为 N 空格，默认4，不依赖编辑器
  return {
    anchors: cfg.get('anchors', DEFAULT_ANCHORS),
    minLines: cfg.get('minLines', 2),
  };
}

// ---- 注释翻译（provider 可切换：baidu 默认，youdao 备选） ----

// 注释是否含中文：决定翻译方向（含中文 → 译英；否则 → 译中）
function commentHasCJK(text) { return /[一-鿿]/.test(text); }

// 有道语种码：zh-CHS / en
function youdaoTargetLang(text) { return commentHasCJK(text) ? 'en' : 'zh-CHS'; }
// 百度语种码：zh / en
function baiduTargetLang(text) { return commentHasCJK(text) ? 'en' : 'zh'; }

// 该注释是不是被注释掉的 VHDL 代码（非说明文字）？是则跳过不译，避免破坏代码语义
function looksLikeVhdlCode(c) {
  const t = c.trim();
  if (!t) return false;
  // 赋值/例化形态：`a <= b(7 downto 0);` / `a := b;` / `u_xxx : entity ...`
  if (/(\<\=|:=|=>)/.test(t)) {
    if (/downto\b/i.test(t)) return true;
    if (/;\s*$/.test(t) && /^\s*[A-Za-z_]\w*\s*(\<\=|:=)/.test(t)) return true;
    if (/^\s*\w+\s*:\s*(entity|component)\b/i.test(t)) return true;
    return false;
  }
  // 声明/结构形态：signal/constant/port/process/if/case ... ;
  if (/;\s*$/.test(t) &&
      /^(signal|variable|constant|component|port|generic|map|type|subtype|process|if|elsif|case|when|architecture|entity|begin|end)\b/i.test(t)) return true;
  // 括号+类型：`(7 downto 0)`、`std_logic_vector(...)`
  if (/(std_logic|std_logic_vector|unsigned|signed|integer|natural)\s*\(/i.test(t)) return true;
  return false;
}

// 纯装饰注释（分隔线 `----`/`====` 等）不译
function isDecoration(c) {
  return /^[\s\-=*#~_]+$/.test(c);
}

// 有道智云 v3 签名截断：≤20 全取，否则 前10+总长+后10
function truncateQ(q) {
  return q.length <= 20 ? q : q.slice(0, 10) + q.length + q.slice(q.length - 10);
}

// 调用有道翻译单条文本。require 延迟到函数内，避免 vm 测试/顶层依赖。
function youdaoTranslate(q, appKey, secret) {
  const https = require('https');
  const crypto = require('crypto');
  const from = 'auto';
  const to = youdaoTargetLang(q);
  const salt = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  const curtime = String(Math.floor(Date.now() / 1000));
  const sign = crypto
    .createHash('sha256')
    .update(appKey + truncateQ(q) + salt + curtime + secret, 'utf8')
    .digest('hex');
  const enc = (s) => encodeURIComponent(s);
  const body = `q=${enc(q)}&from=${from}&to=${to}&appKey=${enc(appKey)}&salt=${enc(salt)}&sign=${enc(sign)}&signType=v3&curtime=${curtime}`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openapi.youdao.com',
      path: '/api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (String(j.errorCode) === '0' && j.translation && j.translation[0]) {
            resolve(j.translation[0]);
          } else {
            reject(new Error('有道错误 ' + j.errorCode + (j.errorMsg ? ' ' + j.errorMsg : '')));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 调用百度通用翻译单条文本。
// 签名：sign = md5(appid + q + salt + 密钥)；拼接 sign 时 q 不做 URL 编码，发送时才编码。
function baiduTranslate(q, appid, key) {
  const https = require('https');
  const crypto = require('crypto');
  const from = 'auto';
  const to = baiduTargetLang(q);
  const salt = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  const sign = crypto.createHash('md5').update(appid + q + salt + key, 'utf8').digest('hex');
  const enc = (s) => encodeURIComponent(s);
  const body = `q=${enc(q)}&from=${from}&to=${to}&appid=${enc(appid)}&salt=${enc(salt)}&sign=${sign}`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'fanyi-api.baidu.com',
      path: '/api/trans/vip/translate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          // 成功响应不含 error_code；失败时才有 error_code / error_msg
          if (j.error_code) {
            reject(Object.assign(new Error('百度错误 ' + j.error_code + (j.error_msg ? ' ' + j.error_msg : '')), { code: String(j.error_code) }));
            return;
          }
          const dst = j.trans_result && j.trans_result[0] && j.trans_result[0].dst;
          if (dst) resolve(dst);
          else reject(new Error('百度翻译返回为空'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => reject(Object.assign(e, { code: 'network' })));
    req.write(body);
    req.end();
  });
}

// 百度标准版 QPS=1：命中限频(54003)或网络错误时退避重试（签名/鉴权类错误不重试）
async function baiduTranslateRetry(q, appid, key, attempts) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await baiduTranslate(q, appid, key);
    } catch (e) {
      lastErr = e;
      if (e.code === '54003' || e.code === 'network') {
        await sleep(1100 * (i + 1));
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

// 按 provider 分发单条注释翻译
async function translateComment(provider, comment, cred) {
  if (provider === 'youdao') return youdaoTranslate(comment, cred.appKey, cred.secret);
  return baiduTranslateRetry(comment, cred.appid, cred.key, 3);
}

// 命令：翻译选中区域注释（中文↔英文）。整行注释与行内注释均处理；被注释的 VHDL 代码行跳过。
async function translateComments() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const cfg = vscode.workspace.getConfiguration('vhdlAlign');
  const provider = String(cfg.get('translateProvider') || 'baidu').trim().toLowerCase() === 'youdao' ? 'youdao' : 'baidu';
  const providerLabel = provider === 'youdao' ? '有道' : '百度';
  const cred = {};
  if (provider === 'youdao') {
    cred.appKey = String(cfg.get('youdaoAppKey') || '').trim();
    cred.secret = String(cfg.get('youdaoSecret') || '').trim();
    if (!cred.appKey || !cred.secret) {
      vscode.window.showWarningMessage('请先在设置中配置 vhdlAlign.youdaoAppKey / vhdlAlign.youdaoSecret（当前 provider = youdao）');
      return;
    }
  } else {
    cred.appid = String(cfg.get('baiduAppid') || '').trim();
    cred.key = String(cfg.get('baiduKey') || '').trim();
    if (!cred.appid || !cred.key) {
      vscode.window.showWarningMessage('请先在设置中配置 vhdlAlign.baiduAppid / vhdlAlign.baiduKey（百度翻译开放平台获取，默认 provider）');
      return;
    }
  }
  const doc = ed.document;
  const sel = ed.selection;
  const sLine = sel.start.line;
  const eLine = sel.end.line;
  // 收集待译行：{ line, p(注释起点), text }
  const jobs = [];
  for (let L = sLine; L <= eLine; L++) {
    const line = doc.lineAt(L);
    const text = line.text;
    const p = findAnchorPos(text, '--');      // 跳过字符串字面量
    if (p < 0) continue;
    const raw = text.slice(p + 2);
    if (looksLikeVhdlCode(raw)) continue;     // 被注释的代码保留
    const comment = raw.trim();
    if (!comment || isDecoration(comment)) continue;
    jobs.push({ line, p, comment });
  }
  if (!jobs.length) {
    vscode.window.showInformationMessage('选区内没有可翻译的注释');
    return;
  }
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = '$(sync~spin) 翻译注释中… 0/' + jobs.length;
  status.show();
  let done = 0, failed = 0;
  const edits = [];
  for (const job of jobs) {
    try {
      const tr = await translateComment(provider, job.comment, cred);
      edits.push({ p: job.p, line: job.line, newText: '-- ' + tr.trim() });
    } catch (e) {
      failed++;
    }
    done++;
    status.text = '$(sync~spin) 翻译注释中… ' + done + '/' + jobs.length;
  }
  status.dispose();
  if (!edits.length) {
    vscode.window.showErrorMessage('翻译失败：' + failed + '/' + jobs.length + ' 条未成功，请检查网络与' + providerLabel + '配置');
    return;
  }
  await ed.edit((builder) => {
    for (const e of edits) {
      const text = e.line.text;
      builder.replace(new vscode.Range(e.line.lineNumber, e.p, e.line.lineNumber, text.length), e.newText);
    }
  });
  const msg = '已翻译 ' + edits.length + ' 行注释' + (failed ? '（' + failed + ' 行失败）' : '');
  vscode.window.showInformationMessage(msg);
}

// ---- commands ----

function alignSelection() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const sel = ed.selection;
  let range;
  if (sel.isEmpty) {
    range = currentBlockRange(ed.document, sel.active.line);
  } else {
    const s = sel.start.line;
    const e = sel.end.line;
    range = new vscode.Range(s, 0, e, ed.document.lineAt(e).text.length);
  }
  alignRange(ed, range);
}

function alignDocument() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const last = ed.document.lineCount - 1;
  alignRange(ed, new vscode.Range(0, 0, last, ed.document.lineAt(last).text.length));
}

// 从当前行向上下扩展到第一个空行，得到一个连续非空块的范围
function currentBlockRange(doc, line) {
  let s = line;
  let e = line;
  while (s > 0 && doc.lineAt(s - 1).text.trim() !== '') s--;
  while (e < doc.lineCount - 1 && doc.lineAt(e + 1).text.trim() !== '') e++;
  return new vscode.Range(s, 0, e, doc.lineAt(e).text.length);
}

function alignRange(ed, range) {
  const { anchors, minLines } = getConfig();
  const doc = ed.document;
  const lines = [];
  for (let i = range.start.line; i <= range.end.line; i++) {
    lines.push(detabLine(doc.lineAt(i).text, TAB_SIZE));
  }
  const proc = alignProcess(lines);            // process 块缩进整理（全文档、跨空行配对）
  const ctrl = indentCaseWhenIf(proc);        // case-when-if 语法层缩进重整（以 case 行缩进为锚，栈式嵌套）
  const decls = alignDecls(ctrl);             // 端口/例化块缩进归一（信号名靠左，便于 : / => 列对齐）
  const sigs = alignSignals(decls);           // signal/variable/constant 声明块缩进归一（按空行分块，块内取最小缩进）
  const out = alignWhenContinuation(alignLines(sigs, anchors, minLines));
  const same = lines.length === out.length && lines.every((l, i) => l === out[i]);
  if (same) return;
  const fullRange = new vscode.Range(
    range.start.line, 0,
    range.end.line, lines[lines.length - 1].length
  );
  ed.edit((eb) => eb.replace(fullRange, out.join('\n')));
}

// ---- core ----

// 按空行分块，每块独立对齐；空行原样保留。
// 但端口/例化块内的空行不切分（保持整块跨空行对齐 : / =>）。
function alignLines(lines, anchors, minLines) {
  const ranges = findDeclRanges(lines);
  const inDecl = (idx) => ranges.some(([s, e]) => idx > s && idx < e);
  const result = [];
  let block = [];
  const flush = () => {
    if (block.length) {
      alignBlock(block, anchors, minLines).forEach((x) => result.push(x));
      block = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' && !inDecl(i)) {   // 端口/例化块内空行不切分
      flush();
      result.push(l);
    } else {
      block.push(l);
    }
  }
  flush();
  return result;
}

// 对一个连续非空块，按 anchors 顺序串行对齐
function alignBlock(block, anchors, minLines) {
  let cur = block.slice();   // case-when 缩进已在文档级 indentCaseWhenIf 处理；此处不再调 alignCaseWhen（空行分块会切碎 case 块导致 when 对齐失败）
  for (const a of anchors) {
    cur = alignSymbol(cur, a, minLines);
    // 端口声明方向词列对齐（in/out/inout/buffer），使类型列对齐
    if (a === ':') cur = alignPortDirection(cur);
  }
  return cur;
}

// when 续行左对齐：when 行若带内联赋值（`when X => a <= 1; ...`），其后紧邻的续行
// 赋值语句（同一 when 分支的剩余赋值）重建为「LHS 起点 = when 行 `=>` 后首个标识符列」。
// 首个 <=/:= 前的对齐填充压成单空格 —— 因内联 LHS（如 reg_o(10)）与续行 LHS（如 data1_reg）
// 通常等宽，左对齐后 <= 列也自然与上一行对齐；即便不等宽也保证 LHS 左对齐语义。
// 仅当 when 行 `=>` 后确有内容时生效；遇非赋值语句/控制行/空行/注释即停止。
function alignWhenContinuation(lines) {
  const out = lines.slice();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/^\s*when\b.*=>/i.test(l)) continue;
    const p = findAnchorPos(l, '=>');
    if (p < 0) continue;
    let j = p + 2;
    while (j < l.length && /[ \t]/.test(l[j])) j++;
    if (j >= l.length || l[j] === ';') continue;   // `=>` 后无内容，body 在下一行
    const target = j;
    for (let k = i + 1; k < lines.length; k++) {
      const lk = lines[k];
      if (lk.trim() === '' || /^\s*--/.test(lk)) break;
      if (classifyCtrl(lk) !== 'stmt') break;       // when/if/elsif/else/end 等控制行截止
      const t = lk.replace(/^\s+/, '');
      const a = findAnchorPos(t, '<=');
      const c = findAnchorPos(t, ':=');
      const op = (a < 0) ? c : (c < 0 ? a : Math.min(a, c));
      if (op < 0) break;                            // 非赋值续行，停止
      const head = t.slice(0, op).replace(/[ \t]+$/, '');   // LHS 等 `<=` 前内容，去尾部空白
      out[k] = ' '.repeat(target) + head + ' ' + t.slice(op);
    }
  }
  return out;
}

// process 块：process 首行（含 begin / end process）统一缩进到 PROC_IND(=2)，
// 体内各行整体平移 delta=PROC_IND-procInd，保持原相对层次不变；体内首层不低于 PROC_IND+2。
// 全文档级、跨空行配对 [process .. end process]；未闭合的 process 跳过。
// delta===0（process 原已=2）时体内不动（含注释），保证幂等、不误动。
// 注：仅做整体平移，不重整 if/case 嵌套层次——交给 indentCaseWhenIf 处理。
function alignProcess(lines) {
  const PROC_IND = 2;   // process 首行固定缩进 2 空格
  const out = lines.slice();
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const isProc = /^\s*process\b/i.test(l) || /^\s*\w+\s*:\s*process\b/i.test(l);
    if (!isProc) { i++; continue; }
    const procInd = l.match(/^\s*/)[0].length;
    let endK = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (/^\s*end\s+process\b/i.test(lines[k])) { endK = k; break; }
    }
    if (endK < 0) { i++; continue; }            // 未闭合，不处理
    const delta = PROC_IND - procInd;           // 体内整体平移量：把 process 锚到 PROC_IND
    out[i] = ' '.repeat(PROC_IND) + l.replace(/^\s+/, '');   // process 首行缩进固定 2
    for (let k = i + 1; k <= endK; k++) {
      const lk = lines[k];
      if (/^\s*begin\b/i.test(lk) || /^\s*end\s+process\b/i.test(lk)) {
        out[k] = ' '.repeat(PROC_IND) + lk.replace(/^\s+/, '');  // begin/end process 对齐到 process
      } else if (delta !== 0) {
        const curInd = lk.match(/^\s*/)[0].length;
        const ni = Math.max(curInd + delta, PROC_IND + 2);       // 平移，不低于体内首层
        out[k] = ' '.repeat(ni) + lk.replace(/^\s+/, '');
      }
    }
    i = endK + 1;
  }
  return out;
}

// case-when-if 语法层缩进重整：以每个 case 行的实际缩进为锚（自适应基线），
// 栈式遍历 case..end case 体内所有行，按 when/if/elsif/else/end if/end case 的语法角色重排缩进。
// 嵌套结构：case 缩进 N → when N+2 → when 内首层 N+4；if/elsif/else/end if 各 +2 递进。
// 只动 case..end case 体内行；块外行原样保留。注释行跳过不处理。
function indentCaseWhenIf(lines) {
  const out = lines.slice();
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!/^\s*case\b.*\bis\b/i.test(l) || /^\s*--/.test(l)) { i++; continue; }
    const caseInd = l.match(/^\s*/)[0].length;
    let depth = 1, endK = -1;
    for (let k = i + 1; k < lines.length; k++) {
      const lk = lines[k];
      if (/^\s*--/.test(lk)) continue;
      if (/^\s*case\b.*\bis\b/i.test(lk)) depth++;
      else if (/^\s*end\s+case\b/i.test(lk)) { depth--; if (depth === 0) { endK = k; break; } }
    }
    if (endK < 0) { i++; continue; }
    const stack = [{ type: 'case', row: caseInd, when: caseInd + 2, body: caseInd + 4, seenWhen: false }];
    for (let k = i + 1; k <= endK; k++) {
      const line = lines[k];
      const trimmed = line.replace(/^[ \t]+/, '');
      if (trimmed === '' || /^\s*--/.test(line)) continue;
      const t = classifyCtrl(line);
      let ind;
      if (t === 'when') {
        while (stack.length > 1 && stack[stack.length - 1].type !== 'case') stack.pop();
        stack[stack.length - 1].seenWhen = true;
        ind = stack[stack.length - 1].when;
      } else if (t === 'case') {
        ind = curBodyStack(stack);
        stack.push({ type: 'case', row: ind, when: ind + 2, body: ind + 4, seenWhen: false });
      } else if (t === 'if') {
        ind = curBodyStack(stack);
        stack.push({ type: 'if', row: ind, body: ind + 2 });
      } else if (t === 'elsif' || t === 'else') {
        ind = topIfOf(stack).row;
      } else if (t === 'end if') {
        const ifIdx = topIfIndex(stack);
        ind = stack[ifIdx].row;
        stack.length = ifIdx;
      } else if (t === 'end case') {
        const ci = topCaseIndex(stack);
        ind = stack[ci].row;
        stack.length = ci;
      } else {
        ind = curBodyStack(stack);
      }
      out[k] = ' '.repeat(ind) + trimmed;
    }
    i = endK + 1;
  }
  return out;
}

// 行的语法角色分类（case-when-if 控制）：
// when => ; elsif/else/if..then ; end if/end case ; 嵌套 case..is ; 否则普通语句。
function classifyCtrl(line) {
  if (/^\s*when\b.*=>/i.test(line)) return 'when';
  if (/^\s*elsif\b/i.test(line)) return 'elsif';
  if (/^\s*else\b/i.test(line)) return 'else';
  if (/^\s*end\s+if\b/i.test(line)) return 'end if';
  if (/^\s*end\s+case\b/i.test(line)) return 'end case';
  if (/^\s*case\b.*\bis\b/i.test(line)) return 'case';
  if (/^\s*if\b.*\bthen\b/i.test(line)) return 'if';
  return 'stmt';
}

// 栈顶元素当前语句体的缩进：if 取 body；case 见过 when 后取 body，否则取 when（首个 when 之前不该有语句）。
function curBodyStack(stack) {
  const top = stack[stack.length - 1];
  if (top.type === 'if') return top.body;
  return top.seenWhen ? top.body : top.when;
}

// 从栈顶向下找最近的 if 元素（elsif/else 回缩到该 if 的行缩进）。找不到则返回栈顶。
function topIfOf(stack) {
  for (let j = stack.length - 1; j >= 0; j--) if (stack[j].type === 'if') return stack[j];
  return stack[stack.length - 1];
}

// 从栈顶向下找最近的 if 的索引（end if 弹栈到此位置）。找不到返回末索引。
function topIfIndex(stack) {
  for (let j = stack.length - 1; j >= 0; j--) if (stack[j].type === 'if') return j;
  return stack.length - 1;
}

// 从栈顶向下找最近的 case 的索引（end case 弹栈到此位置）。找不到返回末索引。
function topCaseIndex(stack) {
  for (let j = stack.length - 1; j >= 0; j--) if (stack[j].type === 'case') return j;
  return stack.length - 1;
}

// 端口声明/例化映射块：识别 port( / port map( / generic( / generic map( 到匹配 ')' 的范围。
// 用括号计数（跳过字符串/注释）确定块边界，返回 [startK, endK] 列表。
function findDeclRanges(lines) {
  const ranges = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = l.match(/(port|generic)\s*(map\s*)?\(/i);
    if (!m) continue;
    const openIdx = l.indexOf(m[0]) + m[0].length - 1;   // '(' 位置
    let depth = 1, endK = -1;
    for (let k = i; k < lines.length && endK < 0; k++) {
      const lk = k === i ? l.slice(openIdx + 1) : lines[k];
      let inStr = false;
      for (let c = 0; c < lk.length; c++) {
        const ch = lk[c];
        if (inStr) {
          if (ch === '"') { if (lk[c + 1] === '"') c++; else inStr = false; }
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '-' && lk[c + 1] === '-') break;      // 行内注释，剩余忽略
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) { endK = k; break; } }
      }
    }
    if (endK > i) ranges.push([i, endK]);
  }
  return ranges;
}

// 端口/例化块内：信号行（含 ':' 或 '=>'）前导缩进归一到块内最小缩进，使信号名靠左对齐。
// 这样 alignSymbol 按"前导缩进分组"时，信号行同组，':/=>' 被拉齐到同一列。
function alignDecls(lines) {
  const ranges = findDeclRanges(lines);
  const out = lines.slice();
  for (const [s, e] of ranges) {
    let minInd = Infinity;
    for (let k = s + 1; k < e; k++) {
      const lk = lines[k];
      if (lk.trim() === '' || /^\s*--/.test(lk)) continue;
      if (!/=>/.test(lk) && !/:/.test(lk)) continue;
      const ind = lk.match(/^\s*/)[0].length;
      if (ind < minInd) minInd = ind;
    }
    if (minInd === Infinity) continue;
    for (let k = s + 1; k < e; k++) {
      const lk = out[k];
      if (lk.trim() === '' || /^\s*--/.test(lk)) continue;
      if (!/=>/.test(lk) && !/:/.test(lk)) continue;
      out[k] = ' '.repeat(minInd) + lk.replace(/^\s+/, '');
    }
  }
  return out;
}

// signal/variable/constant 声明块缩进归一：按空行分块，每块内取这些声明行的最小缩进，
// 把块内所有声明行拉齐到该最小缩进。修复手写时个别行缩进偏大导致的对齐孤立问题。
function alignSignals(lines) {
  const KEY = /^\s*(signal|variable|constant)\b/i;
  const out = lines.slice();
  let s = 0;
  while (s < lines.length) {
    if (lines[s].trim() === '') { s++; continue; }
    let e = s;
    while (e + 1 < lines.length && lines[e + 1].trim() !== '') e++;
    let minInd = Infinity;
    for (let k = s; k <= e; k++) {
      if (KEY.test(lines[k])) {
        const ind = lines[k].match(/^\s*/)[0].length;
        if (ind < minInd) minInd = ind;
      }
    }
    if (minInd !== Infinity) {
      for (let k = s; k <= e; k++) {
        if (KEY.test(out[k])) {
          out[k] = ' '.repeat(minInd) + out[k].replace(/^\s+/, '');
        }
      }
    }
    s = e + 1;
  }
  return out;
}

// case-when 块：统一 when 行缩进为 case 行缩进 + CASE_WHEN_STEP(=2)，使 when 关键字列对齐。
// 风格：case 缩进 N → when 行 N+2 → when 内首层(if/赋值) N+4（每级 +2）。
// 仅整 when 行本身；when 内代码与 end case 保留原缩进（when 内本就 +2，故修 when 后自然对齐）。
function alignCaseWhen(lines) {
  let caseInd = -1;
  for (const l of lines) {
    const m = l.match(/^(\s*)case\b/i);
    if (m) { caseInd = m[1].length; break; }
  }
  const whenIdxs = [];
  lines.forEach((l, i) => {
    if (/^\s*when\b/i.test(l)) whenIdxs.push(i);
  });
  if (whenIdxs.length < 2) return lines;   // 非 case-when 块不动
  const base = caseInd >= 0 ? caseInd + CASE_WHEN_STEP : 0;
  return lines.map((l, i) => {
    if (!whenIdxs.includes(i)) return l;
    const rest = l.replace(/^\s*when\b/i, 'when');
    return ' '.repeat(base) + rest;
  });
}

// 端口/generic 声明：对齐 ':' 后的方向词列（in/out/inout/buffer），
// 使方向词等宽、其后的类型列对齐。仅对含方向词的块生效；signal 块不动。
function alignPortDirection(lines) {
  const DIRS = new Set(['in', 'out', 'inout', 'buffer', 'linkage']);
  const parsed = lines.map((line) => {
    const p = findAnchorPos(line, ':');
    if (p < 0) return null;
    let i = p + 1;
    while (i < line.length && /[ \t]/.test(line[i])) i++;
    let j = i;
    while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j++;
    const word = line.slice(i, j);
    if (!word) return null;
    return {
      before: line.slice(0, p + 1),   // 含 ':'
      word,
      rest: line.slice(j).replace(/^[ \t]+/, ''),
    };
  });
  const idxs = [];
  parsed.forEach((x, i) => { if (x) idxs.push(i); });
  const dirIdxs = idxs.filter((i) => DIRS.has(parsed[i].word.toLowerCase()));
  if (dirIdxs.length < 2) return lines;   // 非端口块不动
  const maxW = Math.max(...dirIdxs.map((i) => parsed[i].word.length));
  return lines.map((line, i) => {
    const x = parsed[i];
    if (!x || !DIRS.has(x.word.toLowerCase())) return line;
    const pad = ' '.repeat(maxW - x.word.length + 1);
    return x.before + ' ' + x.word + pad + x.rest;
  });
}

// 对齐单个锚点：在每行找首个出现位置（跳过字符串/注释），补空格使该锚点列对齐
function alignSymbol(lines, anchor, minLines) {
  const parsed = lines.map((line) => {
    const p = findAnchorPos(line, anchor);
    if (p < 0) return null;
    const before = line.slice(0, p);
    // => 锚点：跳过 case-when 的 when 行（when xxx =>），其 => 不对齐成列，保持紧跟
    if (anchor === '=>' && /^\s*when\b/i.test(before)) return null;
    // -- 锚点：跳过整行注释（行首 --，锚点前全是空白）。被注释掉的代码行保持原缩进，
    // 不被拉去和行内说明注释（code; --xxx）的 -- 列对齐，避免整行注释被推到很右。
    if (anchor === '--' && /^\s*$/.test(before)) return null;
    const isLeading = /^\s*$/.test(before);   // 行首锚点：锚点前全是空白（缩进）
    const core = isLeading ? before : before.replace(/[ \t]+$/, '');
    return {
      core,
      isLeading,
      anchorText: line.slice(p, p + anchor.length),
      rest: line.slice(p + anchor.length),
    };
  });
  // 按前导缩进分组，组内对齐；不同缩进层次不互相拉齐（保留 case/if 等多层缩进）
  // groupKeyFor 让 when 续行赋值并入 when 行缩进组，从而与 when 内联赋值对齐
  const groups = new Map();
  parsed.forEach((x, i) => {
    if (!x) return;
    const ind = x.core.match(/^\s*/)[0].length;
    if (!groups.has(ind)) groups.set(ind, []);
    groups.get(ind).push(i);
  });
  const out = lines.slice();
  for (const [, idxs] of groups) {
    if (idxs.length < minLines) continue;
    const maxL = Math.max(...idxs.map((i) => displayWidth(parsed[i].core)));
    for (const i of idxs) {
      const x = parsed[i];
      const pad = ' '.repeat(maxL - displayWidth(x.core) + (x.isLeading ? 0 : 1));
      out[i] = x.core + pad + x.anchorText + x.rest;
    }
  }
  return out;
}

// 在一行中找锚点首次出现位置（注释/字符串外）。返回索引或 -1。
function findAnchorPos(line, anchor) {
  const isKeyword = /^[a-zA-Z]+$/.test(anchor);
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '"') {
        // VHDL 字符串中 "" 表示一个字面 "，跳过
        if (line[i + 1] === '"') { i++; }
        else { inStr = false; }
      }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    // 注释 -- 之后内容不算锚点（除非锚点本身就是 --）
    if (c === '-' && line[i + 1] === '-') {
      return anchor === '--' ? i : -1;
    }
    if (line.startsWith(anchor, i)) {
      // ':' 排除 ':='
      if (anchor === ':' && line[i + 1] === '=') continue;
      if (isKeyword) {
        const prev = i > 0 ? line[i - 1] : '';
        if (/[A-Za-z0-9_]/.test(prev)) continue;          // 前接 word 字符，非独立关键字
        const afterChar = line[i + anchor.length];
        if (/[A-Za-z0-9_]/.test(afterChar)) continue;      // 后接 word 字符，是更长标识符的一部分
      }
      return i;
    }
  }
  return -1;
}

// 字符串显示宽度：tab 按 TAB_SIZE 展开为空格宽度（用于跨 tab/空格混合缩进对齐）
function displayWidth(s) {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    w += s[i] === '\t' ? (TAB_SIZE - (w % TAB_SIZE)) : 1;
  }
  return w;
}

// 整行 tab 转空格（按 tabSize 展开），统一为空格缩进，不保留 tab
function detabLine(line, tabSize) {
  let out = '';
  let col = 0;
  for (const c of line) {
    if (c === '\t') {
      const n = tabSize - (col % tabSize);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += c;
      col++;
    }
  }
  return out;
}

module.exports = { activate, deactivate };
