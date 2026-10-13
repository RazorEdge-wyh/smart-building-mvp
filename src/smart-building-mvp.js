/* ============================================================================
 *  smart-building-mvp.js —— 智慧建筑室内环境小模型 MVP 的**纯前端实现**
 *
 *  用途：让 GitHub Pages 这类静态托管也能完整演示（没有 Python 后端）。
 *  它把 core/ 里的关键逻辑在浏览器里重新实现了一遍：
 *
 *     意图规则解析   ← core/intent.py
 *     七道安全闸门   ← core/safety.py
 *     2R2C 热模型    ← core/simulator.py
 *     控制策略       ← core/controller.py
 *     疏散路网求解   ← core/emergency.py
 *     习惯画像       ← core/memory.py
 *
 *  ★ 设计原则：**移植必须同源**。所有常量、阈值、词表都从 Python 侧原样搬过来，
 *    并且 tools/test_js_port.mjs 会把两边在同一个测试集上跑一遍做对比 —— 
 *    移植走样比不移植更危险（演示看不出问题，但结论是错的）。
 *
 *  模块同时兼容浏览器（全局 SH）与 Node（ESM 导出），便于自动化测试。
 * ========================================================================== */

/* ==========================================================================
 * 0. 配置（与 config/safety_bounds.json、config/building.json 一致）
 * ========================================================================== */
export const BOUNDS = {
  setpoint_min_c: 16.0,
  setpoint_max_c: 30.0,
  max_setpoint_delta_c: 1.0,
  delta_window_min: 10,
  min_equipment_off_time_min: 5,
  co2_max_ppm: 1000.0,
  humidity_min_pct: 30.0,
  humidity_max_pct: 70.0,
  rooms: {
    A301: { min: 20.0, max: 28.0, occupied_only: true, quiet: null },
    A305: { min: 21.0, max: 28.0, occupied_only: false, quiet: [23 * 60, 7 * 60] },
  },
  permissions: {
    resident: ['adjust', 'query', 'cancel', 'schedule'],
    property: ['adjust', 'query', 'schedule', 'bulk_set'],
    fire_system: ['emergency_override'],
    model: ['adjust', 'query', 'schedule', 'reject'],
  },
  emergency: {
    allow_actions: ['emergency_query'],
    allow_devices: ['exhaust_fan', 'smoke_damper', 'door_lock', 'elevator_recall',
                    'emergency_light'],
    deny_devices: ['hvac_comfort', 'curtain_auto', 'lighting_scene'],
    force_unlock_doors: true,
    elevator_recall_to_floor: 1,
  },
};

export const ROOMS = [
  { room_id: 'A301', name: '客厅', area: 28.0, height: 2.8, room_alias: 'living_room',
    C_air: 120000, C_wall: 8000000, R_win: 0.020, R_wall: 0.009, R_infil: 0.045,
    solar_aperture: 3.6, gains_base: 80, gains_person: 110,
    cool_w: 4200, heat_w: 3200, cop: 3.2, T0: 27.5 },
  { room_id: 'A305', name: '卧室', area: 16.0, height: 2.8, room_alias: 'bedroom',
    C_air: 90000, C_wall: 5200000, R_win: 0.024, R_wall: 0.010, R_infil: 0.055,
    solar_aperture: 1.6, gains_base: 45, gains_person: 105,
    cool_w: 2600, heat_w: 2200, cop: 3.0, T0: 27.0 },
];

export const AGENTS = [
  { user_id: 'U001', name: '住户A', profile: 'general', pref: 24.5, tol_low: 1.3,
    tol_high: 0.8, draft: 0.35, compliance: 0.8, override_sens: 1.6,
    schedule: [
      { room: 'A305', arrive: '23:00', minutes: 460, days: ['mon','tue','wed','thu','fri'] },
      { room: 'A301', arrive: '18:40', minutes: 180, days: ['mon','tue','wed','thu','fri'] },
      { room: 'A305', arrive: '22:00', minutes: 90,  days: ['mon','tue','wed','thu','fri'] },
      { room: 'A305', arrive: '00:30', minutes: 480, days: ['sat','sun'] },
      { room: 'A301', arrive: '09:30', minutes: 300, days: ['sat','sun'] },
      { room: 'A301', arrive: '15:00', minutes: 240, days: ['sat','sun'] },
      { room: 'A305', arrive: '22:30', minutes: 90,  days: ['sat','sun'] },
    ] },
  { user_id: 'U002', name: '住户B', profile: 'elderly', pref: 26.0, tol_low: 1.8,
    tol_high: 1.2, draft: 0.8, compliance: 0.6, override_sens: 2.2,
    schedule: [
      { room: 'A305', arrive: '22:30', minutes: 470,
        days: ['mon','tue','wed','thu','fri','sat','sun'] },
      { room: 'A301', arrive: '07:20', minutes: 300,
        days: ['mon','tue','wed','thu','fri','sat','sun'] },
      { room: 'A301', arrive: '13:00', minutes: 270,
        days: ['mon','tue','wed','thu','fri','sat','sun'] },
      { room: 'A305', arrive: '18:00', minutes: 120,
        days: ['mon','tue','wed','thu','fri','sat','sun'] },
    ] },
];

const OUT_ABSENCE_P = { general: 0.10, elderly: 0.16, child: 0.12, mobility_impaired: 0 };
const OUT_UNPLANNED_P = { general: 0.05, elderly: 0.12, child: 0.06, mobility_impaired: 0 };
const ARRIVAL_SIGMA_MIN = 25.0;
const DURATION_SIGMA = 0.18;

const DOW = ['mon','tue','wed','thu','fri','sat','sun'];

/* ==========================================================================
 * 1. 可复现随机数（xorshift128，与 Python 侧同为"固定种子可复现"的语义）
 * ========================================================================== */
export class Rng {
  constructor(seed) { this.s = (seed >>> 0) || 1; }
  next() {                       // [0,1)
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  normal(mu = 0, sigma = 1) {    // Box-Muller
    const u = Math.max(1e-12, this.next()), v = this.next();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** 与 Python random.choices 等价的加权选择 */
  pick(arr) { return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))]; }
}

/* ==========================================================================
 * 2. 意图规则解析（移植 core/intent.py::RuleIntentParser）
 * ========================================================================== */
const ROOM_LEX = {
  living_room: ['客厅', '起居室', '大厅', '堂屋'],
  bedroom: ['卧室', '房间', '睡房', '主卧', '次卧', '卧房'],
  kitchen: ['厨房', '灶间'],
  study: ['书房', '工作室'],
  bathroom: ['卫生间', '浴室', '厕所', '洗手间'],
  meeting_room: ['会议室'], office: ['办公室'], corridor: ['走廊', '过道'],
};
const ATTR_LEX = {
  temperature: ['温度','气温','冷','凉','热','暖','空调','制热','制冷','太冷','太热',
                '保暖','凉快','暖和','冻','暖乎'],
  fresh_air: ['闷','通风','换气','新风','透气','憋','喘不上气','呼吸','空气','空气质量'],
  humidity: ['湿度','干燥','太干','潮','加湿','除湿'],
  light: ['灯','照明','亮','暗','光线','开灯','关灯'],
  curtain: ['窗帘','遮光','百叶'],
  fan: ['风速','吹','风量','档位','噪音','太吵','吵','声音大','静音','安静','风太大','风很大'],
  mode: ['模式','睡眠模式'],
};
const SECURITY_LEX = ['绕过','破解','越权','系统指令','安全限制','直接控制','继电器',
                      '注入','忽略之前','忽略以上'];
const OFFTOPIC = ['股票','股市','天气预','新闻','足球','篮球','彩票','汇率','写代码',
                  '写诗','翻译','算数','你是谁','讲个笑话','编程','订张机票','几点','电影'];

// (触发词, attribute, direction, 说明)
const IMPLICIT_LEX = [
  ['感冒','temperature','warmer','感冒 → 升温并避免直吹'],
  ['发烧','temperature','warmer','发烧 → 升温'],
  ['着凉','temperature','warmer','着凉 → 升温'],
  ['头疼','temperature','warmer','头疼 → 避免强风与低温'],
  ['怕冷','temperature','warmer','明确怕冷'],
  ['运动完','temperature','cooler','运动后 → 降温'],
  ['跑步回来','temperature','cooler','运动后 → 降温'],
  ['出汗','temperature','cooler','出汗 → 降温并加强通风'],
  ['睡觉','temperature','cooler','睡前 → 略降温助眠'],
  ['要睡','temperature','cooler','睡前 → 略降温助眠'],
  ['静音','fan','decrease','要安静 → 降风速'],
  ['安静','fan','decrease','要安静 → 降风速'],
  ['省电',null,null,'节能诉求'],
  ['省点电',null,null,'节能诉求'],
  ['费电',null,null,'节能诉求'],
  ['来客人',null,null,'来客 → 提升舒适度与新风'],
  ['有客人',null,null,'来客 → 提升舒适度与新风'],
  ['花粉','fresh_air','increase','过敏 → 加强过滤与新风'],
  ['过敏','fresh_air','increase','过敏 → 加强过滤与新风'],
];
const NEGATION = ['别','不要','不用','不需要','无需','禁止','不准'];
const DEGREE_RE = /(-?\d+(?:\.\d+)?)\s*(?:度|℃|°C|摄氏)/;

const findFirst = (t, words) => {
  let best = -1, hit = '';
  for (const w of words) {
    const i = t.indexOf(w);
    if (i >= 0 && (best < 0 || i < best)) { best = i; hit = w; }
  }
  return best < 0 ? null : { i: best, w: hit };
};

function detectRoom(t) {
  if (t.includes('全') && (t.includes('屋') || t.includes('部') || t.includes('家'))) return 'all';
  let best = null;
  for (const [room, words] of Object.entries(ROOM_LEX)) {
    for (const w of words) {
      const i = t.indexOf(w);
      if (i < 0) continue;
      // 词长优先（"书房"不能被"房"命中成卧室），同长度取更靠前的
      const key = [-w.length, i];
      if (!best || key[0] < best.k0 || (key[0] === best.k0 && key[1] < best.k1)) {
        best = { k0: key[0], k1: key[1], room };
      }
    }
  }
  return best ? best.room : null;
}

function detectAttr(t) {
  let best = null;
  for (const [attr, words] of Object.entries(ATTR_LEX)) {
    for (const w of words) {
      const i = t.indexOf(w);
      if (i < 0) continue;
      if (!best || i < best.i) best = { i, attr, w };
    }
  }
  return best ? { attr: best.attr, w: best.w } : { attr: null, w: '' };
}

function detectDirection(t, attr) {
  const neg = NEGATION.some(n => t.includes(n));
  const has = re => re.test(t);

  if (attr === 'temperature') {
    if (has(/(太冷|有点冷|好冷|冻|凉了)/)) return 'warmer';
    if (has(/(太热|有点热|好热|闷热|热死)/)) return 'cooler';
    if (has(/(调|设|升|降|高|低|加|减).{0,3}(高|暖|热)/) || has(/(暖|热)(一?点|乎点|和点|点)/))
      return 'warmer';
    if (has(/(调|设|升|降|高|低|加|减).{0,3}(低|凉|冷)/) || has(/(凉|冷)(一?点|快点|点)/))
      return 'cooler';
    if (['升温','加热','暖和','保暖','暖乎'].some(w => t.includes(w))) return 'warmer';
    if (['降温','制冷','凉快'].some(w => t.includes(w))) return 'cooler';
    if (t.includes('冷') && !t.includes('降温')) return 'warmer';
    if (t.includes('热') && !t.includes('加热')) return 'cooler';
    return null;
  }
  if (attr === 'fan') {
    if (has(/风.{0,2}(太大|很大|好大|大了)/)) return 'decrease';
    if (has(/(太吵|好吵|吵死)/)) return 'decrease';
    if (neg && has(/(吹|风)/)) return 'decrease';
    if (has(/(小|弱|低|关)/)) return 'decrease';
    if (has(/(大|强|高|开)/) && !neg) return 'increase';
    return neg ? 'decrease' : null;
  }
  if (attr === 'light' || attr === 'curtain') {
    if (has(/(关|灭|暗|拉上|合上)/)) return 'off';
    if (has(/(开|亮|打开|拉开)/)) return 'on';
    return null;
  }
  if (attr === 'fresh_air') return has(/(关|停|别|不要)/) ? 'decrease' : 'increase';
  if (attr === 'humidity') {
    if (has(/(干|加湿)/)) return 'increase';
    if (has(/(潮|湿|除湿)/)) return 'decrease';
    return null;
  }
  if (attr === 'mode') return (t.includes('自动') || t.includes('睡眠')) ? 'set' : null;
  return null;
}

function extractDuration(t) {
  const tm = /(\d{1,2})\s*[:：点]\s*(\d{1,2})?/.exec(t);
  if (tm && /(待|到|至|点)/.test(t)) {
    const hh = +tm[1], mm = +(tm[2] || 0);
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)
      return { kind: 'until_time', value: `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}` };
  }
  const mn = /(\d+)\s*(分钟|小时)/.exec(t);
  if (mn) return { kind: 'for_minutes', value: mn[2] === '分钟' ? +mn[1] : +mn[1] * 60 };
  if (/(舒服为止|合适为止|直到舒服|调到?舒服|弄舒服)/.test(t))
    return { kind: 'until_comfort', value: null };
  return null;
}

function extractConstraints(t) {
  const c = [];
  if (/(别|不要|不用).{0,4}(对着|直吹|吹到)/.test(t) || /风.{0,3}(太大|大)/.test(t))
    c.push('avoid_direct_draft');
  if (['静音','安静','别吵'].some(w => t.includes(w))) c.push('quiet');
  if (['省电','节能','省点','费电'].some(w => t.includes(w))) c.push('energy_saving');
  return c;
}

function isMemoryStatement(t) {
  if (/(每天|每周|每周[一二三四五六日天]|工作日|周末|一般|通常|我习惯|我总是|我以后|以后都|长期)/.test(t))
    return true;
  if (/(我|咱).{0,4}(怕|喜欢|不喜欢|过敏)/.test(t)) return true;
  if (/(别打扰|不要打扰|勿扰|别提醒我|不要提醒)/.test(t)) return true;
  if (/(先|再|然后).{0,8}(开|关|调|拉)/.test(t) && /(总是|每次|习惯)/.test(t)) return true;
  return false;
}

/** 规则解析：返回 {intent, hits, matched} */
export function parseRules(rawText) {
  const t = String(rawText || '').trim();
  const hits = [];
  const mk = (o) => ({ action: 'reject', confidence: 0.5, room: null, attribute: null,
                       direction: null, target_value: null, duration: null,
                       constraints: [], reason: 'unclear', clarify: null, ...o });
  if (!t) return { intent: mk({ action: 'reject', confidence: 0.9 }), hits, matched: false };

  // 0. 数值（含"零下"）
  const dm = DEGREE_RE.exec(t);
  let target = dm ? parseFloat(dm[1]) : null;
  if (dm) {
    const prefix = t.slice(Math.max(0, dm.index - 3), dm.index);
    if (/(零下|负|minus)/.test(prefix) && target > 0) target = -target;
    hits.push(['target_value', target, dm[0]]);
  }

  // 1. 无关话题
  if (OFFTOPIC.some(w => t.includes(w)))
    return { intent: mk({ action: 'reject', confidence: 0.85,
             clarify: '这个和室内环境没关系，要我帮你调节房间吗？' }), hits, matched: true };

  // 1b. 安全词
  if (SECURITY_LEX.some(w => t.includes(w)))
    return { intent: mk({ action: 'reject', confidence: 0.95,
             clarify: '这类操作不在我的权限范围内。' }), hits, matched: true };

  // 1c. 纯习惯陈述
  if (isMemoryStatement(t) && !detectAttr(t).attr)
    return { intent: mk({ action: 'adjust', confidence: 0.7, room: detectRoom(t),
             attribute: 'schedule', reason: 'user_explicit' }), hits, matched: true };

  // 2. 查询（注意：不要用裸"到"作触发词，"调到24度"会被误判）
  if (/(多少度|几度|是多少|现在.*(温度|状态|情况)|查一下|查查|看一下|怎么样了|什么情况|什么状态|怎么样|显示一下|读一下|读个数)/.test(t)) {
    let a = detectAttr(t).attr;
    if (!a) a = /(空气|质量|CO2|二氧化碳)/i.test(t) ? 'fresh_air'
              : (/湿度|潮/.test(t) ? 'humidity' : 'temperature');
    return { intent: mk({ action: 'query', confidence: 0.9, room: detectRoom(t),
             attribute: a, reason: 'user_explicit' }), hits, matched: true };
  }

  // 3. 取消
  if (/(取消|算了|不用了|撤销|停下)/.test(t))
    return { intent: mk({ action: 'cancel', confidence: 0.85, room: detectRoom(t),
             reason: 'user_explicit' }), hits, matched: true };

  // 4. 调节
  let { attr, w: attrW } = detectAttr(t);
  const tempByNumber = attr !== 'fan' &&
    ((dm && /(温度|度|设|调成|调到|改成|空调)/.test(t)) || /(空调|温度|设成|调成|调到)/.test(t));

  if (!attr) {
    if (tempByNumber) { attr = 'temperature'; attrW = dm ? '度' : '温度语境'; }
    else if (['冷','热','凉','暖','冻'].some(w => t.includes(w))) { attr = 'temperature'; attrW = '感受词'; }
    else {
      const imp = IMPLICIT_LEX.find(([w]) => t.includes(w));
      if (imp) {
        let [, ia, idir, why] = imp;
        if (ia === null) { ia = 'temperature'; idir = imp[0].includes('客') ? 'cooler' : null; }
        hits.push(['attribute', ia, why]);
        if (idir) hits.push(['direction', idir, why]);
        return { intent: mk({ action: 'adjust', confidence: 0.7, room: detectRoom(t),
                 attribute: ia, direction: idir, duration: extractDuration(t),
                 constraints: extractConstraints(t),
                 reason: idir ? 'user_discomfort' : 'unclear',
                 clarify: idir ? null : '你是想调温度，还是通风、照明？' }), hits, matched: true };
      }
      const dur = extractDuration(t), cons = extractConstraints(t);
      if (dur || cons.includes('energy_saving')) {
        hits.push(['attribute', 'temperature', '时长/节能诉求默认温度']);
        return { intent: mk({ action: 'adjust', confidence: 0.65, room: detectRoom(t),
                 attribute: 'temperature', duration: dur, constraints: cons,
                 reason: 'user_explicit' }), hits, matched: true };
      }
      return { intent: mk({ action: 'reject', confidence: 0.35, room: detectRoom(t),
               clarify: '你是想调温度、通风，还是别的？' }), hits, matched: false };
    }
  }
  hits.push(['attribute', attr, attrW || attr]);

  let direction = detectDirection(t, attr);
  if (direction) hits.push(['direction', direction, '方向词']);
  if (attr === 'temperature' && target !== null) {
    direction = 'set';
    hits.push(['direction', 'set', `${target}度`]);
  }
  const constraints = extractConstraints(t);
  if (constraints.length) hits.push(['constraints', constraints, '约束词']);
  let reason = /(冷|热|闷|干|潮|吵|不舒服|难受|感冒|头疼)/.test(t) ? 'user_discomfort' : 'user_explicit';
  if (attr === 'fresh_air') reason = 'air_quality';

  return { intent: mk({
    action: 'adjust', confidence: direction ? 0.85 : 0.6, room: detectRoom(t),
    attribute: attr, direction,
    target_value: (attr === 'temperature' && direction === 'set') ? target : null,
    duration: extractDuration(t), constraints, reason,
    clarify: direction ? null : '你是想更凉一点还是更暖一点？',
  }), hits, matched: true };
}

/* ==========================================================================
 * 3. 契约校验（移植 core/contracts.py 的 validate_schema / validate_physics）
 * ========================================================================== */
export const ACTIONS = ['adjust','query','cancel','reject','schedule'];
export const ATTRIBUTES = ['temperature','fresh_air','humidity','light','curtain','fan',
                           'mode','schedule'];
export const DIRECTIONS = ['warmer','cooler','increase','decrease','set','off','on'];
export const REASONS = ['user_discomfort','user_explicit','schedule_habit',
                        'energy_optimization','air_quality','emergency_override','unclear'];
const ROOM_TYPES = ['living_room','bedroom','kitchen','study','bathroom','meeting_room',
                    'office','corridor','all'];

export function validateSchema(i) {
  if (!ACTIONS.includes(i.action)) return [false, `action '${i.action}' not in ${ACTIONS}`];
  if (!(i.confidence >= 0 && i.confidence <= 1)) return [false, `confidence ${i.confidence} out of [0,1]`];
  if (i.room !== null && i.room !== undefined && !ROOM_TYPES.includes(i.room))
    return [false, `room '${i.room}' not in ${ROOM_TYPES}`];
  if (i.attribute !== null && i.attribute !== undefined && !ATTRIBUTES.includes(i.attribute))
    return [false, `attribute '${i.attribute}' not in ${ATTRIBUTES}`];
  if (i.direction !== null && i.direction !== undefined && !DIRECTIONS.includes(i.direction))
    return [false, `direction '${i.direction}' not in ${DIRECTIONS}`];
  if (!REASONS.includes(i.reason)) return [false, `reason '${i.reason}' not in ${REASONS}`];
  if ((i.constraints || []).length > 3) return [false, 'too many constraints (max 3)'];
  if (i.action === 'adjust' && !i.attribute) return [false, 'missing attribute for adjust'];
  return [true, ''];
}

export function boundsForRoom(roomId) {
  const r = BOUNDS.rooms[roomId];
  if (!r) return { min: BOUNDS.setpoint_min_c, max: BOUNDS.setpoint_max_c };
  return { min: r.min, max: r.max };
}

export function validatePhysics(i, roomId) {
  if (i.action !== 'adjust' || i.attribute !== 'temperature' || i.target_value == null)
    return [true, ''];
  const b = boundsForRoom(roomId);
  if (i.target_value < b.min || i.target_value > b.max)
    return [false, `setpoint ${i.target_value} outside [${b.min},${b.max}]`];
  return [true, ''];
}

export const clampSetpoint = (roomId, v) => {
  const b = boundsForRoom(roomId);
  return Math.min(Math.max(v, b.min), b.max);
};

/* ==========================================================================
 * 4. 安全校验器（移植 core/safety.py 的七道闸门）
 * ========================================================================== */
export const PASS = 'pass';
export const REJECT_SCHEMA = 'reject_schema';
export const REJECT_PERMISSION = 'reject_permission';
export const REJECT_EMERGENCY = 'reject_emergency';
export const REJECT_BOUNDS = 'reject_bounds';
export const REJECT_RATE = 'reject_rate';
export const REJECT_EQUIPMENT = 'reject_equipment';
export const CLARIFY = 'clarify';
const REJECTED = [REJECT_SCHEMA, REJECT_PERMISSION, REJECT_EMERGENCY, REJECT_BOUNDS,
                  REJECT_RATE, REJECT_EQUIPMENT];

function hash16(s) {                       // 与 Python 侧同为"链式哈希"语义（强度可不同）
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c + i, 2246822519) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16);
}
const canonical = (o) => {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
};

/** 只增不改、链式哈希可验伪的审计日志（移植 AuditLog） */
export class AuditLog {
  constructor() { this.records = []; this.intents = []; this.actions = []; this._prev = '0'.repeat(16); }
  static _record(row) {
    const r = {};
    for (const [k, v] of Object.entries(row)) if (k !== 'hash' && k !== 'prev_hash') r[k] = v;
    return r;
  }
  static _digest(prev, payload) { return hash16(prev + canonical(payload)); }
  _append(bucket, row) {
    const payload = AuditLog._record(row);
    const h = AuditLog._digest(this._prev, payload);
    const rec = { ...payload, prev_hash: this._prev, hash: h };
    this._prev = h;
    bucket.push(rec); this.records.push(rec);
    this.seal();        // 每次追加都更新封印，使"事后被删条目"能被发现
    return rec;
  }
  logIntent(row) { return this._append(this.intents, row); }
  logAction(row) { return this._append(this.actions, row); }
  /**
   * 封印当前状态（条数 + 链尾哈希）。
   *
   * 为什么需要：链式哈希能发现"字段被改"，但对"整条被删掉"不敏感 ——
   * 删掉中间一条后，剩余记录的 prev_hash 指针依然自洽，链照样能过。
   * 所以额外记住条数与链尾，删除/截断就能被发现。
   * （真实系统应把封印写到只追加存储或外部锚点，而不是同一个对象里）
   */
  seal() {
    Object.defineProperty(this, '_seal', {
      value: { count: this.records.length, last: this._prev }, enumerable: false,
      configurable: true, writable: true,
    });
    return this._seal;
  }
  verify() {
    const s = this._seal;
    if (s && (this.records.length !== s.count || this._prev !== s.last)) return false;
    return this.verifyDetailed().every(d => d.ok);
  }
  verifyDetailed() {
    let prev = '0'.repeat(16); const out = [];
    for (const row of this.records) {
      const expect = AuditLog._digest(row.prev_hash, AuditLog._record(row));
      const ok = row.prev_hash === prev && expect === row.hash;
      out.push({ prev_ok: row.prev_hash === prev, hash_ok: expect === row.hash, ok });
      prev = row.hash;
    }
    return out;
  }
  stats() {
    const by = {};
    for (const i of this.intents) by[i.validation] = (by[i.validation] || 0) + 1;
    const rejects = Object.entries(by)
      .filter(([k]) => k !== PASS && k !== 'reject_intent')
      .reduce((a, [, v]) => a + v, 0);
    return { total: this.intents.length, actions: this.actions.length, by_result: by,
             rejects, chain_ok: this.verify() };
  }
}

/** 世界状态 + 安全校验器 */
export class SafetyValidator {
  constructor(opts = {}) {
    this.minConfidence = opts.minConfidence ?? 0.45;
    this.emergency = false;
    this.emergencyEvent = {};
    this.setpoints = {};
    this.userChangeHistory = {};   // 只记"用户发起"的变更
    this.audit = opts.audit || new AuditLog();
    this.onEmergencyBlock = opts.onEmergencyBlock || null;
  }
  currentSetpoint(roomId, dflt = 26.0) {
    return this.setpoints[roomId] !== undefined ? this.setpoints[roomId] : dflt;
  }
  syncBaseline(roomId, v) { this.setpoints[roomId] = v; }
  recordSetpoint(roomId, v, tMin, userInitiated = false) {
    this.setpoints[roomId] = v;
    if (userInitiated) {
      const h = this.userChangeHistory[roomId] || (this.userChangeHistory[roomId] = []);
      h.push([tMin, v]);
      while (h.length && tMin - h[0][0] > 60) h.shift();
    }
  }
  resetRateWindow(baseline = {}) {
    this.userChangeHistory = {};
    for (const [k, v] of Object.entries(baseline)) this.setpoints[k] = v;
  }
  /**
   * 防抖口径 —— 与 Python 侧定稿语义一致：
   *   窗口内没有该用户的变更记录 → 第一条指令永远放行；
   *   否则按"已累计变更 + 本次变更"判断。
   * （单次幅度由控制器自己的 max_step 保证，不在这里限制）
   */
  netDeltaWithin(roomId, proposed, windowMin, nowMin) {
    const h = (this.userChangeHistory[roomId] || []).filter(([t]) => t >= nowMin - windowMin);
    if (!h.length) return 0;
    let moved = 0;
    for (let i = 1; i < h.length; i++) moved += Math.abs(h[i][1] - h[i - 1][1]);
    return moved + Math.abs(proposed - h[h.length - 1][1]);
  }
  /** 七道闸门，返回 {result, reason, stage, details} */
  validate(intent, { actorType = 'resident', roomId = 'A301', nowMin = 0 } = {}) {
    // 闸1 Schema
    let [ok, why] = validateSchema(intent);
    if (!ok) return { result: REJECT_SCHEMA, reason: why, stage: 1, details: {} };

    // 闸2 权限
    if (!(BOUNDS.permissions[actorType] || []).includes(intent.action))
      return { result: REJECT_PERMISSION, stage: 2, details: { allowed: BOUNDS.permissions[actorType] },
               reason: `actor '${actorType}' cannot '${intent.action}'` };

    // 闸3 场景互锁（最高优先级）
    if (this.emergency && !BOUNDS.emergency.allow_actions.includes(intent.action))
      return { result: REJECT_EMERGENCY, stage: 3, details: { allow_actions: BOUNDS.emergency.allow_actions },
               reason: 'emergency mode: comfort actions disabled' };

    // 闸4 物理边界
    [ok, why] = validatePhysics(intent, roomId);
    if (!ok) return { result: REJECT_BOUNDS, reason: why, stage: 4, details: {} };

    // 闸5 变更率限幅
    if (intent.action === 'adjust' && intent.attribute === 'temperature' && intent.target_value != null) {
      const net = this.netDeltaWithin(roomId, intent.target_value, BOUNDS.delta_window_min, nowMin);
      if (net > BOUNDS.max_setpoint_delta_c)
        return { result: REJECT_RATE, stage: 5, details: { net_delta: +net.toFixed(3) },
                 reason: `setpoint change rate exceeded (${net.toFixed(2)}℃ > ${BOUNDS.max_setpoint_delta_c}℃/${BOUNDS.delta_window_min}min)` };
    }

    // 闸6 设备保护（演示环境无真实设备，保留闸门语义）
    // 闸7 置信度
    if (intent.confidence < this.minConfidence)
      return { result: CLARIFY, stage: 7, details: { confidence: intent.confidence },
               reason: intent.clarify || '能再说清楚一点吗？' };

    return { result: PASS, reason: '', stage: 8, details: {} };
  }
  /** 意图 → 设备命令（机械映射，不做任何推理） */
  static translate(intent, roomId) {
    const cmd = { target: { room_id: roomId, device_id: `AC_${roomId}` }, command: {},
                  ttl_s: 30, expect_ack: true };
    const c = cmd.command;
    if (intent.action === 'query') c.op = 'read_state';
    else if (intent.action === 'cancel') c.op = 'cancel_pending';
    else if (intent.action === 'adjust') {
      if (intent.attribute === 'temperature') {
        if (intent.target_value != null) { c.op = 'set_setpoint'; c.setpoint = intent.target_value; }
        else if (intent.direction === 'warmer' || intent.direction === 'increase') { c.op = 'nudge_setpoint'; c.delta = +1.0; }
        else if (intent.direction === 'cooler' || intent.direction === 'decrease') { c.op = 'nudge_setpoint'; c.delta = -1.0; }
        c.mode = intent.direction === 'cooler' ? 'cool' : (intent.direction === 'warmer' ? 'heat' : 'auto');
      } else if (intent.attribute === 'fan') {
        c.op = 'set_fan';
        c.fan = (intent.constraints || []).includes('avoid_direct_draft') ? 'low' : 'auto';
      } else if (intent.attribute === 'fresh_air') { c.op = 'set_ventilation'; c.ventilation = 1.5; }
      else if (intent.attribute === 'mode') { c.op = 'set_mode'; c.mode = intent.direction || 'auto'; }
      else c.op = 'noop';
    }
    return cmd;
  }
}

/* ==========================================================================
 * 5. 2R2C 热模型 + 住户 Agent + 控制器（移植 simulator / controller）
 * ========================================================================== */
export function priceTier(minutesOfDay) {
  const h = Math.floor(minutesOfDay / 60);
  if ((h >= 10 && h < 12) || (h >= 14 && h < 19)) return ['peak', 1.30];
  if ((h >= 8 && h < 10) || (h >= 12 && h < 14) || (h >= 19 && h < 22)) return ['flat', 0.85];
  return ['valley', 0.35];
}

export function outdoorTemp(min, seed = 1) {
  const dayPhase = 2 * Math.PI * ((min / 60) - 15) / 24 + Math.PI / 2;
  return 27 + 6 * Math.sin(dayPhase) + 0.4 * Math.sin(min / 97 + seed);
}
export function solarGain(min) {
  const h = (min / 60) % 24;
  if (h < 6 || h > 19) return 0;
  const s = Math.sin(Math.PI * (h - 6) / 13);
  return Math.max(0, 780 * s * (0.7 + 0.3 * Math.sin(min / 53)));
}

/** 房间热状态与一步推进（与 core/simulator.py::RoomThermalModel 同公式） */
export class Sim {
  constructor({ seed = 42, startMin = 19 * 60 + 10, controller = 'b2' } = {}) {
    this.rng = new Rng(seed);
    this.seed = seed;
    this.tMin = startMin;
    this.controllerName = controller;
    this.validator = new SafetyValidator();
    this.rooms = {};
    for (const r of ROOMS) {
      this.rooms[r.room_id] = { spec: r, T: r.T0, Tw: r.T0 + 0.8, rh: 55, co2: 480,
                                mode: 'cool', setpoint: 26.0, fan: 'auto', power: 0 };
    }
    // 住户运行时状态
    this.agents = AGENTS.map(a => ({
      spec: a, inRoom: null, todayPref: a.pref, satSum: 0, satN: 0,
      overrides: 0, complaints: 0, praises: 0,
      offsets: a.schedule.map(() => this.rng.normal(0, ARRIVAL_SIGMA_MIN)),
    }));
    this.lastSp = {}; this.prefer = {};
    this.events = [];
    this.stepCount = 0;
    this.energy = { total: 0, cost: 0 };
    this.stats = { comfortOk: 0, occupiedSteps: 0, overrides: 0, complaints: 0, praises: 0 };
  }

  // ---- 住户作息（含三种现实偏差，与 Python 侧一致）----
  occupantsAt(min) {
    const dow = DOW[Math.floor(min / 1440) % 7];
    const m = ((min % 1440) + 1440) % 1440;
    const out = [];
    for (const ag of this.agents) {
      let planned = null;
      for (let i = 0; i < ag.spec.schedule.length; i++) {
        const ev = ag.spec.schedule[i];
        if (!(ev.days || DOW).includes(dow)) continue;
        const arr = hhmmToMin(ev.arrive) + ag.offsets[i];
        const dur = ev.minutes * (1 + this.rng.normal(0, DURATION_SIGMA) * 0.15);
        const end = arr + dur;
        const inside = arr <= end ? (m >= arr && m < end) : (m >= arr || m < (end % 1440));
        if (inside) { planned = ev.room; break; }
      }
      let room = planned;
      if (planned !== null) {
        if (ag.spec.profile !== 'mobility_impaired' &&
            this.rng.next() < (OUT_ABSENCE_P[ag.spec.profile] ?? 0.1)) room = null;
      } else if (this.rng.next() < (OUT_UNPLANNED_P[ag.spec.profile] ?? 0.05)) {
        room = this.rng.next() < 0.6 ? 'A301' : 'A305';
      }
      if (room) out.push([ag, room]);
    }
    return out;
  }

  // ---- 控制器：minimax 折中 + 无人回落（与 Python 侧同策略）----
  decide(occMap, min) {
    const [, price] = priceTier(min % 1440);
    const out = {};
    for (const rid of Object.keys(this.rooms)) {
      const st = this.rooms[rid];
      const rts = occMap[rid] || [];
      const b = boundsForRoom(rid);
      let target, mode, reason;
      if (rts.length) {
        const prefs = rts.map(([ag]) => ({ p: ag.todayPref, lo: ag.spec.tol_low,
                                           hi: ag.spec.tol_high, w: 1 }));
        const hist = this.prefer[rid] || [];
        if (hist.length) prefs.push({ p: hist.slice(-5).reduce((a, b2) => a + b2, 0) / Math.min(5, hist.length),
                                      lo: 1.2, hi: 1.2, w: 1.6 });
        target = minimaxTarget(prefs);
        mode = st.T > target + 0.1 ? 'cool' : (st.T < target - 0.1 ? 'heat' : 'off');
        reason = `有人：目标 ${target.toFixed(1)}℃（minimax 折中）`;
      } else {
        const setback = this.controllerName === 'b1s' ? 2 : 4;
        target = Math.min(25.0 + setback + (price < 0.5 ? 1 : 0), b.max);
        mode = st.T < target - 0.5 ? 'off' : 'cool';
        reason = `无人：节能回落 ${setback}℃`;
      }
      target = clampSetpoint(rid, target);
      const last = this.lastSp[rid] !== undefined ? this.lastSp[rid] : target;
      const next = Math.round((last + Math.max(-1, Math.min(1, target - last))) * 100) / 100;
      this.lastSp[rid] = next;
      out[rid] = { mode, setpoint: next, fan: st.co2 > BOUNDS.co2_max_ppm ? 'high' : 'auto', reason };
    }
    return out;
  }

  /** 推进 1 分钟，返回本步记录 */
  step() {
    const min = this.tMin;
    const occ = {};
    for (const [ag, room] of this.occupantsAt(min)) (occ[room] || (occ[room] = [])).push([ag, room]);
    // ★ 记住本步占用情况：快照/舒适度判断都要用"每间房是谁在里面"，而不只是人数
    this.occNow = occ;
    const decisions = this.decide(occ, min);
    const tOut = outdoorTemp(min, this.seed);
    const solar = solarGain(min);
    const recs = [];
    let stepEnergy = 0;

    for (const rid of Object.keys(this.rooms)) {
      const st = this.rooms[rid], s = st.spec;
      const d = decisions[rid];
      if (d) { st.mode = d.mode; st.setpoint = d.setpoint; st.fan = d.fan; }
      const n = (occ[rid] || []).length;

      // HVAC 出力（比例调制 + 死区）
      let qHvac = 0, power = 0;
      const dead = 0.3;
      if (st.mode === 'cool') {
        const err = st.T - st.setpoint;
        if (err > -dead) { const f = Math.max(0, Math.min(1, err / 2)); qHvac = s.cool_w * f; power = qHvac / s.cop + 30; }
        else power = 30;
      } else if (st.mode === 'heat') {
        const err = st.setpoint - st.T;
        if (err > -dead) { const f = Math.max(0, Math.min(1, err / 2)); qHvac = -s.heat_w * f; power = -qHvac / (s.cop * 0.95) + 30; }
        else power = 30;
      } else if (st.mode === 'fan') power = 40;

      const qSolar = 0.6 * solar * s.solar_aperture;
      const qInt = s.gains_base + n * s.gains_person;
      const dT = ((tOut - st.T) / s.R_win + (st.Tw - st.T) / s.R_wall +
                  (tOut - st.T) / s.R_infil + qSolar + qInt - qHvac) / s.C_air * 60;
      const dTw = (st.T - st.Tw) / s.R_wall / s.C_wall * 60;
      st.T += dT; st.Tw += dTw;

      // 空气品质：CO₂ 质量平衡
      const vent = (st.mode !== 'off' ? 12 : 3) + (n > 0 ? 6 : 0);
      st.co2 = Math.max(400, Math.min(5000,
        st.co2 + (0.005 * n * 1000 - Math.max(5, vent) * (st.co2 - 420)) / (s.area * s.height * 1000) * 60));
      st.rh = Math.max(20, Math.min(90, st.rh + (62 + 4 * n - st.rh) / 900 * 60));

      // 住户反馈
      let comfortOk = true, override = 0, complaint = 0, praise = 0, worst = 0;
      for (const [ag] of (occ[rid] || [])) {
        const dev = st.T - ag.todayPref;
        let excess = 0;
        if (dev > ag.spec.tol_high) excess = dev - ag.spec.tol_high;
        else if (dev < -ag.spec.tol_low) excess = -dev - ag.spec.tol_low;
        if (excess !== 0) comfortOk = false;
        if (Math.abs(excess) > Math.abs(worst)) worst = excess;
        ag.satSum += Math.max(0, Math.min(1, 1 - Math.abs(excess) / 3));
        ag.satN += 1;
        const p = Math.max(0, Math.min(0.30, (Math.abs(worst) - 0.2) * 0.06 * ag.spec.override_sens));
        if (p > 0 && this.rng.next() < p) {
          override = 1;
          const want = ag.todayPref + (ag.spec.draft > 0.6 ? 0.5 : 0);
          this.prefer[rid] = [...(this.prefer[rid] || []), want].slice(-200);
          this.lastSp[rid] = want;
          this.validator.recordSetpoint(rid, want, min, true);
          st.setpoint = want;
          ag.overrides += 1;
          if (Math.abs(worst) > 1.5) { complaint = 1; ag.complaints += 1; }
          this.events.push({ tMin: min, kind: 'manual_override', room: rid, user: ag.spec.user_id,
                             T: +st.T.toFixed(2), pref: +ag.todayPref.toFixed(2) });
          break;
        }
      }
      if (n > 0) this.validator.syncBaseline(rid, st.setpoint);

      const energy = power * 60 / 3.6e6;
      const [, price] = priceTier(min % 1440);
      stepEnergy += energy;
      this.energy.total += energy;
      this.energy.cost += energy * price;
      if (n > 0) {
        this.stats.occupiedSteps += 1;
        if (comfortOk) this.stats.comfortOk += 1;
      }
      this.stats.overrides += override;
      this.stats.complaints += complaint;
      this.stats.praises += praise;

      recs.push({ room: rid, tMin: min, T: +st.T.toFixed(3), Tw: +st.Tw.toFixed(3),
                  setpoint: +st.setpoint.toFixed(2), mode: st.mode, co2: +st.co2.toFixed(1),
                  rh: +st.rh.toFixed(1), occupancy: n, power: +power.toFixed(1),
                  energy: +energy.toFixed(6), comfortOk, comfortDev: +worst.toFixed(3),
                  override, complaint, praise });
    }
    this.tMin += 1;
    this.stepCount += 1;
    return recs;
  }

  /** 跑 n 分钟，返回最后一步的记录（供实时看板） */
  run(n) {
    let last = null;
    for (let i = 0; i < n; i++) last = this.step();
    return last;
  }

  snapshot() {
    const rooms = {};
    for (const rid of Object.keys(this.rooms)) {
      const st = this.rooms[rid];
      const occN = ((this.occNow || {})[rid] || []).length;
      rooms[rid] = { T_air: st.T, T_wall: st.Tw, rh: st.rh, co2: st.co2, mode: st.mode,
                     setpoint: st.setpoint, fan: st.fan, power_w: st.power,
                     occupancy: occN };
    }
    return { rooms, energy: this.energy, stats: this.stats, tMin: this.tMin };
  }
  /** 某房间当前的住户对象列表（供舒适度与画像使用） */
  occupantsIn(roomId) {
    return ((this.occNow || {})[roomId] || []).map(([ag]) => ag);
  }
  /** 房间的"最大不满"（有人才算） */
  regret(roomId, T) {
    let worst = 0;
    for (const ag of this.occupantsIn(roomId)) {
      const dev = T - ag.todayPref;
      let e = 0;
      if (dev > ag.spec.tol_high) e = dev - ag.spec.tol_high;
      else if (dev < -ag.spec.tol_low) e = -dev - ag.spec.tol_low;
      worst = Math.max(worst, e);
    }
    return worst;
  }
}

function minimaxTarget(prefs) {
  if (!prefs.length) return 25.0;
  if (prefs.length === 1) return prefs[0].p;
  const cands = [];
  for (const p of prefs) for (const d of [-0.5, -0.25, 0, 0.25, 0.5]) cands.push(+(p.p + d).toFixed(2));
  let best = prefs[0].p, bestRegret = Infinity;
  for (const t of [...new Set(cands)].sort((a, b) => a - b)) {
    let regret = 0;
    for (const pr of prefs) {
      const dev = t - pr.p;
      let excess = 0;
      if (dev > pr.hi) excess = dev - pr.hi;
      else if (dev < -pr.lo) excess = -dev - pr.lo;
      regret = Math.max(regret, pr.w * excess);
    }
    if (regret < bestRegret - 1e-9) { bestRegret = regret; best = t; }
  }
  return best;
}

export function hhmmToMin(s) { const [h, m] = String(s).split(':'); return (+h) * 60 + (+(m || 0)); }
export function minToHHMM(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/* ==========================================================================
 * 6. 疏散路网（移植 core/emergency.py）
 * ========================================================================== */
export const TOPOLOGY = {
  nodes: {
    A301: { label: 'A301 客厅', type: 'room' }, A305: { label: 'A305 卧室', type: 'room' },
    B301: { label: 'B301 客厅', type: 'room' }, B305: { label: 'B305 卧室', type: 'room' },
    C_corr: { label: '东侧走廊', type: 'corridor' }, W_corr: { label: '西侧走廊', type: 'corridor' },
    N_corr: { label: '北侧走廊', type: 'corridor' },
    stair_e: { label: '东侧楼梯间', type: 'stair' }, stair_w: { label: '西侧楼梯间', type: 'stair' },
    exit_e: { label: '东侧安全出口', type: 'exit' }, exit_w: { label: '西侧安全出口', type: 'exit' },
  },
  edges: [['A301','N_corr',4],['A305','N_corr',3],['B301','C_corr',5],['B305','C_corr',3.5],
          ['N_corr','W_corr',12],['N_corr','C_corr',12],['W_corr','stair_w',2],
          ['C_corr','stair_e',2],['stair_w','exit_w',9],['stair_e','exit_e',9]],
  exits: ['exit_e', 'exit_w'],
  speed: { room: 1.2, corridor: 1.3, stair: 0.6, exit: 1.3 },
};
const BLOCKED_WORDS = {
  C_corr: ['东侧走廊','东走廊','东边走廊'], W_corr: ['西侧走廊','西走廊','西边走廊'],
  N_corr: ['北侧走廊','北走廊'], stair_e: ['东侧楼梯','东楼梯'], stair_w: ['西侧楼梯','西楼梯'],
};
const FORBIDDEN_PROMISES = ['绝对安全','保证安全','一定没事','肯定能出去','绝对没事',
                            '保证没事','百分之百安全','万无一失'];

export class EvacuationSolver {
  constructor(topo = TOPOLOGY) {
    this.nodes = topo.nodes; this.exits = topo.exits; this.speed = topo.speed;
    this.adj = {};
    for (const n of Object.keys(this.nodes)) this.adj[n] = [];
    for (const [a, b, d] of topo.edges) { this.adj[a].push([b, d]); this.adj[b].push([a, d]); }
    this.HAZARD_PENALTY = 6.0;
  }
  _time(a, b, dist, danger) {
    const va = this.speed[this.nodes[a]?.type || 'corridor'];
    const vb = this.speed[this.nodes[b]?.type || 'corridor'];
    let t = dist / Math.max(0.1, Math.min(va, vb));
    if (danger.has(a) || danger.has(b)) t *= this.HAZARD_PENALTY;
    return t;
  }
  shortest(src, dst, blocked, danger) {
    if (blocked.has(src) || blocked.has(dst) || !this.adj[src] || !this.adj[dst]) return null;
    const dist = { [src]: 0 }, time = { [src]: 0 }, prev = {};
    const seen = new Set();
    const pq = [[0, src]];
    while (pq.length) {
      pq.sort((x, y) => x[0] - y[0]);
      const [, u] = pq.shift();
      if (seen.has(u)) continue;
      seen.add(u);
      if (u === dst) break;
      for (const [v, d] of this.adj[u]) {
        if (blocked.has(v)) continue;
        const nt = time[u] + this._time(u, v, d, danger);
        if (nt < (time[v] ?? Infinity)) {
          time[v] = nt; dist[v] = dist[u] + d; prev[v] = u;
          pq.push([nt, v]);
        }
      }
    }
    if (time[dst] === undefined) return null;
    const path = [dst];
    while (path[path.length - 1] !== src) path.push(prev[path[path.length - 1]]);
    path.reverse();
    return { path, dist: dist[dst], time: time[dst] };
  }
  solve({ occupancy, originRoom = null, blockedNodes = [] }) {
    const blocked = new Set(blockedNodes);
    const danger = new Set();
    if (originRoom) {
      danger.add(originRoom); blocked.add(originRoom);
      for (const [v] of this.adj[originRoom] || []) danger.add(v);
    }
    const routes = []; let rid = 0;
    const shelter = {}; const feasible = {};
    for (const [room, n] of Object.entries(occupancy)) {
      if (!n || !this.adj[room]) continue;
      if (room === originRoom) { shelter[room] = n; continue; }
      const cands = [];
      for (const ex of this.exits) {
        if (blocked.has(ex) || danger.has(ex)) continue;
        const got = this.shortest(room, ex, blocked, danger);
        if (!got) continue;
        const expo = got.path.filter(x => danger.has(x)).length;
        cands.push({ ex, ...got, expo });
      }
      cands.sort((a, b) => (a.time - b.time) || (a.expo - b.expo));
      if (!cands.length) continue;
      feasible[room] = cands;
      for (const c of cands) { rid += 1; routes.push({ route_id: `r${rid}`, from: room, to: c.ex,
        path: c.path, dist: +c.dist.toFixed(1), time: +c.time.toFixed(1), expo: c.expo }); }
    }
    if (!Object.keys(feasible).length)
      return { valid_routes: [], assignment: {}, route_objects: [], shelter_in_place: shelter,
               exit_load: {}, blocked: [...blocked], danger: [...danger],
               notes: 'no feasible route' };

    const assignment = {}; const exitLoad = {};
    for (const ex of this.exits) exitLoad[ex] = 0;
    const roomsSorted = Object.keys(feasible).sort((a, b) => occupancy[b] - occupancy[a]);
    for (const room of roomsSorted) {
      let best = null, bestScore = Infinity;
      for (const c of feasible[room]) {
        const score = c.time * (1 + (exitLoad[c.ex] || 0) / 60) * (1 + c.expo);
        if (score < bestScore) { bestScore = score; best = c; }
      }
      if (!best) continue;
      const r = routes.find(x => x.from === room && x.to === best.ex);
      assignment[room] = r.route_id;
      exitLoad[r.to] = (exitLoad[r.to] || 0) + occupancy[room];
    }
    for (const r of routes) r.load = Object.values(assignment).includes(r.route_id)
      ? exitLoad[r.to] : 0;
    const valid = routes.filter(r => assignment[r.from] === r.route_id);
    return { valid_routes: valid.map(r => r.route_id), assignment,
             route_objects: valid, shelter_in_place: shelter, exit_load: exitLoad,
             blocked: [...blocked], danger: [...danger],
             notes: `${valid.length} routes / ${Object.values(shelter).reduce((a, b) => a + b, 0)} 就地避险` };
  }
}

const TEMPLATES = {
  general: { prefix: '请立即撤离。', steps: ['离开房间，关好房门','沿指示方向前进','进入楼梯间后向下','到达一层后从安全出口离开'],
             notes: ['不要乘坐电梯','低姿前进，用湿毛巾捂住口鼻'] },
  elderly: { prefix: '别着急，我一步步带您走。', steps: ['扶好扶手，慢慢走','不要跑，注意脚下','沿这段路直走','到楼梯间扶栏杆向下','到一层从出口离开'],
             notes: ['千万不要乘电梯','需要帮助就大声喊，会有人来'] },
  staff: { prefix: '启动应急预案。', steps: ['确认本区域人员已撤离','检查无障碍房间','引导人群分流到两个出口','向指挥中心报告人数'],
           notes: ['优先协助老人与行动不便者','确认防火门已关闭'] },
  child: { prefix: '跟着指示走，你很安全。', steps: ['拉住大人的手','不要躲进房间','沿着亮着的指示牌走','跟着大人下楼'], notes: ['不要坐电梯'] },
};

/** 引导生成 + 硬校验（路线合法性来自路网，模型只负责措辞） */
export function generateGuidance(solved, profiles = ['general','elderly','staff']) {
  const validIds = new Set(solved.valid_routes);
  const byId = Object.fromEntries(solved.route_objects.map(r => [r.route_id, r]));
  const ordered = [...solved.route_objects].sort((a, b) => a.time - b.time);
  const groups = {};
  for (const r of ordered) (groups[r.to] || (groups[r.to] = [])).push(r);
  const exits = Object.keys(groups).sort((a, b) =>
    groups[b].reduce((s, x) => s + x.load, 0) - groups[a].reduce((s, x) => s + x.load, 0));

  const out = [];
  profiles.forEach((profile, i) => {
    if (!exits.length) return;
    const ex = exits[i % exits.length];
    const pick = groups[ex][0];
    const tmpl = TEMPLATES[profile] || TEMPLATES.general;
    const exitLabel = TOPOLOGY.nodes[pick.to]?.label || pick.to;
    const first = TOPOLOGY.nodes[pick.path[1]]?.label || pick.path[1];
    const steps = [...tmpl.steps];
    steps[0] = `${tmpl.steps[0]}，朝「${first}」方向`;
    const notes = [...tmpl.notes];
    const blockedNames = (solved.blocked || []).filter(n => BLOCKED_WORDS[n])
      .map(n => BLOCKED_WORDS[n][0]);
    if (blockedNames.length) notes.unshift(`${blockedNames.join('、')}已经不能通行，请勿前往`);
    const speech = `${tmpl.prefix}请前往${exitLabel}，预计${Math.round(pick.time)}秒。${notes.slice(0,2).join('；')}。`;
    const item = { route_id: pick.route_id, target_exit: pick.to, steps,
                   speech: speech.slice(0, 400), profile, source: 'template', validated: false };
    const [ok, why] = validateGuidance(item, validIds, solved);
    item.validated = ok; item.reject_reason = why;
    if (!ok) {   // 校验失败 → 退化到预置兜底广播（永不失败）
      const fb = `请立即撤离。沿疏散指示前往${exitLabel}，不要乘坐电梯，保持低姿，捂住口鼻。`;
      out.push({ route_id: pick.route_id, target_exit: pick.to, steps,
                 speech: fb, profile, source: 'fallback', validated: true,
                 reject_reason: why });
    } else out.push(item);
  });

  // 火源房间：就地避险（不安排外逃）
  for (const [room, n] of Object.entries(solved.shelter_in_place || {})) {
    const label = TOPOLOGY.nodes[room]?.label || room;
    out.push({ route_id: 'none', target_exit: 'shelter_in_place',
      steps: ['关紧房门，用湿毛巾或床单封住门缝','退到窗户或阳台一侧，保持低姿',
              '拨打119报出你的房间号与他人数量','在窗边挥手示意，等待消防救援'],
      speech: `${label}内的人员请留在房间内不要外出。关紧房门，用湿毛巾封住门缝，退到窗边低姿等待救援，并拨打119说明你在${label}。`,
      profile: 'general', source: 'template', validated: true, shelter: true });
  }
  return out;
}

/** ★ 硬校验：任何一条不过就丢弃该引导 */
export function validateGuidance(item, validIds, solved) {
  if (item.route_id !== 'none' && !validIds.has(item.route_id))
    return [false, `hallucinated route_id '${item.route_id}' not in valid set`];
  if (item.steps.length < 2 || item.steps.length > 8)
    return [false, `steps count ${item.steps.length} out of [2,8]`];
  if (!item.speech || item.speech.length > 400) return [false, 'speech empty or too long'];
  for (const bad of FORBIDDEN_PROMISES)
    if (item.speech.includes(bad)) return [false, `unsafe absolute promise: ${bad}`];
  const idx = item.speech.indexOf('电梯');
  if (idx >= 0) {
    const ctx = item.speech.slice(Math.max(0, idx - 6), idx + 6);
    if (!/(不要|禁止|不能|切勿|别)/.test(ctx)) return [false, 'suggests using the elevator'];
  }
  for (const node of solved.blocked || []) {
    for (const w of BLOCKED_WORDS[node] || []) {
      const i = item.speech.indexOf(w);
      if (i >= 0) {
        const ctx = item.speech.slice(Math.max(0, i - 8), i + 4);
        if (!/(不要|禁止|不能|切勿|别|已经不能|请勿)/.test(ctx))
          return [false, `leads people into blocked passage: ${w}`];
      }
    }
  }
  return [true, ''];
}

export class EmergencyFSM {
  constructor(solver = new EvacuationSolver()) { this.solver = solver; this.state = { active: false }; }
  trigger({ originRoom, occupancy, type = 'fire', actorType = 'fire_system' }) {
    if (!(BOUNDS.permissions[actorType] || []).includes('emergency_override'))
      return { error: `actor '${actorType}' has no emergency_override permission`,
               allowed_actors: Object.keys(BOUNDS.permissions)
                 .filter(k => BOUNDS.permissions[k].includes('emergency_override')) };
    const solved = this.solver.solve({ occupancy, originRoom });
    const guidance = generateGuidance(solved);
    this.state = {
      active: true, type, origin_room: originRoom, event_id: `E${Date.now()}`,
      actions_taken: ['解锁所有疏散门与门禁','电梯归位至一层并停用','启动排烟风机与防火阀联动',
                      '停止所有舒适性空调调节','启动声光报警与应急照明'],
      routes: solved, guidance,
    };
    return this.state;
  }
  clear() { this.state = { active: false }; return this.state; }
}

/* ==========================================================================
 * 7. 习惯画像（移植 core/memory.py 的规则提取器；存储用 localStorage）
 * ========================================================================== */
const MEM_SCHEDULE = /(每?(?:周|星期)([一二三四五六日天])|每天|工作日|周末)/;
const NUM_CN = '二十四|二十三|二十二|二十一|二十|十九|十八|十七|十六|十五|十四|十三|十二|十一|十|九|八|七|六|五|四|三|二|一|零';
const TIME_TOKEN = new RegExp(`(?:([上下晚])午|([上下晚]))?\\s*(\\d{1,2}|${NUM_CN})\\s*(?::\\s*(\\d{2})|点\\s*(\\d{1,2}|半|${NUM_CN})?)`, 'g');
const DOW_CN = { 一:'mon', 二:'tue', 三:'wed', 四:'thu', 五:'fri', 六:'sat', 日:'sun', 天:'sun' };

function cn2int(s) {
  if (!s) return null;
  if (s === '半') return 30;
  if (/^\d+$/.test(s)) return +s;
  const d = { 零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9 };
  if (s.length === 1) return d[s] ?? null;
  if (s.includes('十')) {
    const [head, tail] = s.split('十');
    const tens = head ? (d[head] ?? 1) : 1;
    const ones = tail ? (d[tail] ?? 0) : 0;
    return tens * 10 + ones;
  }
  return null;
}
function toHHMM(period, hh, mm) {
  let h = cn2int(hh); if (h === null) return null;
  let mi = cn2int(mm) ?? 0;
  if (mi > 59) mi = 0;
  if ((period === '下' || period === '晚') && h < 12) h += 12;
  if (period === '上' && h === 12) h = 0;
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return `${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}`;
}
/** 作息提取：先找日期词，再独立扫描时间标记（允许 23:30 与 早上7点 混用） */
export function extractSchedule(t) {
  const dm = MEM_SCHEDULE.exec(t);
  if (!dm) return null;
  const raw = dm[1];
  const day = raw.includes('每天') ? 'daily' : raw.includes('工作日') ? 'weekday'
            : raw.includes('周末') ? 'weekend' : (DOW_CN[dm[2]] || 'daily');
  const toks = [];
  TIME_TOKEN.lastIndex = 0;
  let m;
  while ((m = TIME_TOKEN.exec(t))) {
    const seg = t.slice(Math.max(0, m.index - 2), m.index);
    let period = seg.includes('晚') ? '晚' : seg.includes('下午') ? '下'
               : (seg.includes('早上') || seg.includes('上午')) ? '上' : (m[1] || m[2] || null);
    const hhmm = toHHMM(period, m[3], m[4] || m[5]);
    if (hhmm) toks.push({ start: m.index, end: m.index + m[0].length, raw: m[0].trim(), hhmm, period });
  }
  if (toks.length < 2) return null;
  for (let i = 0; i < toks.length - 1; i++) {
    const gap = t.slice(toks[i].end, toks[i + 1].start);
    if (/[到至~\-—]/.test(gap)) {
      let end = toks[i + 1].hhmm;
      const [eh, em] = end.split(':').map(Number);
      const [sh, sm] = toks[i].hhmm.split(':').map(Number);
      if ((eh * 60 + em) <= (sh * 60 + sm) && !toks[i + 1].period &&
          (toks[i].period === '下' || toks[i].period === '晚' || sh * 60 + sm >= 720)) {
        const h2 = eh < 12 ? eh + 12 : eh;
        end = `${String(h2).padStart(2,'0')}:${String(em).padStart(2,'0')}`;
      }
      return { day, start: toks[i].hhmm, end, raw: t.slice(toks[i].start, toks[i + 1].end) };
    }
  }
  return null;
}

const PREF_LEX = [
  [['怕风','别吹','不要吹','怕吹','对风敏感'], 'fan', 'avoid_direct_draft'],
  [['喜欢暗','怕光','不要太亮'], 'light', 'dim'],
  [['怕冷','怕凉'], 'temperature', 'warmer'],
  [['怕热','怕闷'], 'temperature', 'cooler'],
  [['喜欢安静','怕吵'], 'fan', 'quiet'],
  [['过敏','鼻炎','花粉'], 'fresh_air', 'high_filtration'],
  [['省电','节能','想省点'], 'energy', 'energy_saving'],
];
const POLICY_LEX = [
  [['别打扰','不要打扰','别吵我','勿扰','别提醒'], 'do_not_disturb'],
  [['随时','你看着办','都可以'], 'auto'],
  [['问我','先问我'], 'ask_first'],
  [['不要自动','别自动','永远不要'], 'never'],
];
const FACT_LEX = [
  [['感冒','发烧','咳嗽'], 'health', '感冒中，需升温并避免直吹'],
  [['老人','爷爷','奶奶','父母'], 'household', '家中有老人，设定值不宜过低'],
  [['婴儿','宝宝','小孩','孩子'], 'household', '家中有儿童，避免强风与低温'],
];

/** 规则提取长期习惯（与 Python 侧同一套词表与优先级） */
export function extractMemories(text, consent = true) {
  const t = String(text || '').trim();
  if (!t) return { memories: [], consent_required: false };
  if (!consent) return { memories: [], consent_required: true };
  const mems = [];
  const sched = extractSchedule(t);
  if (sched) mems.push({ type: 'schedule', day: sched.day, start: sched.start, end: sched.end,
                         attribute: null, value: 'activity', policy: 'do_not_disturb',
                         evidence: t.slice(0, 80), confidence: 0.85 });
  const tm = /(\d{2}(?:\.\d)?)\s*(?:度|℃)/.exec(t);
  if (tm && /(喜欢|习惯|舒服|一般|通常|偏好)/.test(t)) {
    const v = parseFloat(tm[1]);
    if (v >= 15 && v <= 32) mems.push({ type: 'preference', attribute: 'temperature',
      value: v, tolerance: [v - 1.5, v + 1.5], day: null, start: null, end: null,
      policy: null, evidence: t.slice(0, 80), confidence: 0.9 });
  }
  for (const [words, attr, value] of PREF_LEX) {
    if (words.some(w => t.includes(w))) {
      mems.push({ type: 'preference', attribute: attr, value, day: null, start: null,
                  end: null, policy: null, evidence: words[0], confidence: 0.8 });
      break;
    }
  }
  for (const [words, policy] of POLICY_LEX) {
    if (words.some(w => t.includes(w))) {
      if (mems.length) mems[mems.length - 1].policy = policy;
      else mems.push({ type: 'preference', attribute: 'interaction', value: policy,
                       policy, day: null, start: null, end: null, evidence: words[0],
                       confidence: 0.7 });
      break;
    }
  }
  for (const [words, attr, value] of FACT_LEX) {
    if (words.some(w => t.includes(w))) {
      mems.push({ type: 'fact', attribute: attr, value, day: null, start: null, end: null,
                  policy: null, evidence: words[0], confidence: 0.85 });
      break;
    }
  }
  const seen = new Set(); const uniq = [];
  for (const m of mems) {
    const k = `${m.type}|${m.attribute}|${m.value}|${m.day}|${m.start}`;
    if (seen.has(k)) continue;
    seen.add(k); uniq.push(m);
  }
  return { memories: uniq.slice(0, 5), consent_required: false };
}

/** 画像库：localStorage 持久化（可删除 —— 对应"被遗忘权"） */
export class MemoryStore {
  constructor(key = 'smart-building-mvp.memory') {
    this.key = key;
    this.data = { users: {}, memories: [], feedback: [] };
    this.load();
  }
  load() {
    try {
      const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(this.key);
      if (raw) this.data = JSON.parse(raw);
    } catch { /* 隐私模式等场景忽略 */ }
    for (const u of Object.keys(this.data.users || {})) {
      if (this.data.users[u].consent === undefined) this.data.users[u].consent = false;
    }
  }
  save() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(this.key, JSON.stringify(this.data));
    } catch { /* 忽略 */ }
  }
  ensureUser(uid, name = '', profile = 'general', consent = false) {
    if (!this.data.users[uid]) this.data.users[uid] = { name: name || uid, profile, consent };
    return this.data.users[uid];
  }
  consent(uid) { return !!this.data.users[uid]?.consent; }
  setConsent(uid, v) { this.ensureUser(uid); this.data.users[uid].consent = !!v; this.save(); }
  add(uid, bundle, roomId = null, source = 'rules') {
    this.ensureUser(uid);
    const ids = [];
    for (const m of bundle.memories) {
      const rec = { id: `m${Date.now()}${Math.floor(Math.random() * 1000)}`, user_id: uid,
                    room_id: roomId, pattern_type: m.type, params: m, evidence: m.evidence,
                    confidence: m.confidence, source, created: Date.now() };
      this.data.memories.push(rec); ids.push(rec.id);
    }
    this.save(); return ids;
  }
  all(uid = null) {
    return this.data.memories.filter(m => !uid || m.user_id === uid)
      .sort((a, b) => b.confidence - a.confidence);
  }
  preference(uid, roomId = null) {
    const list = this.all(uid).filter(m => m.pattern_type === 'preference' &&
      m.params.attribute === 'temperature' && typeof m.params.value === 'number');
    return list.length ? list[0].params.value : null;
  }
  scheduleNow(uid, tMin) {
    const dow = DOW[Math.floor(tMin / 1440) % 7];
    const cur = minToHHMM(tMin);
    return this.all(uid).filter(m => {
      if (m.pattern_type !== 'schedule') return false;
      const p = m.params, day = p.day || 'daily';
      if (day !== 'daily' && day !== dow &&
          !(day === 'weekday' && ['mon','tue','wed','thu','fri'].includes(dow)) &&
          !(day === 'weekend' && ['sat','sun'].includes(dow))) return false;
      if (!p.start || !p.end) return false;
      const s = hhmmToMin(p.start), e = hhmmToMin(p.end), c = hhmmToMin(cur);
      return s <= e ? (c >= s && c < e) : (c >= s || c < e);
    });
  }
  /** 被遗忘权：级联删除 */
  forget(uid) {
    const before = this.data.memories.length + this.data.feedback.length +
                   (this.data.users[uid] ? 1 : 0);
    this.data.memories = this.data.memories.filter(m => m.user_id !== uid);
    this.data.feedback = this.data.feedback.filter(f => f.user_id !== uid);
    delete this.data.users[uid];
    this.save();
    return before - (this.data.memories.length + this.data.feedback.length +
                     (this.data.users[uid] ? 1 : 0));
  }
  stats() {
    const by = {};
    for (const m of this.data.memories) by[m.pattern_type] = (by[m.pattern_type] || 0) + 1;
    return { occupants: Object.keys(this.data.users).length,
             memories: this.data.memories.length, by_type: by,
             consented: Object.values(this.data.users).filter(u => u.consent).length };
  }
}

/* ==========================================================================
 * 8. 顶层：把上面全部串成一个可交互的"建筑智能体"
 * ========================================================================== */
export class BuildingAgent {
  constructor({ seed = 42, startMin = 19 * 60 + 10, controller = 'b2',
                store = null } = {}) {
    this.sim = new Sim({ seed, startMin, controller });
    this.validator = this.sim.validator;
    this.store = store || new MemoryStore();
    this.currentRoom = 'A301';
    this.activeUser = 'U001';
    this.log = [];
    this.store.ensureUser('U001', '住户A', 'general', true);
    this.store.ensureUser('U002', '住户B', 'elderly', true);
    // 让"用户偏好"实际影响控制：把画像里学到的偏好并入控制器的在线偏好
    this._applyProfileToPrefs();
  }
  _applyProfileToPrefs() {
    for (const uid of ['U001', 'U002']) {
      const v = this.store.preference(uid, null);
      if (typeof v === 'number' && this.sim.prefer[this.currentRoom]?.includes(v) !== true) {
        (this.sim.prefer[this.currentRoom] || (this.sim.prefer[this.currentRoom] = [])).push(v);
      }
    }
  }

  /** 一拍的实时推进（供看板循环调用）；记录本步以便快照读取占用 */
  tick(minutes = 1) {
    let last = null;
    for (let i = 0; i < minutes; i++) last = this.sim.step();
    this._lastRecs = last;
    return { records: last, snapshot: this.snapshot() };
  }

  snapshot() {
    const s = this.sim.snapshot();
    const rooms = {};
    for (const rid of Object.keys(s.rooms)) {
      const r = s.rooms[rid];
      const occ = this.sim.occupantsIn(rid);
      const regret = this.sim.regret(rid, r.T_air);
      rooms[rid] = {
        T_air: +r.T_air.toFixed(2), T_wall: +r.T_wall.toFixed(2), rh: +r.rh.toFixed(1),
        co2: Math.round(r.co2), mode: r.mode, setpoint: +r.setpoint.toFixed(2), fan: r.fan,
        power_w: Math.round(r.power_w), occupancy: occ.length,
        occupants: occ.map(a => a.spec.user_id),
        name: ROOMS.find(x => x.room_id === rid)?.name || rid,
        bounds: boundsForRoom(rid),
        regret: +regret.toFixed(3),
        comfort: occ.length === 0 ? 'unoccupied'
               : regret <= 0.2 ? 'comfortable'
               : regret <= 1.0 ? 'slightly_off' : 'uncomfortable',
      };
    }
    const [tier, price] = priceTier(this.sim.tMin % 1440);
    return {
      ts: minToHHMM(this.sim.tMin), sim_time: minToHHMM(this.sim.tMin), rooms,
      day_index: Math.floor(this.sim.tMin / 1440) + 1,
      dow: DOW[Math.floor(this.sim.tMin / 1440) % 7],
      energy: { total_kwh: +s.energy.total.toFixed(3), cost_yuan: +s.energy.cost.toFixed(2) },
      stats: { comfort_ok_rate: s.stats.occupiedSteps ? s.stats.comfortOk / s.stats.occupiedSteps : 1,
               overrides: s.stats.overrides, occupied_steps: s.stats.occupiedSteps },
      price_tier: tier, price,
      outdoor_temp: +outdoorTemp(this.sim.tMin, this.sim.seed).toFixed(1),
      solar: Math.round(solarGain(this.sim.tMin)),
      audit: this.validator.audit.stats(),
      memory: this.store.stats(),
      emergency: this.validator.emergency,
      controller: this.sim.controllerName,
      occupied_total: Object.values(rooms).reduce((a, r) => a + r.occupancy, 0),
    };
  }

  /** 自然语言入口：解析 → 安全校验 → 执行 → 审计（与后端同一顺序） */
  chat(text, { userId = null, roomId = null } = {}) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const uid = userId || this.activeUser;
    const { intent, hits, matched } = parseRules(text);

    // 房间解析：语义标签 → 物理房间号
    let room = roomId || this.currentRoom;
    if (!roomId && intent.room) room = this._resolveRoom(intent.room, room);
    this.currentRoom = room;
    const evidence = hits.map(([f, v, w]) => `${f}=${v}@${w}`).join('; ');

    const base = { intent, validation: PASS, reject_reason: '', evidence,
                   latency_ms: +(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(2)) };

    // 与室内环境无关 / 越权 → 直接回应，不进校验器
    if (intent.action === 'reject') {
      this.validator.audit.logIntent({ intent_id: rid(), time: this.sim.tMin, actor_type: 'model',
        room_id: room, raw_input: text, model_version: 'rules_v1',
        validation: 'reject_intent', reject_reason: intent.reason, intent });
      return { ...base, kind: 'rejected', ok: false, validation: 'reject_intent',
               reject_reason: 'not an environment control intent',
               speech: intent.clarify || '这个我不太确定，你是想调节房间环境吗？' };
    }
    if (intent.action === 'query') {
      this.validator.audit.logIntent({ intent_id: rid(), time: this.sim.tMin, actor_type: 'model',
        room_id: room, raw_input: text, model_version: 'rules_v1', validation: PASS,
        reject_reason: '', intent });
      return { ...base, kind: 'query', ok: true, speech: this._describe(room) };
    }
    if (intent.action === 'cancel') {
      return { ...base, kind: 'query', ok: true, speech: '好的，已取消之前的调整。' };
    }

    // "我有点冷"这类无数值诉求 → 按画像偏好转成具体设定值
    if (intent.action === 'adjust' && intent.attribute === 'temperature' &&
        intent.target_value == null && ['warmer','cooler'].includes(intent.direction)) {
      const pref = this.store.preference(uid, room);
      const base2 = typeof pref === 'number' ? pref : 25.0;
      intent.target_value = Math.round((base2 + (intent.direction === 'warmer' ? 1 : -1)) * 10) / 10;
      intent.direction = 'set';
    }

    // 安全校验（先把状态基线对齐到控制器真实目标，否则限幅会算错）
    for (const [rid2, sp] of Object.entries(this.sim.lastSp)) this.validator.syncBaseline(rid2, sp);
    const verdict = this.validator.validate(intent, { actorType: 'resident', roomId: room,
                                                      nowMin: this.sim.tMin });

    if (REJECTED.includes(verdict.result)) {
      this.validator.audit.logIntent({ intent_id: rid(), time: this.sim.tMin, actor_type: 'resident',
        room_id: room, raw_input: text, model_version: 'rules_v1', validation: verdict.result,
        reject_reason: verdict.reason, intent });
      this.log.push({ tMin: this.sim.tMin, text, result: verdict.result });
      return { ...base, kind: 'rejected', ok: false, validation: verdict.result,
               reject_reason: verdict.reason, speech: this._explainRejection(verdict, room) };
    }
    if (verdict.result === CLARIFY) {
      return { ...base, kind: 'clarify', ok: false, validation: CLARIFY,
               reject_reason: verdict.reason, speech: verdict.reason };
    }

    // 执行（意图 → 命令 → 改设定值）
    const intentId = rid();
    const cmd = SafetyValidator.translate(intent, room);
    let applied = null;
    const c = cmd.command;
    if (c.op === 'set_setpoint') applied = clampSetpoint(room, c.setpoint);
    else if (c.op === 'nudge_setpoint') {
      applied = clampSetpoint(room, this.validator.currentSetpoint(room, 26.0) + c.delta);
    } else if (c.op === 'set_fan') {
      this.sim.rooms[room].fan = c.fan;
    } else if (c.op === 'set_ventilation') {
      /* 演示：新风仅记录 */
    }
    const before = this.validator.currentSetpoint(room, 26.0);
    if (applied != null) {
      this.sim.rooms[room].setpoint = applied;
      this.sim.lastSp[room] = applied;
      const prefArr = this.sim.prefer[room] || (this.sim.prefer[room] = []);
      prefArr.push(applied); if (prefArr.length > 200) prefArr.shift();
      this.validator.recordSetpoint(room, applied, this.sim.tMin, true);
      this.validator.audit.logAction({ intent_id: intentId, time: this.sim.tMin, device_id: `AC_${room}`,
        command: cmd, before_state: { setpoint: before }, after_state: { setpoint: applied },
        result: 'success', rolled_back: false, latency_ms: 12 });
    }
    this.validator.audit.logIntent({ intent_id: intentId, time: this.sim.tMin, actor_type: 'resident',
      room_id: room, raw_input: text, model_version: 'rules_v1', validation: PASS,
      reject_reason: '', intent });

    // 长期承诺 → 写入画像
    let memNote = '';
    if (isMemoryStatement(text) || intent.attribute === 'schedule') {
      if (!this.store.consent(uid)) memNote = '（你还没有授权我长期记住这些，我这次先按临时处理）';
      else {
        const bundle = extractMemories(text, true);
        if (bundle.memories.length) {
          this.store.add(uid, bundle, room, 'rules_v1');
          memNote = `（已记住：${[...new Set(bundle.memories.map(m => m.type))].join('、')}）`;
        } else memNote = '（这条我暂时没能整理成可复用的习惯）';
      }
    }
    this.log.push({ tMin: this.sim.tMin, text, result: 'executed', setpoint: applied });
    return { ...base, kind: 'control', ok: true, command: cmd, applied_setpoint: applied,
             speech: this._explain(intent, room, applied) + (memNote ? ' ' + memNote : '') };
  }

  _resolveRoom(sem, fallback) {
    if (!sem || sem === 'all') return fallback;
    const r = ROOMS.find(x => x.room_id === sem || x.room_alias === sem ||
                              x.name === sem || sem.includes(x.name));
    return r ? r.room_id : fallback;
  }
  _describe(room) {
    const st = this.sim.rooms[room];
    const occ = this._occupantsIn(room).length;
    const name = ROOMS.find(x => x.room_id === room)?.name || room;
    return `${name}现在 ${st.T.toFixed(1)}℃，设定 ${st.setpoint.toFixed(1)}℃，` +
           `湿度 ${st.rh.toFixed(0)}%，CO₂ ${Math.round(st.co2)}ppm，` +
           (occ ? `室内 ${occ} 人。` : '室内无人。');
  }
  _explain(intent, room, applied) {
    const name = ROOMS.find(x => x.room_id === room)?.name || room;
    const pref = this.store.preference(this.activeUser, room);
    const why = typeof pref === 'number' ? `（依据：画像偏好 ${pref}℃）` : '（依据：默认偏好）';
    if (intent.attribute === 'schedule') return '好的，我记住了这件事，到时候不会打扰你。';
    if (intent.attribute === 'temperature') {
      if (intent.target_value != null) return `好的，${name}温度已设为 ${intent.target_value}℃。${why}`;
      return `好的，我把${name}温度调整了一点${applied != null ? `，现在设定 ${applied}℃` : ''}。${why}`;
    }
    if (intent.attribute === 'fresh_air') return `好的，${name}新风已加大，让空气流通起来。`;
    if (intent.attribute === 'fan') return (intent.constraints || []).includes('avoid_direct_draft')
      ? '好的，我把风速调低，避免直吹到你。' : '好的，风速已调整。';
    if (intent.attribute === 'light') return '好的，照明已调整。';
    if (intent.attribute === 'curtain') return '好的，窗帘已调整。';
    return '好的，已经按你的要求调整。';
  }
  _explainRejection(verdict, room) {
    const b = boundsForRoom(room);
    const name = ROOMS.find(x => x.room_id === room)?.name || room;
    const map = {
      [REJECT_BOUNDS]: `这个温度超出了允许范围。${name}可设在 ${b.min}~${b.max}℃ 之间，我帮你保持在安全区间内。`,
      [REJECT_RATE]: '短时间内不能连续大幅调整温度，我先稳住，过几分钟再动。',
      [REJECT_EQUIPMENT]: '设备刚停机，需要保护压缩机，等几分钟我再执行。',
      [REJECT_PERMISSION]: '这个操作不在我的权限范围内。',
      [REJECT_EMERGENCY]: '当前处于应急状态，已停止所有舒适性调节，一切服从疏散指令。',
      [REJECT_SCHEMA]: '我没太理解这条指令，你能换个说法吗？',
    };
    return map[verdict.result] || '这个我没法执行。';
  }

  enterEmergency(originRoom = 'A301') {
    const occupancy = {};
    for (const rid of Object.keys(this.sim.rooms)) {
      const n = this.sim.occupantsIn(rid).length;
      if (n) occupancy[rid] = n;
    }
    if (!Object.keys(occupancy).length) occupancy[this.currentRoom] = 1;   // 演示保底
    this.validator.emergency = true;
    this.fsm = new EmergencyFSM();
    const st = this.fsm.trigger({ originRoom, occupancy, actorType: 'fire_system' });
    this.emergencyState = st;
    return st;
  }
  exitEmergency() {
    this.validator.emergency = false;
    this.validator.resetRateWindow(this.sim.lastSp);
    this.emergencyState = null;
    return { active: false };
  }

  _resolveRoom(sem, fallback) {
    if (!sem || sem === 'all') return fallback;
    const r = ROOMS.find(x => x.room_id === sem || x.room_alias === sem ||
                              x.name === sem || sem.includes(x.name));
    return r ? r.room_id : fallback;
  }
  _describe(room) {
    const st = this.sim.rooms[room];
    const occ = this.sim.occupantsIn(room).length;
    const name = ROOMS.find(x => x.room_id === room)?.name || room;
    return `${name}现在 ${st.T.toFixed(1)}℃，设定 ${st.setpoint.toFixed(1)}℃，` +
           `湿度 ${st.rh.toFixed(0)}%，CO₂ ${Math.round(st.co2)}ppm，` +
           (occ ? `室内 ${occ} 人。` : '室内无人。');
  }
  _explain(intent, room, applied) {
    const name = ROOMS.find(x => x.room_id === room)?.name || room;
    const pref = this.store.preference(this.activeUser, room);
    const why = typeof pref === 'number' ? `（依据：画像偏好 ${pref}℃）` : '（依据：默认偏好）';
    if (intent.attribute === 'schedule') return '好的，我记住了这件事，到时候不会打扰你。';
    if (intent.attribute === 'temperature') {
      if (intent.target_value != null)
        return `好的，${name}温度已设为 ${intent.target_value}℃。${why}`;
      return `好的，我把${name}温度调整了一点${applied != null ? `，现在设定 ${applied}℃` : ''}。${why}`;
    }
    if (intent.attribute === 'fresh_air') return `好的，${name}新风已加大，让空气流通起来。`;
    if (intent.attribute === 'fan') return (intent.constraints || []).includes('avoid_direct_draft')
      ? '好的，我把风速调低，避免直吹到你。' : '好的，风速已调整。';
    if (intent.attribute === 'light') return '好的，照明已调整。';
    if (intent.attribute === 'curtain') return '好的，窗帘已调整。';
    return '好的，已经按你的要求调整。';
  }
  _explainRejection(verdict, room) {
    const b = boundsForRoom(room);
    const name = ROOMS.find(x => x.room_id === room)?.name || room;
    const map = {
      [REJECT_BOUNDS]: `这个温度超出了允许范围。${name}可设在 ${b.min}~${b.max}℃ 之间，我帮你保持在安全区间内。`,
      [REJECT_RATE]: '短时间内不能连续大幅调整温度，我先稳住，过几分钟再动。',
      [REJECT_EQUIPMENT]: '设备刚停机，需要保护压缩机，等几分钟我再执行。',
      [REJECT_PERMISSION]: '这个操作不在我的权限范围内。',
      [REJECT_EMERGENCY]: '当前处于应急状态，已停止所有舒适性调节，一切服从疏散指令。',
      [REJECT_SCHEMA]: '我没太理解这条指令，你能换个说法吗？',
    };
    return map[verdict.result] || '这个我没法执行。';
  }
}

function rid() { return 'id' + Math.random().toString(36).slice(2, 10); }

/* 浏览器全局（便于直接 <script type="module"> 引入后调试） */
if (typeof window !== 'undefined') {
  window.SH = { parseRules, SafetyValidator, AuditLog, Sim, BuildingAgent, MemoryStore,
                EvacuationSolver, EmergencyFSM, generateGuidance, extractMemories,
                extractSchedule, priceTier, boundsForRoom, clampSetpoint, BOUNDS, ROOMS,
                AGENTS, TOPOLOGY, Rng, validateSchema, validatePhysics, minToHHMM, hhmmToMin };
}
