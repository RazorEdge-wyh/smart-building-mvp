/* ============================================================================
 *  构建可静态托管的页面
 *
 *  目的：GitHub Pages 只托管静态文件，所以要产出自包含页面（内联 CSS/JS），
 *        避免任何相对路径与 MIME 风险 —— 单文件、双击即开、托管即用。
 *
 *  产物：
 *    static/dist/demo/index.html    交互演示（内联全部逻辑）
 *    static/dist/index.html         落地页（说明 + 入口 + 项目链接）
 *    static/dist/README.md          部署说明
 *
 *  用法： node static/build.mjs
 * ========================================================================== */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, 'dist');

/* 把 ES module 源码转成可直接内联的**经典脚本**：
   去掉 import/export 关键字，把模块内符号通过 window.__SH__ 暴露出去。

   ★ 必须用 IIFE 包起来：两段脚本（模块 + app）各自都有 `const $ = ...`，
     直接内联会在全局重复声明而报 "Identifier '$' has already been declared"。 */
function toClassic(src, exports) {
  let out = src
    .replace(/^import\s+[^;]+;\s*$/gm, '')                       // 去掉顶部 import
    .replace(/^export\s+(const|let|var|class|function)\s+/gm, '$1 ')  // 去 export 前缀
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');                 // 去 export {...}
  // 源码里本来就有 window.SH = {...}，这里再补一份 __SH__（名字不同，互不冲突）
  out += `\nwindow.__SH__ = { ${exports.join(', ')} };\n`;
  return `(function(){\n${out}\n})();\n`;
}

/** app 段：同样包 IIFE，但把内联事件处理器需要的函数挂到 window。
 *
 *  ★ 关键：解构时**只取局部作用域里没有的**符号。app.js 自己声明了
 *    `$ / $$ / send / quick` 等，若再从 window 解构同名符号就会
 *    "Identifier 'quick' has already been declared"。 */
function appToClassic(src, handlers) {
  const local = new Set();
  for (const m of src.matchAll(/^\s*(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm)) {
    local.add(m[1]);
  }
  const need = handlers.filter((h) => !local.has(h));
  const scope = need.length ? `const { ${need.join(', ')} } = window;` : '';
  return `(function(){\n${scope}\n${src}\n})();\n`;
}

const MODULE_EXPORTS = [
  'parseRules', 'SafetyValidator', 'AuditLog', 'Sim', 'BuildingAgent', 'MemoryStore',
  'EvacuationSolver', 'EmergencyFSM', 'generateGuidance', 'extractMemories',
  'extractSchedule', 'priceTier', 'boundsForRoom', 'clampSetpoint', 'BOUNDS', 'ROOMS',
  'AGENTS', 'TOPOLOGY', 'Rng', 'validateSchema', 'validatePhysics', 'validateGuidance',
  'minToHHMM', 'hhmmToMin', 'PASS', 'REJECT_BOUNDS', 'REJECT_EMERGENCY',
  'REJECT_PERMISSION', 'REJECT_RATE', 'REJECT_SCHEMA', 'CLARIFY',
];

async function buildDemo() {
  const html = await readFile(join(HERE, 'index.html'), 'utf8');
  const mod = await readFile(join(HERE, 'smart-building-mvp.js'), 'utf8');
  let app = await readFile(join(HERE, 'app.js'), 'utf8');

  // app.js 顶部 import 里的名字从全局取
  app = app
    .replace(/^import\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"];?/m,
             (_, names) => 'const { ' + names.split(',').map((s) => s.trim())
               .filter(Boolean).join(', ') + ' } = window.__SH__;');

  // 内联 onclick/onkeydown 需要的处理函数：IIFE 内的函数名挂到 window，
  // 并通过开头的解构把它们带回局部作用域（这样源码本身不用改）。
  const HANDLERS = ['send', 'quick', 'runCompare', 'triggerEmg', 'clearEmg',
                    'tryModelTrigger', 'toggleConsent', 'addMemory', 'forget',
                    'tamperDemo'];
  app += `\nObject.assign(window, { ${HANDLERS.join(', ')} });\n`;

  // ★ app.js 自己定义了 $ / $$ 等短名，解构时不能再取同名，
  //   否则会 "Identifier '$' has already been declared"。
  app = app.replace(
    /^const \{([\s\S]*?)\} = window\.__SH__;/m,
    (_, names) => {
      const list = names.split(',').map((s) => s.trim()).filter(Boolean);
      const conflict = new Set(['$', '$$']);
      const kept = list.filter((n) => !conflict.has(n));
      return `const { ${kept.join(', ')} } = window.__SH__;`;
    });

  const inline = `<script>\n${toClassic(mod, MODULE_EXPORTS)}\n</script>\n` +
                 `<script>\n${appToClassic(app, HANDLERS)}\n</script>`;
  // ★ 必须用**替换函数**而不是替换字符串：
  //   String.replace 会把替换串里的 `$$` 当作"一个字面 $"，从而把源码里的
  //   `const $$ = ...` 悄悄改成 `const $ = ...`（这个坑排查了很久，勿改回字符串形式）。
  const out = html
    .replace(/<script type="module"[^>]*><\/script>\s*/g, '')
    .replace('</body>', () => inline + '\n</body>');
  await mkdir(join(DIST, 'demo'), { recursive: true });
  await writeFile(join(DIST, 'demo', 'index.html'), out, 'utf8');
  return { bytes: Buffer.byteLength(out, 'utf8') };
}

/* ---------------------------------------------------------------- 落地页 */
async function buildLanding() {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>智慧建筑 · 室内环境小模型 MVP</title>
<style>
  :root{--bg:#0e1014;--panel:#161a21;--line:#2a3040;--fg:#e8edf5;--dim:#8d9bb0;
        --dim2:#6b7789;--ok:#3ecf8e;--info:#4a9eff;--warn:#f5a623}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:15px/1.75 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  .wrap{max-width:840px;margin:0 auto;padding:56px 22px 80px}
  h1{font-size:27px;margin:0 0 6px;letter-spacing:-.4px}
  .lead{color:var(--dim);font-size:15px;margin:0 0 28px}
  h2{font-size:15px;margin:34px 0 10px;color:var(--fg);
     border-left:3px solid var(--info);padding-left:10px}
  p{margin:10px 0;color:#cfd8e3}
  ul{margin:10px 0;padding-left:20px;color:#cfd8e3}
  li{margin:5px 0}
  code{background:var(--panel);padding:2px 6px;border-radius:4px;
       font-family:ui-monospace,Consolas,monospace;font-size:13px;color:#bcd3ee}
  .cta{display:inline-block;margin:6px 10px 6px 0;padding:12px 22px;border-radius:10px;
       text-decoration:none;font-weight:600;transition:.18s}
  .cta.primary{background:var(--info);color:#04121f}
  .cta.primary:hover{filter:brightness(1.12)}
  .cta.ghost{border:1px solid var(--line);color:var(--fg)}
  .cta.ghost:hover{border-color:var(--info);color:var(--info)}
  table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13.5px}
  td,th{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left}
  th{color:var(--dim);font-weight:600}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .note{background:var(--panel);border:1px solid var(--line);border-radius:10px;
        padding:14px 16px;margin:20px 0;font-size:13.5px;color:var(--dim)}
  .note b{color:var(--fg)}
  .ok{color:var(--ok)} .warn{color:var(--warn)}
  footer{color:var(--dim2);font-size:13px;margin-top:44px;
         border-top:1px solid var(--line);padding-top:18px}
</style>
</head>
<body>
<div class="wrap">
  <h1>智慧建筑 · 室内环境小模型 MVP</h1>
  <p class="lead">给一栋楼装一个<b>装在本楼里、断网也能活、参数很小</b>的"脑子"——
  听懂人话调环境、记住每个人的习惯、火灾时给出正确的疏散引导。</p>

  <a class="cta primary" href="./demo/">▶ 打开交互演示</a>
  <a class="cta ghost" href="https://github.com/RazorEdge-wyh/smart-building-mvp">查看源码</a>

  <div class="note">
    <b>演示是纯前端的</b>：Python 后端（仿真、安全校验、疏散路网、画像库）已在浏览器里用
    JavaScript 重新实现，并通过了 <b>79 项移植正确性测试</b>（<code>static/test_port.mjs</code>）。
    逻辑与 <code>eval/</code> 下的 Python 评测同源，但<b>绝对数值不可外推到真实建筑</b>。
  </div>

  <h2>实测结果（可复现）</h2>
  <table>
    <tr><th>指标</th><th class="num">数值</th><th>说明</th></tr>
    <tr><td>占空预测 F1</td><td class="num ok">0.8848</td>
        <td>14 天 × 2 房间，<b>按时间切分</b>防泄漏</td></tr>
    <tr><td>意图解析 · 纯规则</td><td class="num">100%</td>
        <td>同源测试集，存在乐观偏差</td></tr>
    <tr><td>意图解析 · 纯小模型</td><td class="num warn">17.3%</td>
        <td>但 JSON 合法率 <b>97.3%</b>（约束解码已解决格式）</td></tr>
    <tr><td>同舒适下节能</td><td class="num ok">2.8% / 5.4%</td>
        <td>vs 仅时间表 / vs 理想传感器（帕累托前沿口径）</td></tr>
    <tr><td>应急路线合法性</td><td class="num ok">100%</td>
        <td>火源房间误分配 <b>0 次</b>，措辞违规 100% 拦截</td></tr>
  </table>

  <h2>三条能力线</h2>
  <ul>
    <li><b>智能调温</b>：2R2C 灰盒热模型 + 占空预测 + 多住户 <b>minimax 折中</b> + 分时电价</li>
    <li><b>习惯记忆</b>：记忆存数据库而非模型权重 —— 可解释、可更正、<b>可删除</b>（被遗忘权）</li>
    <li><b>灾难引导</b>：路线来自<b>确定性图算法</b>，小模型只负责措辞；
        火源房间转为<b>就地避险</b>；模型不可用时退化到预置广播</li>
  </ul>

  <h2>安全设计（核心，不是附属）</h2>
  <p><b>模型只出"意图"，绝不直接控制设备。</b>每条指令都要过七道闸门：</p>
  <ul>
    <li>闸1 Schema · 闸2 权限 · <b>闸3 场景互锁（应急状态拒绝一切舒适性调节）</b></li>
    <li>闸4 物理边界 · 闸5 变更率限幅（防抖）· 闸6 设备保护 · 闸7 置信度</li>
  </ul>
  <p>另外：阈值写在<b>配置表</b>而不是提示词里；模型<b>没有应急触发权限</b>；
     审计<b>链式哈希 + 条数封印</b>，改字段或删记录都能被发现；校验器异常时 <b>fail-closed</b>。</p>

  <h2>最值得记的一条结论</h2>
  <p><b>格式靠约束解码，语义靠规则 + 微调。</b>
     JSON Schema 约束把格式合法率推到 97.3%，但纯模型的语义命中率只有 17.3% ——
     这两件事必须分开投入。生产路径是"规则有定论就不调模型"，模型只用于长尾救援。</p>

  <footer>
    本地运行 · 零第三方依赖（Python 侧只需 numpy + pandas）· 断网可用<br>
    绝对数值不可外推：热模型参数未经实测辨识，热舒适用容忍区间代理而非 PMV/PPD。<br>
    灾难引导是<b>辅助增强系统</b>，不替代消防规范要求；真实部署前必须通过消防审查。
  </footer>
</div>
</body>
</html>`;
  await writeFile(join(DIST, 'index.html'), html, 'utf8');
  return { bytes: Buffer.byteLength(html, 'utf8') };
}

/* ---------------------------------------------------------------- 部署说明 */
async function buildReadme() {
  const md = `# smart-building-mvp（静态演示）

这是《智慧建筑 · 室内环境小模型 MVP》的**纯前端演示站点**，由构建脚本自动生成，请勿手改。

- \`index.html\` — 落地页
- \`demo/index.html\` — 交互演示（自包含单文件，内联了全部逻辑）

## 它是怎么来的

主项目用 Python 实现了仿真、安全校验、疏散路网与画像库；
为了能在 GitHub Pages 这类**静态托管**上演示，这些逻辑在
\`static/smart-building-mvp.js\` 里用 JavaScript 重新实现了一遍，
并由 \`static/test_port.mjs\`（79 项）做**移植正确性测试** ——
移植走样比不移植更危险，所以必须用同一套标注集对比口径。

## 本地重新构建

\`\`\`bash
node static/build.mjs          # 生成 static/dist/
node static/serve.mjs 8899     # 本地预览 http://127.0.0.1:8899/
node static/test_port.mjs      # 跑移植正确性测试
\`\`\`

## 免责声明

演示中的所有数值来自**内置仿真**，热模型参数未经真实建筑辨识，
**绝对数值不可外推**。灾难引导模块是辅助增强系统，不替代消防规范要求。
`;
  await writeFile(join(DIST, 'README.md'), md, 'utf8');
}

/* ---------------------------------------------------------------- 主流程 */
await rm(DIST, { recursive: true, force: true });
const d = await buildDemo();
const l = await buildLanding();
await buildReadme();
console.log('构建完成 →', DIST);
console.log(`  落地页       index.html        ${(l.bytes / 1024).toFixed(1)} KB`);
console.log(`  交互演示     demo/index.html   ${(d.bytes / 1024).toFixed(1)} KB（自包含）`);
console.log('  部署说明     README.md');
