/* ================= 番茄专注 · 学习打卡工具 ================= */
/* 数据存储采用 localStorage，键名统一前缀 pf_ */

const KEYS = {
  settings: 'pf_settings',
  tasks: 'pf_tasks',
  categories: 'pf_categories',
  checkins: 'pf_checkins',   // { 'YYYY-MM-DD': true }
  records: 'pf_records',     // [{ date, type:'focus'|'short'|'long', minutes }]
  theme: 'pf_theme',
};

const AUTH_KEYS = {
  accounts: 'pf_accounts',   // [{ username, password }]
  current: 'pf_current_user' // 当前登录用户名（字符串）
};

const DEFAULT_SETTINGS = { focus: 25, short: 5, long: 15, interval: 4, goal: 8 };

/* ---------- 工具函数 ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// 当前登录用户名；null 表示未登录
let currentUser = null;

// 将业务数据键加上用户作用域；主题/账号表为全局键，不做作用域
function scopedKey(key) {
  if (key === KEYS.theme || key === AUTH_KEYS.accounts || key === AUTH_KEYS.current) return key;
  return currentUser ? key.replace(/^pf_/, 'pf_' + currentUser + '_') : key;
}

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(scopedKey(key));
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function save(key, val) {
  localStorage.setItem(scopedKey(key), JSON.stringify(val));
}

// 账号表读/写（始终全局，不做用户作用域）
function loadAccounts() {
  return load(AUTH_KEYS.accounts, []);
}
function saveAccounts(accounts) {
  save(AUTH_KEYS.accounts, accounts);
}
function todayStr(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* ================= 全局状态 ================= */
let settings = Object.assign({}, DEFAULT_SETTINGS);
let tasks = [];
let categories = [];
let checkins = {};
let records = [];

/* 登录后重新加载当前用户的数据到全局状态 */
function loadUserData() {
  settings = Object.assign({}, DEFAULT_SETTINGS, load(KEYS.settings, {}));
  tasks = load(KEYS.tasks, []);
  categories = load(KEYS.categories, []);
  checkins = load(KEYS.checkins, {});
  records = load(KEYS.records, []);
}

/* ================= 主题切换 ================= */
function applyTheme() {
  const t = load(KEYS.theme, 'light');
  document.documentElement.setAttribute('data-theme', t);
  $('#theme-toggle').textContent = t === 'dark' ? '☀' : '🌙';
}
$('#theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  save(KEYS.theme, next);
  $('#theme-toggle').textContent = next === 'dark' ? '☀' : '🌙';
  updateChartsTheme(); // 图表随主题刷新
});

/* ================= 导航切换 ================= */
const sections = ['pomodoro', 'tasks', 'checkin', 'stats'];
function showSection(id) {
  sections.forEach(s => $('#' + s).classList.toggle('active', s === id));
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.target === id));
  if (id === 'stats') renderStats();
  if (id === 'checkin') renderCalendar();
  if (id === 'tasks') renderTasks();
}
$$('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => showSection(btn.dataset.target));
});

/* ================= 番茄计时 ================= */
const RING_CIRC = 2 * Math.PI * 115; // 722.6
$('.ring-progress').setAttribute('stroke-dasharray', RING_CIRC);

let phase = 'focus';           // focus | short | long
let running = false;
let taskLocked = false;         // 专注会话开始后锁定任务选择，直到重置
let totalSec = settings.focus * 60;
let remainSec = totalSec;
let timerId = null;
let cycleCount = 0;            // 自上次长休后累计完成的专注数
let todayDone = 0;             // 今日完成番茄数

const PHASE_LABEL = { focus: '专注', short: '短休息', long: '长休息' };
const PHASE_COLOR = { focus: '#f97316', short: '#3b82f6', long: '#8b5cf6' };

function phaseTotal() {
  return { focus: settings.focus, short: settings.short, long: settings.long }[phase] * 60;
}

function renderTimer() {
  $('#timer-display').textContent = fmtClock(remainSec);
  $('#phase-label').textContent = PHASE_LABEL[phase];
  const taskSel = $('#timer-task');
  taskSel.disabled = taskLocked;
  const total = phaseTotal();
  const ratio = total > 0 ? remainSec / total : 0;
  const offset = RING_CIRC * (1 - ratio);
  $('.ring-progress').style.strokeDashoffset = offset;
  $('.ring-progress').style.stroke = PHASE_COLOR[phase];
  $('#timer-start-pause').textContent = running ? '暂停' : (remainSec === total ? '开始' : '继续');
}

function tick() {
  if (remainSec > 0) {
    remainSec--;
    renderTimer();
  } else {
    onPhaseComplete();
  }
}

function startTimer() {
  if (running) return;
  running = true;
  taskLocked = true;
  timerId = setInterval(tick, 1000);
  renderTimer();
}
function pauseTimer() {
  running = false;
  clearInterval(timerId);
  renderTimer();
}
function resetTimer() {
  pauseTimer();
  taskLocked = false;
  phase = 'focus';
  totalSec = phaseTotal();
  remainSec = totalSec;
  renderTimer();
  hideNotice();
}

function switchPhase(next) {
  phase = next;
  totalSec = phaseTotal();
  remainSec = totalSec;
  renderTimer();
}

function onPhaseComplete() {
  pauseTimer();
  const finished = phase;

  // 记录专注/休息数据
  records.push({ date: todayStr(new Date()), type: finished, minutes: phaseTotal() / 60, hour: new Date().getHours() });
  save(KEYS.records, records);

  if (finished === 'focus') {
    todayDone++;
    cycleCount++;
    $('#pomodoro-count').textContent = `今日 ${todayDone} 个番茄`;
    renderGoal();

    // 累加所选任务的专注进度
    addTaskFocusProgress();

    // 判断是否进入长休（每 interval 个番茄需手动确认）
    if (cycleCount >= settings.interval) {
      cycleCount = 0;
      showNotice('已完成 ' + settings.interval + ' 个番茄，是否开启长休息？点击「开始」进入长休息，或点击「跳过」继续专注。');
      phase = 'long';
      totalSec = phaseTotal();
      remainSec = totalSec;
      renderTimer();
      return;
    }
    // 自动进入短休息
    switchPhase('short');
    startTimer();
  } else {
    // 休息结束 → 自动进入专注
    switchPhase('focus');
    startTimer();
  }
}

function showNotice(msg) {
  $('#timer-notice').textContent = msg;
  $('#timer-notice').hidden = false;
}
function hideNotice() {
  $('#timer-notice').hidden = true;
}

/* 自定义提示弹窗（标题固定「提示」） */
function showModal(msg) {
  $('#modal-body').textContent = msg;
  $('#modal-overlay').hidden = false;
}
function hideModal() {
  $('#modal-overlay').hidden = true;
}
$('#modal-ok').addEventListener('click', hideModal);
$('#modal-close').addEventListener('click', hideModal);
$('#modal-overlay').addEventListener('click', (e) => {
  if (e.target === $('#modal-overlay')) hideModal();
});

/* 番茄计时任务选择 */
function renderTimerTaskSelect() {
  const sel = $('#timer-task');
  const keep = sel.value;
  const undone = tasks.filter(t => !t.done);
  sel.innerHTML = '<option value="">不选择任务</option>' +
    undone.map(t => `<option value="${t.id}">${escapeHtml(t.title)}（${t.pomodoroDone || 0}/${t.pomodoro}）</option>`).join('');
  if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
}

/* 完成一个专注番茄后，为所选任务累加进度，满则自动标记完成 */
function addTaskFocusProgress() {
  const sel = $('#timer-task');
  const id = Number(sel.value);
  if (!id) return;
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  task.pomodoroDone = (task.pomodoroDone || 0) + 1;
  if (task.pomodoroDone >= task.pomodoro && !task.done) {
    task.done = true;
    task.doneAt = Date.now();
  }
  save(KEYS.tasks, tasks);
  renderTasks();
  renderTimerTaskSelect();
}

$('#timer-start-pause').addEventListener('click', () => {
  hideNotice();
  if (running) {
    pauseTimer();
  } else {
    // 开始前必须选择任务
    if (!$('#timer-task').value) {
      showModal('请先选择一个专注任务，再开始计时！');
      return;
    }
    startTimer();
  }
});
$('#timer-reset').addEventListener('click', resetTimer);
$('#timer-skip').addEventListener('click', () => {
  // 跳过当前阶段
  hideNotice();
  pauseTimer();
  const skipped = phase;
  if (skipped === 'focus') {
    // 跳过专注不计数，直接进入休息
    switchPhase('short');
    startTimer();
  } else {
    switchPhase('focus');
    startTimer();
  }
});

/* 目标进度 */
function renderGoal() {
  $('#goal-done').textContent = todayDone;
  $('#goal-total').textContent = settings.goal;
  const pct = Math.min(100, (todayDone / settings.goal) * 100);
  $('#goal-bar-fill').style.width = pct + '%';
  $('#goal-hint').textContent = todayDone >= settings.goal ? '目标达成！太棒了 🎉' : `已完成 ${todayDone}/${settings.goal}，继续加油！`;
}

/* 设置保存 */
function fillSettingsForm() {
  $('#set-focus').value = settings.focus;
  $('#set-short').value = settings.short;
  $('#set-long').value = settings.long;
  $('#set-interval').value = settings.interval;
  $('#set-goal').value = settings.goal;
}
$('#save-settings').addEventListener('click', () => {
  settings.focus = clampInt($('#set-focus').value, 1, 120, 25);
  settings.short = clampInt($('#set-short').value, 1, 60, 5);
  settings.long = clampInt($('#set-long').value, 1, 90, 15);
  settings.interval = clampInt($('#set-interval').value, 1, 12, 4);
  settings.goal = clampInt($('#set-goal').value, 1, 50, 8);
  save(KEYS.settings, settings);
  fillSettingsForm();
  resetTimer();
  renderGoal();
  showModal('设置已保存');
});
function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/* ================= 任务清单 ================= */
let editingId = null;

function priorityLabel(p) { return { high: '高', medium: '中', low: '低' }[p] || '中'; }
function priorityClass(p) { return 'pri-' + (p || 'medium'); }

function renderCategories() {
  const sel = $('#task-category');
  const filter = $('#task-category-filter');
  const keepSel = sel.value, keepFilter = filter.value;
  sel.innerHTML = '<option value="">无分类</option>' + categories.map(c => `<option value="${c}">${c}</option>`).join('');
  filter.innerHTML = '<option value="">全部分类</option>' + categories.map(c => `<option value="${c}">${c}</option>`).join('');
  sel.value = keepSel;
  filter.value = keepFilter;
}

function renderTasks() {
  const search = $('#task-search').value.trim().toLowerCase();
  const catFilter = $('#task-category-filter').value;
  const sort = $('#task-sort').value;

  let list = tasks.filter(t => {
    const matchSearch = !search || t.title.toLowerCase().includes(search);
    const matchCat = !catFilter || t.category === catFilter;
    return matchSearch && matchCat;
  });

  list.sort((a, b) => {
    if (sort === 'priority') return priorityWeight(b.priority) - priorityWeight(a.priority);
    if (sort === 'due') return (a.due || '9999').localeCompare(b.due || '9999');
    return (a.created || 0) - (b.created || 0);
  });

  const container = $('#task-list');
  if (list.length === 0) {
    container.innerHTML = '<div class="card glass" style="text-align:center;color:var(--text-muted);padding:30px;">暂无任务</div>';
    renderTimerTaskSelect();
    return;
  }
  container.innerHTML = list.map(t => {
    const dueTag = t.due ? (new Date(t.due + 'T23:59:59') < new Date() && !t.done ? 'overdue' : 'due') : '';
    const dueText = t.due ? t.due : '';
    return `
      <div class="card glass task-item ${t.done ? 'done' : ''}" data-id="${t.id}">
        <input type="checkbox" class="task-check" ${t.done ? 'checked' : ''}>
        <div class="task-title-text">${escapeHtml(t.title)}</div>
        <div class="task-meta">
          <span class="task-tag" style="${tagColor(t.category)}">${t.category || '无分类'}</span>
          ${t.due ? `<span class="task-tag ${dueTag}">📅 ${dueText}</span>` : ''}
          <span class="${priorityClass(t.priority)}">${priorityLabel(t.priority)}</span>
          <span class="task-tag">🍅 ${t.pomodoroDone || 0}/${t.pomodoro}</span>
          <button class="task-icon-btn task-edit" title="编辑">✏️</button>
          <button class="task-icon-btn task-del" title="删除">🗑</button>
        </div>
      </div>`;
  }).join('');

  // 事件绑定
  container.querySelectorAll('.task-item').forEach(item => {
    const id = Number(item.dataset.id);
    const task = tasks.find(t => t.id === id);
    item.querySelector('.task-check').addEventListener('change', (e) => {
      task.done = e.target.checked;
      task.doneAt = e.target.checked ? Date.now() : null;
      save(KEYS.tasks, tasks);
      renderTasks();
    });
    item.querySelector('.task-del').addEventListener('click', () => {
      tasks = tasks.filter(t => t.id !== id);
      save(KEYS.tasks, tasks);
      renderTasks();
    });
    item.querySelector('.task-edit').addEventListener('click', () => {
      startEdit(task);
    });
  });

  renderTimerTaskSelect();
}

function tagColor(cat) {
  const palette = ['#14b8a6', '#3b82f6', '#22d3ee', '#8b5cf6', '#e879f9'];
  let idx = 0;
  if (cat) {
    idx = (categories.indexOf(cat) % palette.length + palette.length) % palette.length;
  }
  return `background:${palette[idx]}22;color:${palette[idx]};`;
}

function priorityWeight(p) { return { high: 3, medium: 2, low: 1 }[p] || 2; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

/* 截止日期输入框占位提示：为空时显示「截止日期」 */
function syncDuePlaceholder() {
  const due = $('#task-due');
  due.classList.toggle('date-empty', !due.value);
}

function resetTaskForm() {
  editingId = null;
  $('#task-title').value = '';
  $('#task-due').value = '';
  $('#task-priority').value = 'medium';
  $('#task-pomodoro').value = 1;
  $('#task-category').value = '';
  $('#task-add').textContent = '添加任务';
  syncDuePlaceholder();
}
function startEdit(task) {
  editingId = task.id;
  $('#task-title').value = task.title;
  $('#task-due').value = task.due || '';
  $('#task-priority').value = task.priority || 'medium';
  $('#task-pomodoro').value = task.pomodoro;
  $('#task-category').value = task.category || '';
  $('#task-add').textContent = '保存修改';
  syncDuePlaceholder();
  window.scrollTo({ top: $('#tasks').offsetTop - 80, behavior: 'smooth' });
}

$('#task-add').addEventListener('click', () => {
  const title = $('#task-title').value.trim();
  if (!title) { showModal('请输入任务标题'); return; }
  const data = {
    title,
    due: $('#task-due').value || null,
    priority: $('#task-priority').value,
    pomodoro: clampInt($('#task-pomodoro').value, 0, 999, 1),
    category: $('#task-category').value || '',
  };
  if (editingId !== null) {
    const t = tasks.find(x => x.id === editingId);
    Object.assign(t, data);
    // 若目标番茄数改变，确保已完成数不超过目标
    if (t.pomodoroDone > t.pomodoro) t.pomodoroDone = t.pomodoro;
  } else {
    data.id = Date.now();
    data.created = Date.now();
    data.done = false;
    data.pomodoroDone = 0;
    tasks.push(data);
  }
  save(KEYS.tasks, tasks);
  resetTaskForm();
  renderTasks();
});

$('#category-add').addEventListener('click', () => {
  const name = $('#new-category').value.trim();
  if (!name) { showModal('请输入分类名'); return; }
  if (categories.includes(name)) { showModal('分类已存在'); return; }
  categories.push(name);
  save(KEYS.categories, categories);
  $('#new-category').value = '';
  renderCategories();
  renderTasks();
});

$('#task-search').addEventListener('input', renderTasks);
$('#task-category-filter').addEventListener('change', renderTasks);
$('#task-sort').addEventListener('change', renderTasks);
$('#task-due').addEventListener('change', syncDuePlaceholder);

/* 点击日历图标弹出日期选择器：showPicker 优先，兼容回退 focus/click */
function openDuePicker() {
  const due = $('#task-due');
  if (due.showPicker) {
    try { due.showPicker(); return; } catch (e) { /* 继续走回退 */ }
  }
  due.focus();
  due.click();
}
document.querySelector('.date-icon').addEventListener('click', openDuePicker);
$('#task-due').addEventListener('click', openDuePicker);

/* ================= 打卡 ================= */
function dateKey(d) { return todayStr(d); }

function addCheckin(dateStr) {
  checkins[dateStr] = true;
  save(KEYS.checkins, checkins);
  renderCheckin();
}

function renderCheckin() {
  const today = todayStr();
  const checkedToday = !!checkins[today];

  // 双按钮同步状态
  const topBtn = $('#checkin-top-btn');
  const mainBtn = $('#checkin-btn');
  [topBtn, mainBtn].forEach(b => {
    b.textContent = checkedToday ? '已打卡 ✓' : '今日打卡';
    b.classList.toggle('checked', checkedToday);
    b.disabled = checkedToday;
  });

  // 连续/累计
  const { streak, total } = calcStreak();
  $('#streak-days').textContent = streak;
  $('#total-days').textContent = total;

  renderBadges(streak, total);
}

function calcStreak() {
  const dates = Object.keys(checkins).filter(d => checkins[d]).sort();
  const total = dates.length;
  let streak = 0;
  let d = new Date();
  // 若今天未打卡，从昨天开始数连续
  let cursor = new Date();
  if (!checkins[todayStr(cursor)]) cursor.setDate(cursor.getDate() - 1);
  while (checkins[dateKey(cursor)]) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { streak, total };
}

const BADGES = [
  { name: '首次打卡', icon: '🌱', need: 1 },
  { name: '坚持3天', icon: '🔥', need: 3 },
  { name: '坚持7天', icon: '⭐', need: 7 },
  { name: '坚持30天', icon: '🏆', need: 30 },
  { name: '坚持100天', icon: '👑', need: 100 },
  { name: '累计365天', icon: '💎', need: 365 },
];
function renderBadges(streak, total) {
  const container = $('#badge-list');
  container.innerHTML = BADGES.map(b => {
    const unlocked = (b.need <= streak) || (b.name === '累计365天' && total >= 365);
    const cls = unlocked ? 'badge unlocked' : 'badge';
    return `<div class="${cls}"><span class="badge-icon">${b.icon}</span><span class="badge-name">${b.name}</span>${unlocked ? '' : `<span class="badge-locked">需${b.need}天</span>`}</div>`;
  }).join('');
}

$('#checkin-btn').addEventListener('click', () => addCheckin(todayStr()));
$('#checkin-top-btn').addEventListener('click', () => addCheckin(todayStr()));

/* 月历热力图 */
let calYear, calMonth;
function renderCalendar() {
  if (calYear == null) {
    const now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
  }
  $('#calendar-title').textContent = `${calYear} 年 ${calMonth + 1} 月`;
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const today = todayStr();

  let html = '';
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-day empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const checked = checkins[ds];
    const isToday = ds === today;
    const isFuture = ds > today;
    const cls = ['cal-day', checked ? 'checked' : '', isToday ? 'today' : '', isFuture ? 'future' : ''].join(' ');
    html += `<div class="${cls}">${d}</div>`;
  }
  $('#calendar-grid').innerHTML = html;
}
$('#cal-prev').addEventListener('click', () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); });
$('#cal-next').addEventListener('click', () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); });

/* ================= 统计看板 ================= */
let statsRange = 'day';
let charts = {};
const COLOR_MAIN = '#14b8a6';
const COLOR_2 = '#3b82f6';
const COLOR_3 = '#8b5cf6';

function rangeDays() {
  if (statsRange === 'day') return 1;
  if (statsRange === 'week') return 7;
  if (statsRange === 'month') return 30;
  return null; // 累计
}

function inRange(dateStr) {
  const days = rangeDays();
  if (days === null) return true;
  const target = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diff = Math.floor((now - target) / 86400000);
  return diff >= 0 && diff < days;
}

function renderStats() {
  const filtered = records.filter(r => inRange(r.date));
  const focusRecords = filtered.filter(r => r.type === 'focus');
  const totalMinutes = focusRecords.reduce((s, r) => s + r.minutes, 0);
  const pomodoroCount = focusRecords.length;

  // 任务统计（按创建日期归属到对应日）
  const tasksInRange = tasks.filter(t => inRange(dateStrOfTask(t)));
  const doneTasks = tasksInRange.filter(t => t.done).length;
  const completion = tasksInRange.length ? Math.round((doneTasks / tasksInRange.length) * 100) : 0;

  $('#sc-focus-time').textContent = fmtDur(totalMinutes);
  $('#sc-pomodoro').textContent = pomodoroCount;
  $('#sc-task-done').textContent = doneTasks;
  $('#sc-completion').textContent = completion + '%';

  renderTrendChart(filtered);
  renderPieChart();
  renderDurationChart(filtered);
  renderHourChart(filtered);
}

function fmtDur(min) {
  if (min < 60) return min + 'm';
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h${m}m` : `${h}h`;
}

function dateStrOfTask(t) {
  if (t.doneAt) return todayStr(new Date(t.doneAt));
  return todayStr(new Date(t.created || Date.now()));
}

function fillDateArray() {
  const days = rangeDays();
  const arr = [];
  const n = days || 30;
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    arr.push({ key: todayStr(d), label: `${d.getMonth() + 1}/${d.getDate()}` });
  }
  return arr;
}

function renderTrendChart(filtered) {
  const arr = fillDateArray();
  const labels = arr.map(a => a.label);
  const focus = arr.map(a => filtered.filter(r => r.type === 'focus' && r.date === a.key).length);
  const rest = arr.map(a => filtered.filter(r => r.type !== 'focus' && r.date === a.key).length);

  makeChart('chart-trend', 'line', {
    labels,
    datasets: [
      { label: '番茄数', data: focus, borderColor: COLOR_MAIN, backgroundColor: COLOR_MAIN + '33', fill: true, tension: 0.3 },
      { label: '休息次数', data: rest, borderColor: COLOR_2, backgroundColor: COLOR_2 + '33', fill: true, tension: 0.3 },
    ],
  });
}

function renderDurationChart(filtered) {
  const arr = fillDateArray();
  const labels = arr.map(a => a.label);
  const mins = arr.map(a => filtered.filter(r => r.type === 'focus' && r.date === a.key).reduce((s, r) => s + r.minutes, 0));

  makeChart('chart-duration', 'bar', {
    labels,
    datasets: [{ label: '专注时长(分)', data: mins, backgroundColor: COLOR_MAIN + 'cc', borderRadius: 6 }],
  });
}

function renderHourChart(filtered) {
  const hours = Array.from({ length: 24 }, (_, i) => {
    const list = filtered.filter(r => r.type === 'focus' && r.hour === i);
    return list.reduce((s, r) => s + r.minutes, 0);
  });
  const labels = Array.from({ length: 24 }, (_, i) => i + 'h');
  makeChart('chart-hour', 'bar', {
    labels,
    datasets: [{ label: '专注时长(分)', data: hours, backgroundColor: COLOR_3 + 'cc', borderRadius: 4 }],
  });
  const c = charts['chart-hour'];
  if (c) {
    c.options.scales.x.ticks.autoSkip = false;
    c.options.scales.x.ticks.maxRotation = 0;
    c.options.scales.x.ticks.callback = function (value, index) {
      return index % 2 === 0 ? this.getLabelForValue(value) : '';
    };
    c.update();
  }
}

function renderPieChart() {
  // 任务分类占比：按当前任务列表中各分类的任务数
  const catMap = {};
  tasks.forEach(t => {
    const c = t.category || '无分类';
    catMap[c] = (catMap[c] || 0) + 1;
  });
  const labels = Object.keys(catMap);
  const data = Object.values(catMap);
  if (labels.length === 0) {
    makeChart('chart-pie', 'doughnut', { labels: ['暂无任务'], datasets: [{ data: [1], backgroundColor: ['#cccccc'] }] });
    return;
  }
  makeChart('chart-pie', 'doughnut', {
    labels,
    datasets: [{ data, backgroundColor: chartPalette(labels.length) }],
  });
}

function chartPalette(n) {
  const base = ['#14b8a6', '#3b82f6', '#22d3ee', '#8b5cf6', '#e879f9', '#60a5fa', '#34d399', '#f472b6'];
  return Array.from({ length: n }, (_, i) => base[i % base.length]);
}

function makeChart(id, type, data) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  if (charts[id]) charts[id].destroy();

  const textColor = document.documentElement.getAttribute('data-theme') === 'dark' ? '#a5c4cc' : '#54707d';
  const gridColor = document.documentElement.getAttribute('data-theme') === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

  charts[id] = new Chart(canvas, {
    type,
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: textColor, boxWidth: 12 } },
      },
      scales: type === 'doughnut' ? {} : {
        x: { ticks: { color: textColor }, grid: { color: gridColor } },
        y: { ticks: { color: textColor, precision: 0 }, grid: { color: gridColor }, beginAtZero: true },
      },
    },
  });
}

function updateChartsTheme() {
  if ($('#stats').classList.contains('active')) renderStats();
}

$$('.range-btn').forEach(b => {
  b.addEventListener('click', () => {
    $$('.range-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    statsRange = b.dataset.range;
    renderStats();
  });
});

/* ================= 数据导出 ================= */
$('#export-btn').addEventListener('click', () => {
  const data = { settings, tasks, categories, checkins, records, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `番茄专注数据_${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

/* ================= 初始化 ================= */
function initApp() {
  loadUserData();
  applyTheme();
  fillSettingsForm();
  resetTimer();
  renderGoal();
  renderCheckin();
  renderCalendar();
  renderCategories();
  renderTasks();
  // 记录今日番茄数（从 records 统计）
  todayDone = records.filter(r => r.date === todayStr() && r.type === 'focus').length;
  $('#pomodoro-count').textContent = `今日 ${todayDone} 个番茄`;
  renderGoal();
}

/* ================= 账号：登录 / 注册 / 切换 / 退出 ================= */
function updateUserUI() {
  const btn = $('#user-btn');
  const nameEl = $('#user-menu-name');
  if (currentUser) {
    btn.textContent = '👤 ' + currentUser;
    btn.classList.add('logged-in');
    nameEl.textContent = currentUser;
  } else {
    btn.textContent = '👤 登录';
    btn.classList.remove('logged-in');
    nameEl.textContent = '';
  }
}

function showAuth(mode) {
  // mode: 'login'（已存在账号）或 'register'（新账号）
  if (!mode || mode === 'login') {
    $('#auth-title').textContent = '登录';
    $('#auth-sub').textContent = '首次使用将自动注册新账号';
  } else {
    $('#auth-title').textContent = '注册新账号';
    $('#auth-sub').textContent = '请输入用户名和密码完成注册';
  }
  $('#auth-error').textContent = '';
  $('#auth-username').value = '';
  $('#auth-password').value = '';
  $('#auth-overlay').hidden = false;
  setTimeout(() => $('#auth-username').focus(), 0);
}

function hideAuth() {
  $('#auth-overlay').hidden = true;
  $('#auth-error').textContent = '';
}

function doAuthSubmit() {
  const username = $('#auth-username').value.trim();
  const password = $('#auth-password').value;
  const errEl = $('#auth-error');
  if (!username) { errEl.textContent = '请输入用户名'; return; }
  if (!password) { errEl.textContent = '请输入密码'; return; }

  const accounts = loadAccounts();
  const found = accounts.find(a => a.username === username);

  // 登录：账号已存在
  if (found) {
    if (found.password !== password) { errEl.textContent = '密码错误，请重试'; return; }
    currentUser = found.username;
  } else {
    // 注册：账号不存在
    accounts.push({ username, password });
    saveAccounts(accounts);
    currentUser = username;
  }

  save(AUTH_KEYS.current, currentUser);
  loadUserData();
  updateUserUI();
  hideAuth();
  initApp();
}

function logout() {
  currentUser = null;
  save(AUTH_KEYS.current, null);
  // 清空内存状态
  settings = Object.assign({}, DEFAULT_SETTINGS);
  tasks = []; categories = []; checkins = {}; records = [];
  resetTimer();
  updateUserUI();
  showAuth('login');
}

$('#auth-submit').addEventListener('click', doAuthSubmit);
$('#auth-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doAuthSubmit();
});
$('#auth-username').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#auth-password').focus();
});

// 顶栏用户按钮：展开/收起下拉菜单
$('#user-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!currentUser) { showAuth('login'); return; }
  $('#user-menu').hidden = !$('#user-menu').hidden;
});
// 点击空白处收起菜单
document.addEventListener('click', () => {
  $('#user-menu').hidden = true;
});
$('#switch-account-btn').addEventListener('click', () => {
  $('#user-menu').hidden = true;
  logout();
});
$('#logout-btn').addEventListener('click', () => {
  $('#user-menu').hidden = true;
  logout();
});

/* 启动：未登录则弹出登录窗（阻断使用），已登录则加载对应账号数据 */
function bootstrap() {
  const saved = load(AUTH_KEYS.current, null);
  if (saved) {
    currentUser = saved;
    const account = loadAccounts().find(a => a.username === saved);
    // 若记录的当前账号已不存在（数据被清理），回退到登录
    if (!account) {
      currentUser = null;
      save(AUTH_KEYS.current, null);
      updateUserUI();
      showAuth('login');
      return;
    }
    updateUserUI();
    initApp();
  } else {
    updateUserUI();
    showAuth('login');
  }
}

bootstrap();