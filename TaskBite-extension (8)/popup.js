const T = {
  missingLbl: "Overdue",
  stepsLbl: "Steps",
  scan: "🔎 Find my assignments on this page",
  back: "← Back to list",
  start: "Start this step",
  pause: "⏸ Pause",
  resume: "▶ Resume",
  yourPace: "your pace",
  next: "Done with this step",
  focus: "Start",
  badLink: "Can't open that one yet. Refresh your Canvas tab once, then try again.",
  refreshPage: "Refresh this page once, then tap Find again.",
  none: "Nothing here yet. Open Canvas, Google Classroom, Moodle, Blackboard or Schoology, then tap find.",
  notPortal: "This page isn't a supported school portal. Open your assignment page and try again.",
  found: "Found",
  left: "left",
  total: "total",
  confirm: "Open this assignment and press Turn in?",
  submitted: "Turned in.",
  manual: "Opened the assignment. Finish it, then submit.",
  breathe: "Start with one task.",
  help: "I need help",
  oneThing: "Up next",
  showRest: "Show other tasks",
  hideRest: "Hide other tasks",
  showDone: "Show finished",
  hideDone: "Hide finished",
  onlyThis: "Current step",
  needMore: "Need more time? Need more help?",
  addBtn: "Add",
  sparkDone: "Good start.",
  helpHint: "Select the part of the page you need help with.",
  lock: "🔒 Lock in (block other sites)",
  unlock: "🔓 Unlock",
  lockOn: "🔒 Focus mode is on.",
  lockFail: "Couldn't lock in. Open your assignment page first.",
};
const $ = (id) => document.getElementById(id);
const show = (id) => ["list", "focus"].forEach((s) => ($(s).hidden = s !== id));
const status = (t) => ($("status").textContent = t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// "Class name: assignment name"
function labelOf(t) {
  const name = t.name || "Assignment";
  const course = (t.course || "").trim();
  if (!course || name.toLowerCase().startsWith(course.toLowerCase())) return name;
  return `${course}: ${name}`;
}
const dueLabel = (t) => `Due ${String(t.due).replace(/^due[:\s]*/i, "")}`;
function dueMs(t) {
  if (t.dueAt) return t.dueAt;
  if (!t.due) return null;
  const d = new Date(String(t.due).replace(/^due[:\s]*/i, ""));
  if (Number.isNaN(+d)) return null;
  if (d.getFullYear() < 2015) d.setFullYear(new Date().getFullYear());
  return +d;
}

// Higher = do it sooner. Overdue and soon-due work first, weighted by points and by type (tests, projects, essays).
function importance(t, type) {
  const due = dueMs(t);
  let urgency;
  if (due) {
    const hrs = (due - Date.now()) / 36e5;
    urgency = hrs <= 0 ? 100 - Math.min(30, -hrs / 24) : 100 * Math.exp(-hrs / 96);
  } else {
    urgency = t.missing ? 90 : 15;
  }
  const pts = Number(t.points) || 0;
  const ptsF = 1 + Math.min(1, pts / 100) * 0.5;
  const typeF = { "Quiz / Test": 1.2, "Project": 1.15, "Essay / Writing": 1.1 }[type] || 1;
  return urgency * ptsF * typeF + (t.missing ? 25 : 0);
}

function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const c = document.createElement("canvas");
  const w = (c.width = window.innerWidth), h = (c.height = window.innerHeight);
  c.style.cssText = "position:fixed;left:0;top:0;pointer-events:none;z-index:9999";
  document.body.appendChild(c);
  const g = c.getContext("2d");
  const colors = ["#3f7d5c", "#f3c04a", "#e8734a", "#5b9bd5", "#c06ccf", "#7ccf9a"];
  const ps = Array.from({ length: 110 }, () => ({
    x: w / 2 + (Math.random() - 0.5) * 60, y: h * 0.35,
    vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 11 - 3,
    s: 5 + Math.random() * 6, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  (function frame(now) {
    const t = now - t0;
    g.clearRect(0, 0, w, h);
    for (const p of ps) {
      p.vy += 0.3; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      g.save();
      g.globalAlpha = Math.max(0, Math.min(1, (2400 - t) / 800));
      g.translate(p.x, p.y); g.rotate(p.r); g.fillStyle = p.c;
      g.fillRect(-p.s / 2, -p.s / 3, p.s, p.s * 0.66);
      g.restore();
    }
    if (t < 2400) requestAnimationFrame(frame); else c.remove();
  })(t0);
}
let showRest = false, showDone = false;

const HAS_EXT = !!(globalThis.chrome?.storage?.local);
$("aiSettings").onclick = () => { if (HAS_EXT) chrome.runtime.openOptionsPage(); };
const DEMO_TASKS = { demo: { id: "demo", name: "Chapter 4 questions", missing: true, due: "Friday", desc: "Answer questions 1–8", points: 10 } };
async function getTasks() { if (!HAS_EXT) return { ...DEMO_TASKS }; return (await chrome.storage.local.get("tasks")).tasks || {}; }
async function saveTasks(t) { if (!HAS_EXT) return; await chrome.storage.local.set({ tasks: t }); }
async function getPace() { if (!HAS_EXT) return { samples: 0, ratio: 1, types: {} }; return (await chrome.storage.local.get("pace")).pace || { samples: 0, ratio: 1, types: {} }; }
async function savePace(p) { if (!HAS_EXT) return; await chrome.storage.local.set({ pace: p }); }

function mergeSteps(existing, estimated) {
  if (!existing || existing.length !== estimated.length) return estimated;
  return existing.map((s, i) => ({ ...estimated[i], done: !!s.done, text: s.text || estimated[i].text }));
}

function taskCard(t, featured) {
  const el = document.createElement("div");
  el.className = "task" + (t.done ? " done" : "") + (featured ? " now" : "");
  el.innerHTML = `<div class="row"><input type="checkbox" ${t.done ? "checked" : ""}/><div><div class="name"></div>
    <div class="meta">${t.missing && !t.done ? `<span class="pill miss">${T.missingLbl}</span>` : ""}${featured && !t.done ? `<span class="pill">${T.oneThing}</span>` : ""}<span class="pill" title="Adjusted to how long you usually take">⏱ ${t.est.minutes} min${t.est.personal ? ` · ${T.yourPace}` : ""}</span>${t.due ? `<span>📅 ${esc(dueLabel(t))}</span>` : ""}</div></div></div>
    <div class="steps" ${featured && !t.done ? "" : "hidden"}></div>
    <div class="meta" style="padding-left:32px">${t.done ? "" : `<button class="startBtn focusBtn">▶ ${T.focus}</button>${featured ? "" : `<button class="link more">${T.stepsLbl} ▾</button>`}<button class="link helpOne">${T.help}</button>`}</div>`;
  const nameEl = el.querySelector(".name");
  nameEl.textContent = labelOf(t);
  if (t.url && HAS_EXT) {
    nameEl.classList.add("open");
    nameEl.title = "Open this assignment";
    nameEl.onclick = () => {
      const link = taskLink(t);
      if (link) chrome.tabs.create({ url: link });
      else status(T.badLink);
    };
  }
  const steps = el.querySelector(".steps");
  if (!t.done) t.steps.forEach((s, i) => {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" ${s.done ? "checked" : ""}/><span class="${s.done ? "x" : ""}"></span>`;
    l.querySelector("span").textContent = `${s.text} · ${s.min}m`;
    l.querySelector("input").onchange = async (e) => { const all = await getTasks(); all[t.id].steps[i].done = e.target.checked; await saveTasks(all); render(); };
    steps.appendChild(l);
  });
  el.querySelector(".row input").onchange = (e) => toggleDone(t, e.target.checked);
  const focusBtn = el.querySelector(".focusBtn");
  const more = el.querySelector(".more");
  const helpOne = el.querySelector(".helpOne");
  if (focusBtn) focusBtn.onclick = () => startFocus(t);
  if (helpOne) helpOne.onclick = () => openHelp(t);
  if (more) more.onclick = () => (steps.hidden = !steps.hidden);
  return el;
}

// Canvas can hand back relative links ("/courses/1/assignments/2"). The site's address is learned from any task that has a full
// link (or from the last scan), so those links open without needing a new scan.
let ORIGINS = {};
async function loadOrigins(tasks) {
  const o = HAS_EXT ? { ...((await chrome.storage.local.get("origins")).origins || {}) } : {};
  for (const t of Object.values(tasks)) {
    if (t.platform && !o[t.platform] && /^https?:\/\//i.test(t.url || "")) { try { o[t.platform] = new URL(t.url).origin; } catch { /* skip */ } }
  }
  ORIGINS = o;
}
function taskLink(t) {
  const u = String(t?.url || "");
  if (/^https?:\/\//i.test(u)) return u;
  const origin = ORIGINS[t?.platform];
  return u.startsWith("/") && origin ? origin + u : "";
}

// The same assignment can be stored twice: once with a full link and once with a relative one.
// Keep the full-link copy and carry over anything the other copy had (done, time spent). Returns {removedId: keptId}.
function dedupeTasks(tasks) {
  const groups = new Map(), removed = {};
  for (const t of Object.values(tasks)) {
    const k = taskLink(t).split("#")[0];
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const full = (t) => /^https?:\/\//i.test(t.id) ? 1 : 0;
  for (const [k, g] of groups) {
    g.sort((a, b) => full(b) - full(a));
    const [keep, ...rest] = g;
    keep.url = k; // a relative link becomes a full one
    for (const r of rest) {
      keep.done = !!(keep.done || r.done);
      keep.actualMs = Math.max(keep.actualMs || 0, r.actualMs || 0);
      if (!keep.steps?.length && r.steps?.length) keep.steps = r.steps;
      removed[r.id] = keep.id;
      delete tasks[r.id];
    }
  }
  return removed;
}

async function render() {
  const [tasks, pace] = await Promise.all([getTasks(), getPace()]);
  await loadOrigins(tasks);
  const removed = dedupeTasks(tasks);
  if (HAS_EXT && Object.keys(removed).length) { // a timer on a merged-away copy follows the survivor
    const f = await loadFocus();
    if (f && removed[f.taskId]) await saveFocus({ ...f, taskId: removed[f.taskId] });
  }
  const list = Object.values(tasks).map((t) => {
    const est = estimateTask(t, pace);
    t.steps = mergeSteps(t.steps, est.steps);
    t.lastEstimate = est.minutes;
    t.lastRatio = est.ratio;
    t.kind = est.type;
    return { ...t, est, score: importance(t, est.type) };
  }).sort((a, b) => (!!a.done - !!b.done) || (b.score - a.score) || a.est.minutes - b.est.minutes);
  await saveTasks(Object.fromEntries(list.map(({ est, score, ...t }) => [t.id, t])));
  const left = list.filter((t) => !t.done);
  const done = list.filter((t) => t.done);
  const mins = left.reduce((s, t) => s + t.est.minutes, 0);
  $("summary").innerHTML = list.length ? `<span class="pill">${left.length} ${T.left}</span>${left.some((t) => t.missing) ? `<span class="pill miss">${left.filter((t) => t.missing).length} ${T.missingLbl}</span>` : ""}<span>⏱ ~${Math.floor(mins / 60)}h ${mins % 60}m</span>` : "";
  const now = $("now");
  const box = $("tasks");
  const doneBox = $("doneBox");
  now.innerHTML = "";
  box.innerHTML = "";
  doneBox.innerHTML = "";
  if (!list.length) {
    now.innerHTML = `<div class="empty">${T.none}</div>`;
    $("toggleRest").hidden = true;
    $("toggleDone").hidden = true;
    box.hidden = true;
    doneBox.hidden = true;
    return;
  }
  if (left[0]) now.appendChild(taskCard(left[0], true));
  const rest = left.slice(1);
  $("toggleRest").hidden = rest.length === 0;
  $("toggleRest").textContent = showRest ? T.hideRest : `${T.showRest} (${rest.length})`;
  box.hidden = !showRest || rest.length === 0;
  if (showRest) rest.forEach((t) => box.appendChild(taskCard(t, false)));
  $("toggleDone").hidden = done.length === 0;
  $("toggleDone").textContent = showDone ? T.hideDone : `${T.showDone} (${done.length})`;
  doneBox.hidden = !showDone || done.length === 0;
  if (showDone) done.forEach((t) => doneBox.appendChild(taskCard(t, false)));
}

$("toggleRest").onclick = () => { showRest = !showRest; render(); };
$("toggleDone").onclick = () => { showDone = !showDone; render(); };

// Teach the estimator how fast this student really works. Always compares against the estimate
// without their pace applied, so repeated samples converge on their true speed.
async function learnPace(t, estimatedMin, actualMin) {
  const ratio = t.lastRatio || 1;
  const pace = recordPace(await getPace(), t.kind || estimateTask(t).type, estimatedMin / ratio, actualMin);
  await savePace(pace);
}
async function learnFromTask(t, extraMs = 0) {
  if (t.stepLearned) return; // its steps already taught the estimator, don't count the same minutes twice
  const actualMin = ((t.actualMs || 0) + extraMs) / 60000;
  if (actualMin < 3) return;
  await learnPace(t, t.lastEstimate || estimateTask(t).minutes, actualMin);
}

async function toggleDone(t, checked) {
  const all = await getTasks();
  if (!all[t.id]) return;
  const doSubmit = checked && taskLink(t) && HAS_EXT && confirm(`${labelOf(t)}\n\n${T.confirm}`);
  all[t.id].done = checked;
  if (checked) {
    all[t.id].missing = false;
    await learnFromTask(all[t.id]);
  }
  await saveTasks(all);
  render();
  if (!checked) return;
  if (!doSubmit) return confetti(); // nothing to turn in from here, so celebrate right away
  // Turn in first. The portal tab opens (and closes this popup), and the confetti plays there once Turn in has been pressed.
  status("…");
  const r = await chrome.runtime.sendMessage({ type: "submit", url: taskLink(t) });
  status(r?.result === "clicked" ? T.submitted : T.manual);
}

async function openHelp(task) {
  status(T.helpHint);
  if (!HAS_EXT) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const r = await chrome.runtime.sendMessage({ type: "startHelp", tabId: tab?.id, task: task || null });
    if (r?.ok) window.close();
    else status(T.notPortal);
  } catch {
    status(T.notPortal);
  }
}
$("help").onclick = () => openHelp(null);
$("scan").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: "scan" });
    status(r?.platform ? `${r.platform}: ${T.found} ${r.found}` : T.notPortal);
  } catch { status(T.refreshPage); } // no script answered: the page was open before the extension was updated
  render();
};

// ---- Focus timer ----
// Saved as `focus` = { taskId, stepIdx, running, segStart, elapsed, extra, prompted } so it keeps running when the popup closes.
// Only running time counts. Pause banks the time so far; Resume continues from there. It never resets.
let timer, focusTask, focus = null, memFocus = null;
const loadFocus = async () => (HAS_EXT ? (await chrome.storage.local.get("focus")).focus || null : memFocus);
async function saveFocus(f) {
  focus = f;
  if (!HAS_EXT) { memFocus = f; return; }
  if (f) await chrome.storage.local.set({ focus: f }); else await chrome.storage.local.remove("focus");
}
function stepSeconds(t, i) {
  return Math.max(1, t.steps[i]?.min || 25) * 60;
}
const limitSec = () => stepSeconds(focusTask, focus.stepIdx) + (focus.extra || 0);
const elapsedMs = () => (focus.elapsed || 0) + (focus.running ? Date.now() - focus.segStart : 0);
function showTime(s) {
  const a = Math.abs(s); // past the limit it counts up (+mm:ss) so the real time keeps being measured
  $("timer").textContent = `${s < 0 ? "+" : ""}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
function paintTimer() {
  if (!focus || !focusTask) return;
  const left = limitSec() - Math.floor(elapsedMs() / 1000);
  showTime(left);
  $("timeUp").hidden = !(left <= 0 && elapsedMs() > 0); // "Need more time? Need more help?"
}
function paintStartBtn() {
  $("fStart").textContent = focus?.running ? T.pause : (focus?.elapsed || 0) > 0 ? T.resume : T.start;
}
function stopTick() { clearInterval(timer); timer = null; }
function startTick() { stopTick(); timer = setInterval(paintTimer, 500); paintTimer(); }
function paintFocus() {
  $("fTask").textContent = `${labelOf(focusTask)} · ${focus.stepIdx + 1}/${focusTask.steps.length}`;
  $("fStep").textContent = focusTask.steps[focus.stepIdx]?.text || T.sparkDone;
  paintTimer();
  paintStartBtn();
}
// Moves the running stretch into `elapsed` and into the task's total time. stop=true also pauses.
async function bank(stop = false) {
  focus = (await loadFocus()) || focus;
  if (!focus) return 0;
  const now = Date.now();
  const extra = focus.running ? now - focus.segStart : 0;
  if (extra) {
    const all = await getTasks();
    if (all[focus.taskId]) {
      all[focus.taskId].actualMs = (all[focus.taskId].actualMs || 0) + extra;
      await saveTasks(all);
      focusTask = all[focus.taskId];
    }
  }
  await saveFocus({ ...focus, elapsed: (focus.elapsed || 0) + extra, segStart: now, running: stop ? false : focus.running });
  return extra;
}
async function startFocus(t) {
  const all = await getTasks();
  const cur = await loadFocus();
  if (cur && cur.taskId !== t.id) { // switching tasks: keep the time already spent on the old one
    focus = cur;
    focusTask = all[cur.taskId];
    await bank(true);
  }
  focusTask = all[t.id] || t;
  const same = cur && cur.taskId === t.id && cur.stepIdx < focusTask.steps.length && !focusTask.steps[cur.stepIdx]?.done;
  if (same) focus = cur;
  else {
    const i = focusTask.steps.findIndex((s) => !s.done);
    await saveFocus({ taskId: t.id, stepIdx: Math.max(0, i), running: false, segStart: 0, elapsed: 0, extra: 0, prompted: false });
  }
  $("note").textContent = "";
  show("focus");
  paintFocus();
  focus.running ? startTick() : stopTick();
  paintLock();
}
// One button: Start -> Pause -> Resume.
$("fStart").onclick = async () => {
  focus = (await loadFocus()) || focus;
  if (!focus) return;
  if (focus.running) {
    await bank(true);
    stopTick();
  } else {
    await saveFocus({ ...focus, running: true, segStart: Date.now() });
    $("note").textContent = "";
    startTick();
  }
  paintFocus();
};
// Extra time: from the buttons or a typed number. The background worker also extends focus mode's lock.
async function addMinutes(m) {
  m = Math.round(Number(m));
  if (!(m >= 1 && m <= 120) || !focus) return;
  if (HAS_EXT) await chrome.runtime.sendMessage({ type: "focusExtend", minutes: m });
  else await saveFocus({ ...focus, extra: (focus.extra || 0) + m * 60, prompted: false });
  focus = (await loadFocus()) || focus;
  $("moreMin").value = "";
  paintFocus();
}
document.querySelectorAll("#timeUp [data-m]").forEach((b) => (b.onclick = () => addMinutes(b.dataset.m)));
$("moreAdd").onclick = () => addMinutes($("moreMin").value);
$("moreMin").addEventListener("keydown", (e) => { if (e.key === "Enter") addMinutes($("moreMin").value); });
if (HAS_EXT) chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.focus || !focusTask || $("focus").hidden) return;
  focus = ch.focus.newValue || focus; // e.g. the on-page "Need more time?" card added minutes
  paintFocus();
});

// How long the student really took on a step teaches the estimator, and the steps still ahead are re-estimated.
async function learnFromStep(taskId, i, ms) {
  const all = await getTasks();
  const t = all[taskId];
  const step = t?.steps?.[i];
  const actualMin = ms / 60000;
  if (!step || step.min < 5 || actualMin < 2) return; // quick steps (like "Submit") say little about pace
  await learnPace(t, step.min, actualMin);
  t.stepLearned = true;
  const est = estimateTask(t, await getPace());
  t.steps = mergeSteps(t.steps, est.steps);
  t.lastEstimate = est.minutes;
  t.lastRatio = est.ratio;
  await saveTasks(all);
}
$("fNext").onclick = async () => {
  await bank();
  const cur = focus;
  await learnFromStep(cur.taskId, cur.stepIdx, cur.elapsed || 0);
  const all = await getTasks();
  all[cur.taskId].steps[cur.stepIdx].done = true;
  await saveTasks(all);
  focusTask = all[cur.taskId];
  if (cur.stepIdx < focusTask.steps.length - 1) {
    // next step; keep the clock running if it was
    await saveFocus({ ...cur, stepIdx: cur.stepIdx + 1, elapsed: 0, extra: 0, prompted: false, segStart: Date.now() });
    paintFocus();
  } else {
    stopTick();
    await saveFocus(null);
    show("list");
    await toggleDone(focusTask, true);
  }
};
$("back").onclick = async () => { await bank(true); stopTick(); show("list"); render(); };
$("fHelp").onclick = () => openHelp(focusTask);

document.querySelectorAll("[data-i]").forEach((el) => (el.textContent = T[el.dataset.i]));
show("list");
render();
// If a timer was left running, reopen straight onto it.
(async () => {
  const f = await loadFocus();
  const t = f?.running ? (await getTasks())[f.taskId] : null;
  if (!t || t.done || !t.steps?.[f.stepIdx]) return;
  focus = f;
  focusTask = t;
  show("focus");
  paintFocus();
  startTick();
  paintLock();
})();

// ---- Focus mode (lock in) ----
async function lockState() {
  if (!HAS_EXT) return { on: false };
  try { return (await chrome.runtime.sendMessage({ type: "lockState" })) || { on: false }; } catch { return { on: false }; }
}
async function paintLock() {
  const s = await lockState();
  $("fLock").textContent = s.on ? T.unlock : T.lock;
  $("lockBar").hidden = !s.on;
  $("lockBar").textContent = `${T.lockOn} ${T.unlock}`;
  return s;
}
$("fLock").onclick = async () => {
  if (!HAS_EXT) return;
  if ((await lockState()).on) {
    await chrome.runtime.sendMessage({ type: "lockEnd" });
    return paintLock();
  }
  await bank(); // credit time so far; the running timer keeps counting while locked
  const left = Math.max(60, limitSec() - Math.floor(elapsedMs() / 1000)); // lock for the time that is left
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const r = await chrome.runtime.sendMessage({
    type: "lockStart", tabId: tab?.id, url: taskLink(focusTask), taskId: focusTask.id, seconds: left,
  });
  if (!r?.ok) { $("note").textContent = r?.error || T.lockFail; return; }
  window.close();
};
$("lockBar").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "lockEnd" });
  paintLock();
};
paintLock();
