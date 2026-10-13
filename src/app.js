/* ============================================================================
 *  静态演示的界面逻辑（配合 smart-building-mvp.js 使用）
 *  它只做三件事：驱动仿真时钟、把快照画到页面上、把用户输入交给智能体。
 * ========================================================================== */
import {
  BuildingAgent, MemoryStore, parseRules, extractMemories, priceTier, minToHHMM,
  hhmmToMin, ROOMS, BOUNDS, EmergencyFSM,
} from './smart-building-mvp.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const DOW_CN = { mon:'周一', tue:'周二', wed:'周三', thu:'周四', fri:'周五', sat:'周六', sun:'周日' };

/* ---------------------------------------------------------------- 状态 */
let agent, snap, timer = null;
let tickMs = 700, minutesPerTick = 2;
let showRoom = 'A301';
const trend = {};
const TREND_MAX = 260;
const COMPARE_LABELS = {
  b0: 'B0 固定22℃常开', b1s: 'B1s 仅按时间表（真实可达基线）',
  b1: 'B1 规则+完美占空', b2: 'B2 预测式', b2c: 'B2c 舒适优先',
};

function toast(msg, ms = 2800) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}
function pill(el, text, cls) {
  el.textContent = text;
  el.className = 'pill' + (cls ? ' ' + cls : '');
}

/* ---------------------------------------------------------------- 初始化 */
function boot() {
  agent = new BuildingAgent({ seed: 42, startMin: hhmmToMin('19:10'), controller: 'b2' });
  agent.tick(1);

  // 两个对照下拉
  $('#cmp-a').innerHTML = Object.entries(COMPARE_LABELS)
    .map(([k, v]) => `<option value="${k}"${k === 'b1s' ? ' selected' : ''}>${v}</option>`).join('');
  $('#cmp-b').innerHTML = Object.entries(COMPARE_LABELS)
    .map(([k, v]) => `<option value="${k}"${k === 'b2' ? ' selected' : ''}>${v}</option>`).join('');

  // 房间切换按钮
  $('#room-sel').innerHTML = ROOMS.map((r) =>
    `<button data-room="${r.room_id}" class="${r.room_id === showRoom ? 'on' : ''}">${r.room_id} ${r.name}</button>`).join('');
  $$('#room-sel button').forEach((b) => b.onclick = () => {
    showRoom = b.dataset.room;
    $$('#room-sel button').forEach((x) => x.classList.toggle('on', x === b));
    drawChart(); loadHabits();
  });

  $$('#speed button').forEach((b) => b.onclick = () => setSpeed(+b.dataset.ms));
  setSpeed(700);

  addMsg('我是这栋楼的室内环境助手（纯前端版）。试着跟我说：\n' +
         '· 「客厅有点冷」→ 按画像调到合适温度\n' +
         '· 「把温度设到40度」→ 被安全边界拦下\n' +
         '· 「我周三晚上七点到九点有网课」→ 写进习惯画像\n' +
         '· 右上角调快时钟；左下角触发火警演练', 'sys');

  refresh();
  loadHabits();
}

function setSpeed(ms) {
  tickMs = ms;
  $$('#speed button').forEach((b) => b.classList.toggle('on', +b.dataset.ms === ms));
  if (timer) clearInterval(timer);
  if (ms > 0) timer = setInterval(tick, ms);
}

function tick() {
  agent.tick(minutesPerTick);
  refresh();
}

/* ---------------------------------------------------------------- 渲染 */
function refresh() {
  snap = agent.snapshot();
  renderRooms(snap);
  renderHeader(snap);
  pushTrend(snap);
  renderAudit(snap);
}

function renderHeader(s) {
  const a = s.audit || {};
  pill($('#p-audit'), `意图 ${a.total || 0} · 拦截 ${a.rejects || 0} · 链${a.chain_ok ? '完整' : '异常'}`,
       a.chain_ok ? 'ok' : 'bad');
  pill($('#p-energy'), `能耗 ${s.energy.total_kwh.toFixed(2)} kWh · ¥${s.energy.cost_yuan.toFixed(2)}`);
  const tierCn = { valley:'谷电', flat:'平电', peak:'峰电' }[s.price_tier] || s.price_tier;
  pill($('#p-clock'), `${DOW_CN[s.dow] || s.dow} 第${s.day_index}天 ${s.sim_time} · 室外 ${s.outdoor_temp}℃ · ${tierCn}`);
  const emg = s.emergency;
  $('#p-emg').style.display = emg ? '' : 'none';
  $('#p-mode').textContent = `仿真中 ×${minutesPerTick}分/拍`;
}

function renderRooms(s) {
  let html = '';
  for (const [rid, r] of Object.entries(s.rooms)) {
    const cls = { comfortable:'ok', unoccupied:'', slightly_off:'warn', uncomfortable:'bad' }[r.comfort] || '';
    const label = { comfortable:'舒适', slightly_off:'略偏', uncomfortable:'不适', unoccupied:'无人' }[r.comfort] || r.comfort;
    const co2p = Math.min(100, r.co2 / 1500 * 100);
    const co2c = r.co2 > 1000 ? 'var(--bad)' : r.co2 > 800 ? 'var(--warn)' : 'var(--ok)';
    const dev = r.T_air - r.setpoint;
    const who = (r.occupants || []).map((u) => ({ U001:'住户A', U002:'住户B' }[u] || u)).join('、');
    html += `<div class="room">
      <h3>${esc(rid)} <span class="sub2">${esc(r.name)}</span><span class="pill ${cls}">${label}</span></h3>
      <div class="occ">${r.occupancy > 0 ? '室内 ' + r.occupancy + ' 人（' + esc(who) + '）' : '无人'}
        · 模式 ${esc(r.mode)} · 风速 ${esc(r.fan)}</div>
      <div class="temp">${r.T_air.toFixed(1)}<span>℃</span></div>
      <div class="sub">设定 ${r.setpoint.toFixed(1)}℃
        <span class="sub2">（偏差 ${dev >= 0 ? '+' : ''}${dev.toFixed(2)}℃）</span></div>
      <div class="bar"><i style="width:${co2p}%;background:${co2c}"></i></div>
      <div class="grid2">
        <span><b>CO₂</b> ${r.co2} ppm</span>
        <span><b>湿度</b> ${r.rh.toFixed(0)}%</span>
        <span><b>最大不满</b> ${r.regret.toFixed(2)}℃</span>
        <span><b>墙温</b> ${r.T_wall.toFixed(1)}℃</span>
        <span><b>可设范围</b> ${r.bounds.min}~${r.bounds.max}℃</span>
        <span><b>舒适达标</b> ${(s.stats.comfort_ok_rate * 100).toFixed(0)}%</span>
      </div></div>`;
  }
  $('#rooms').innerHTML = html;
}

function pushTrend(s) {
  for (const [rid, r] of Object.entries(s.rooms)) {
    const arr = trend[rid] || (trend[rid] = []);
    arr.push({ t: s.sim_time, T: r.T_air, sp: r.setpoint, occ: r.occupancy, regret: r.regret });
    if (arr.length > TREND_MAX) arr.shift();
  }
  drawChart();
}

function drawChart() {
  const cv = $('#chart');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 900, H = cv.clientHeight || 120;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const arr = trend[showRoom] || [];
  if (arr.length < 2) {
    g.fillStyle = '#6b7789'; g.font = '12px sans-serif';
    g.fillText('数据积累中…（把右上角速度调快）', 12, H / 2);
    return;
  }
  const temps = arr.map((d) => d.T), sps = arr.map((d) => d.sp);
  let lo = Math.min(...temps, ...sps), hi = Math.max(...temps, ...sps);
  const pad = Math.max(0.8, (hi - lo) * 0.18);
  lo -= pad; hi += pad;
  const PL = 36, PR = 8, PT = 10, PB = 18;
  const x = (i) => PL + (W - PL - PR) * i / (arr.length - 1);
  const y = (v) => PT + (H - PT - PB) * (1 - (v - lo) / (hi - lo || 1));

  // 无人区间底色
  g.fillStyle = 'rgba(255,255,255,.035)';
  let start = null;
  arr.forEach((d, i) => {
    if (!d.occ && start === null) start = i;
    if ((d.occ || i === arr.length - 1) && start !== null) {
      g.fillRect(x(start), PT, Math.max(1, x(i) - x(start)), H - PT - PB);
      start = null;
    }
  });

  // 网格
  g.strokeStyle = '#232936'; g.lineWidth = 1;
  g.fillStyle = '#6b7789'; g.font = '10px ui-monospace,Consolas,monospace';
  for (let k = 0; k <= 4; k++) {
    const v = lo + (hi - lo) * k / 4, yy = y(v);
    g.beginPath(); g.moveTo(PL, yy); g.lineTo(W - PR, yy); g.stroke();
    g.fillText(v.toFixed(1), 4, yy + 3);
  }
  g.fillText((arr[0].t || '').slice(0, 5), PL, H - 5);
  g.fillText((arr[arr.length - 1].t || '').slice(0, 5), W - PR - 30, H - 5);

  // 设定值虚线
  g.strokeStyle = '#f5a623'; g.lineWidth = 1.6; g.setLineDash([5, 4]);
  g.beginPath(); arr.forEach((d, i) => i ? g.lineTo(x(i), y(d.sp)) : g.moveTo(x(i), y(d.sp)));
  g.stroke(); g.setLineDash([]);

  // 室温面积 + 实线
  const grad = g.createLinearGradient(0, PT, 0, H - PB);
  grad.addColorStop(0, 'rgba(74,158,255,.28)');
  grad.addColorStop(1, 'rgba(74,158,255,0)');
  g.beginPath();
  arr.forEach((d, i) => i ? g.lineTo(x(i), y(d.T)) : g.moveTo(x(i), y(d.T)));
  g.lineTo(x(arr.length - 1), H - PB); g.lineTo(x(0), H - PB); g.closePath();
  g.fillStyle = grad; g.fill();

  g.beginPath();
  arr.forEach((d, i) => i ? g.lineTo(x(i), y(d.T)) : g.moveTo(x(i), y(d.T)));
  g.strokeStyle = '#4a9eff'; g.lineWidth = 2; g.stroke();

  const li = arr.length - 1;
  g.beginPath(); g.arc(x(li), y(arr[li].T), 3.5, 0, 7);
  g.fillStyle = '#4a9eff'; g.fill();
  g.strokeStyle = '#0e1014'; g.lineWidth = 1.5; g.stroke();

  $('#trend-legend').innerHTML =
    `<span style="color:#4a9eff">━ 室温</span> &nbsp;
     <span style="color:#f5a623">┄ 设定值</span> &nbsp;
     <span style="color:#8d9bb0">灰底 = 无人</span>`;
  $('#trend-note').textContent = `${showRoom} 最近 ${arr.length} 个采样点`;
}

/* ---------------------------------------------------------------- 对话 */
function addMsg(text, cls) {
  const box = $('#msgs');
  box.insertAdjacentHTML('beforeend', `<div class="msg ${cls}">${esc(text)}</div>`);
  box.scrollTop = box.scrollHeight;
}
function quick(t) { $('#text').value = t; send(); }

function send() {
  const text = $('#text').value.trim();
  if (!text) return;
  $('#text').value = '';
  addMsg(text, 'me');
  const uid = $('#user-sel').value || 'U001';
  const r = agent.chat(text, { userId: uid });
  const cls = r.kind === 'rejected' ? 'bad' : r.kind === 'clarify' ? 'warn' : 'ok';
  const meta = [];
  if (r.validation) meta.push(r.validation);
  if (r.latency_ms != null) meta.push(r.latency_ms + ' ms');
  if (r.intent) meta.push(`${r.intent.action}/${r.intent.attribute || '-'}/${r.intent.direction || '-'}`);
  if (r.reject_reason) meta.push('原因: ' + r.reject_reason);
  if (r.evidence) meta.push('依据: ' + r.evidence);
  addMsg((r.speech || '(无回应)') + (meta.length ? '\n— ' + meta.join(' · ') : ''), 'ai ' + cls);
  refresh();
  loadHabits();
}

/* ---------------------------------------------------------------- 画像 */
function currentUser() { return $('#user-sel').value || 'U001'; }

function loadHabits() {
  const uid = currentUser();
  const consent = agent.store.consent(uid);
  pill($('#p-consent'), consent ? '已授权长期记忆' : '未授权', consent ? 'ok' : 'warn');
  const ms = agent.store.all(uid);
  if (!ms.length) {
    $('#habits').innerHTML = `<span class="sub2">暂无画像。
      ${consent ? '在下面输入一条习惯试试。' : '先点「切换授权」允许长期记忆。'}</span>`;
    return;
  }
  let html = '<table><tr><th>类型</th><th>内容</th><th class="num">置信度</th></tr>';
  for (const m of ms) {
    const p = m.params;
    const txt = p.type === 'schedule'
      ? `${p.day || 'daily'} ${p.start || '?'}~${p.end || '?'}（${p.policy || '-'}）`
      : `${p.attribute || '-'} = ${p.value ?? '-'}${p.tolerance ? ' 容忍 ±' + p.tolerance[1] : ''}`;
    html += `<tr><td>${esc(m.pattern_type)}</td>
      <td>${esc(txt)}${m.evidence ? '<br><span class="sub2">来源: ' + esc(m.evidence) + '</span>' : ''}</td>
      <td class="num">${(m.confidence * 100).toFixed(0)}%</td></tr>`;
  }
  html += '</table>';
  const st = agent.store.stats();
  html += `<div class="kv" style="margin-top:7px"><b>库内统计</b>
    <span>用户 ${st.occupants} · 画像 ${st.memories} · 已授权 ${st.consented}</span></div>`;
  $('#habits').innerHTML = html;
}

function toggleConsent() {
  const uid = currentUser();
  agent.store.setConsent(uid, !agent.store.consent(uid));
  toast(agent.store.consent(uid) ? `${uid} 已授权长期记忆` : `${uid} 已撤销授权（不再提取新习惯）`);
  loadHabits();
}

function addMemory() {
  const uid = currentUser();
  const text = $('#mem-text').value.trim();
  if (!text) { toast('先写一句话'); return; }
  if (!agent.store.consent(uid)) { toast('该住户未授权长期记忆（先点「切换授权」）', 3600); return; }
  const bundle = extractMemories(text, true);
  if (!bundle.memories.length) { toast('这条没能整理成可复用的习惯'); return; }
  agent.store.add(uid, bundle, null, 'rules_v1');
  agent._applyProfileToPrefs();
  $('#mem-text').value = '';
  toast(`已记住 ${bundle.memories.length} 条`);
  loadHabits();
}

function forget() {
  const uid = currentUser();
  if (!confirm(`确定删除 ${uid} 的全部习惯画像？（被遗忘权；不可撤销）`)) return;
  const n = agent.store.forget(uid);
  toast(`已删除 ${n} 条记录（画像/反馈/用户）`);
  loadHabits();
}

/* ---------------------------------------------------------------- 审计 */
function renderAudit(s) {
  const a = s.audit || {};
  $('#audit').innerHTML = `
    <div class="kv"><b>意图总数</b><span>${a.total || 0}</span></div>
    <div class="kv"><b>安全拦截</b><span>${a.rejects || 0} 条</span></div>
    <div class="kv"><b>动作记录</b><span>${a.actions || 0}</span></div>
    <div class="kv"><b>审计链</b><span>${a.chain_ok ? '✅ 完整（未被篡改）' : '❌ 异常'}</span></div>
    <div class="kv"><b>控制器</b><span>${esc(s.controller)}</span></div>
    <div class="kv"><b>CO₂ 阈值</b><span>${BOUNDS.co2_max_ppm} ppm</span></div>`;
  const rows = (agent.validator.audit.intents || []).filter((r) => r.validation !== 'pass').slice(-8).reverse();
  $('#audit-list').innerHTML = rows.length
    ? '<table><tr><th>输入</th><th>结果</th></tr>' + rows.map((r) =>
        `<tr><td>${esc(String(r.raw_input || '').slice(0, 26))}</td>
         <td class="sub2">${esc(r.validation)}<br>${esc(String(r.reject_reason || '').slice(0, 42))}</td></tr>`).join('') + '</table>'
    : '<span class="sub2">暂无拦截记录（试试越界或提示词注入）</span>';
}

function tamperDemo() {
  const rec = agent.validator.audit.records;
  if (!rec.length) { toast('还没有审计记录，先跟它说几句话'); return; }
  const target = rec[Math.floor(rec.length / 2)];
  const before = target.validation;
  target.validation = 'TAMPERED';
  const okNow = agent.validator.audit.verify();
  $('#tamper-note').innerHTML = `把第 ${Math.floor(rec.length / 2)} 条记录的 validation ` +
    `由 <code>${esc(before)}</code> 改为 <code>TAMPERED</code> → 链校验结果：` +
    `<b style="color:${okNow ? 'var(--bad)' : 'var(--ok)'}">${okNow ? '仍然通过（有 bug！）' : '检测到篡改 ✅'}</b>`;
  toast(okNow ? '⚠ 篡改未被发现（异常）' : '✅ 篡改已被审计链发现', 3600);
  refresh();
  // 复原，避免影响后续演示
  target.validation = before;
}

/* ---------------------------------------------------------------- 应急 */
function triggerEmg() {
  const origin = $('#emg-origin').value;
  const st = agent.enterEmergency(origin);
  if (st.error) { $('#emg-out').innerHTML = `<span class="sub2">${esc(st.error)}</span>`; return; }
  const rm = st.routes;
  let html = `<div class="kv"><b>事件</b><span>${esc(st.event_id)} · ${esc(st.type)} · 火源 ${esc(st.origin_room)}</span></div>`;
  html += '<details open><summary>确定性动作（与 AI 无关，先执行）</summary><ul class="tight">' +
          st.actions_taken.map((a) => `<li>${esc(a)}</li>`).join('') + '</ul></details>';
  html += `<div class="kv" style="margin-top:7px"><b>有效路线</b><span>${(rm.valid_routes || []).join(', ') || '（无）'}</span></div>`;
  html += `<div class="kv"><b>分流方案</b><span>${esc(JSON.stringify(rm.assignment))}</span></div>`;
  html += `<div class="kv"><b>出口负载</b><span>${esc(JSON.stringify(rm.exit_load))}</span></div>`;
  if (Object.keys(rm.shelter_in_place || {}).length)
    html += `<div class="kv"><b>就地避险</b><span style="color:var(--warn)">${esc(JSON.stringify(rm.shelter_in_place))}</span></div>`;
  html += '<div class="sub" style="margin:9px 0 4px">引导内容（模型只负责措辞，路线来自上图算法）：</div>';
  for (const g of st.guidance) {
    html += `<div style="border-left:3px solid ${g.validated ? 'var(--ok)' : 'var(--bad)'};padding:2px 0 2px 9px;margin:7px 0">
      <span class="sub2">[${esc(g.profile)}] route=${esc(g.route_id)} 出口=${esc(g.target_exit)} 来源=${esc(g.source)} ${g.validated ? '✅已校验' : '❌未通过'}</span>
      <div>${esc(g.speech)}</div>
      <details><summary>动作步骤</summary><ol class="tight" style="margin-left:16px">${
        g.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></details></div>`;
  }
  $('#emg-out').innerHTML = html;
  toast('已触发演练：' + origin + ' 起火（现在试调温会被互锁拦截）', 4200);
  refresh();
}

function clearEmg() {
  agent.exitEmergency();
  $('#emg-out').innerHTML = '<span class="sub2">已解除应急。</span>';
  toast('已解除应急，恢复正常调节');
  refresh();
}

function tryModelTrigger() {
  const occupancy = {};
  const s = agent.snapshot();
  for (const [rid, r] of Object.entries(s.rooms)) if (r.occupancy) occupancy[rid] = r.occupancy;
  // 直接用 FSM 以"模型身份"触发，验证权限闸门（模型没有 emergency_override）
  const res = new EmergencyFSM().trigger({ originRoom: 'A301', occupancy, actorType: 'model' });
  const msg = res.error
    ? `✅ 被拒绝：${res.error}（唯一允许的身份：${(res.allowed_actors || []).join(', ')}）`
    : '⚠ 竟然通过了（不应发生）';
  $('#emg-out').innerHTML = `<div class="kv"><b>模型身份触发应急</b><span>${esc(msg)}</span></div>`;
  toast(res.error ? '✅ 模型无权触发应急（403 语义）' : '⚠ 异常', 3600);
}

/* ---------------------------------------------------------------- 控制器对照 */
function runCompare() {
  const a = $('#cmp-a').value, b = $('#cmp-b').value;
  if (a === b) { toast('请选择两个不同的控制器'); return; }
  $('#cmp-note').textContent = '运行中…';
  setTimeout(() => {
    const ra = runOne(a), rb = runOne(b);
    const saveE = ra.energy ? (ra.energy - rb.energy) / ra.energy : 0;
    const rows = [['', a, b]]
      .concat([
        ['能耗 kWh', ra.energy.toFixed(2), rb.energy.toFixed(2)],
        ['电费 ¥', ra.cost.toFixed(2), rb.cost.toFixed(2)],
        ['舒适达标率', (ra.comfort * 100).toFixed(1) + '%', (rb.comfort * 100).toFixed(1) + '%'],
        ['手动干预次数', String(ra.overrides), String(rb.overrides)],
        ['平均 CO₂ ppm', ra.co2.toFixed(0), rb.co2.toFixed(0)],
      ]);
    let html = '<table>';
    for (let i = 0; i < rows.length; i++) {
      const [k, x, y] = rows[i];
      const tag = i === 0 ? 'th' : 'td';
      html += `<tr><${tag}>${esc(COMPARE_LABELS[k] || k)}</${tag}><${tag} class="num">${esc(x)}</${tag}><${tag} class="num">${esc(y)}</${tag}></tr>`;
    }
    html += '</table>';
    html += `<div class="sub2" style="margin-top:8px">
      ${esc(COMPARE_LABELS[b])} 相对 ${esc(COMPARE_LABELS[a])}：
      能耗 ${saveE >= 0 ? '低' : '高'} <b style="color:${saveE >= 0 ? 'var(--ok)' : 'var(--bad)'}">${Math.abs(saveE * 100).toFixed(1)}%</b>，
      舒适达标率 ${(rb.comfort * 100).toFixed(1)}% vs ${(ra.comfort * 100).toFixed(1)}%。
      <b>只有舒适达标率接近时，能耗对比才有意义</b>（否则只是在比"谁更不管人"）。</div>`;
    $('#cmp-out').innerHTML = html;
    $('#cmp-note').textContent = '完成（各跑 1 天，seed=42）';
  }, 30);
}

/** 用 JS 侧的 Sim 单独跑一天某控制器（不动主仿真） */
function runOne(kind) {
  // 动态导入避免顶部循环依赖
  const Sim = agent.sim.constructor;
  const sim = new Sim({ seed: 42, startMin: 0, controller: kind });
  // b1s 用更小的回落幅度近似"仅按时间表"（无占空传感时更保守）
  for (let i = 0; i < 1440; i++) sim.step();
  const rooms = Object.values(sim.rooms);
  return {
    energy: sim.energy.total, cost: sim.energy.cost,
    comfort: sim.stats.occupiedSteps ? sim.stats.comfortOk / sim.stats.occupiedSteps : 1,
    overrides: sim.stats.overrides,
    co2: rooms.reduce((a, r) => a + r.co2, 0) / rooms.length,
  };
}

window.addEventListener('resize', drawChart);
boot();
