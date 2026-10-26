// Submit helper + walkthrough capture + AI coach calls + focus-timer alarms.
// The crop is taken locally. With an API key, the selected part (plus the assignment title/description) goes to the provider the student set up;
// with no key, Chrome's built-in on-device AI answers and nothing leaves the computer.
importScripts("coach.js", "ai.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// First install: open the setup page so the student can add an API key.
chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === "install") chrome.runtime.openOptionsPage();
});

function pressSubmit() {
  const re = /^(turn in|mark as done|hand in|submit|submit assignment|submit quiz|submit for grading)$/i;
  const btns = [...document.querySelectorAll("button, [role=button], input[type=submit]")].filter(
    (b) => re.test((b.innerText || b.value || b.getAttribute("aria-label") || "").trim()) && !b.disabled && b.offsetParent
  );
  if (!btns.length) return "none";
  btns[0].click();
  return "clicked";
}

// Runs inside the portal tab right after Turn in was clicked (the popup is already closed by then).
function pageConfetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const c = document.createElement("canvas");
  const w = (c.width = innerWidth), h = (c.height = innerHeight);
  c.style.cssText = "position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647";
  document.documentElement.appendChild(c);
  const g = c.getContext("2d");
  const colors = ["#3f7d5c", "#f3c04a", "#e8734a", "#5b9bd5", "#c06ccf", "#7ccf9a"];
  const ps = Array.from({ length: 140 }, () => ({
    x: w / 2 + (Math.random() - 0.5) * 80, y: h * 0.4,
    vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 12 - 3,
    s: 6 + Math.random() * 7, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  (function frame(now) {
    const t = now - t0;
    g.clearRect(0, 0, w, h);
    for (const p of ps) {
      p.vy += 0.3; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      g.save();
      g.globalAlpha = Math.max(0, Math.min(1, (2600 - t) / 800));
      g.translate(p.x, p.y); g.rotate(p.r); g.fillStyle = p.c;
      g.fillRect(-p.s / 2, -p.s / 3, p.s, p.s * 0.66);
      g.restore();
    }
    if (t < 2600) requestAnimationFrame(frame); else c.remove();
  })(t0);
}

async function injectHelp(tabId, task) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["help-overlay.js"] });
  await chrome.tabs.sendMessage(tabId, { type: "startHelp", task: task || null });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

async function cropCapture(tab, rect) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const dpr = rect.dpr || 1;
  const x = Math.max(0, Math.round(rect.x * dpr));
  const y = Math.max(0, Math.round(rect.y * dpr));
  const w = Math.max(1, Math.min(bmp.width - x, Math.round(rect.w * dpr)));
  const h = Math.max(1, Math.min(bmp.height - y, Math.round(rect.h * dpr)));
  // Keep uploads small: a downscaled JPEG is a fraction of the size of a full-resolution PNG, which speeds up every request.
  const scale = Math.min(1, 1280 / Math.max(w, h));
  const ow = Math.max(1, Math.round(w * scale));
  const oh = Math.max(1, Math.round(h * scale));
  const canvas = new OffscreenCanvas(ow, oh);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // JPEG has no transparency
  ctx.fillRect(0, 0, ow, oh);
  ctx.drawImage(bmp, x, y, w, h, 0, 0, ow, oh);
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
  return blobToDataUrl(out);
}

// ---- Free on-device AI (no key) ----------------------------------------------
// Chrome's built-in model can't run in this service worker, so it runs in an offscreen document (offscreen.js).
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Runs Chrome's built-in on-device AI model, which needs a window context.",
    });
  } catch (e) {
    if (!/single offscreen|already exists/i.test(e?.message || "")) throw e;
  }
}

// Ask the offscreen document. Retries the connection briefly in case it was only just created.
async function aiCoachOnDevice(msg, onDelta) {
  try { await ensureOffscreen(); } catch { return { needsSetup: true, reason: "unsupported" }; }
  const payload = { type: "ask", system: COACH_SYSTEM, turns: buildTurns(msg), dataUrl: msg.dataUrl };
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await new Promise((resolve) => {
      let got = false;
      const port = chrome.runtime.connect({ name: "ondevice" });
      port.onMessage.addListener((m) => {
        got = true;
        if (m?.delta) onDelta?.(m.delta);
        else if (m?.done) { resolve(m.res || {}); try { port.disconnect(); } catch { /* closed */ } }
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError; // read it so Chrome doesn't log "unchecked" when nobody was listening yet
        resolve(got ? {} : null); // null = retry
      });
      port.postMessage(payload);
    });
    if (res) return res;
    await wait(250);
  }
  return { needsSetup: true, reason: "unsupported" };
}

function buildTurns(msg) {
  const first = coachUserMessage(
    msg.task, msg.level,
    msg.dataUrl ? "A picture of the selected area may be attached." : "",
    1500, msg.pageText,
  );
  const chat = (msg.chat || []).map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: String(m.text || "").slice(0, 2000) }));
  const turns = [{ role: "user", text: first }, ...chat];
  if (turns[turns.length - 1].role === "assistant") turns.push({ role: "user", text: "Next hint, please." });
  return turns;
}

const cleanReply = (t) => String(t).replace(/\*\*/g, "").replace(/^#{1,6}\s*/gm, "").replace(/`/g, "").trim().slice(0, 2500);

// onDelta(chunk) is optional; when given, the reply streams as it is generated.
async function coachAsk(msg, onDelta) {
  const { ai } = await chrome.storage.local.get("ai");
  if (ai?.key && AI_PROVIDERS[ai.provider]) {
    try {
      const before = ai.resolvedModel;
      const meta = {};
      const text = await callAI(ai, { system: COACH_SYSTEM, turns: buildTurns(msg), image: msg.dataUrl, onDelta, meta });
      if (ai.resolvedModel !== before) await chrome.storage.local.set({ ai }); // remember the auto-picked model
      console.log(`[TaskBite] ${meta.model}: first text ${meta.ttfb ?? "?"}ms, done ${meta.ms}ms, image ${Math.round((msg.dataUrl?.length || 0) / 1024)}KB`);
      return { text: cleanReply(text), via: "api", image: !!msg.dataUrl, ms: meta.ms, ttfb: meta.ttfb, model: meta.model || aiModelName(ai) };
    } catch (e) {
      return aiFriendlyError(e);
    }
  }
  return aiCoachOnDevice(msg, onDelta);
}

// Streaming channel used by the help panel: {delta} messages while the reply is written, then {done, res}.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "coach") return;
  let gone = false;
  port.onDisconnect.addListener(() => { gone = true; });
  const send = (m) => { if (!gone) { try { port.postMessage(m); } catch { gone = true; } } };
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== "coachAsk") return;
    let res;
    try { res = await coachAsk(msg, (chunk) => send({ delta: chunk })); } catch { res = {}; }
    send({ done: true, res });
  });
});

// ---- Focus mode (lockdown-style) --------------------------------------------
// While it is on, a network rule sends every top-level page outside the assignment's site (plus the allowed list) to blocked.html.
// Session rules disappear when the browser closes, so a lock can never survive a restart.
const LOCK_RULE = 1;
const LOCK_ALARM = "taskbite-unlock";
const DEFAULT_ALLOW = ["accounts.google.com", "docs.google.com", "drive.google.com", "classroom.google.com", "sites.google.com", "forms.gle", "login.microsoftonline.com"];

const getLock = async () => (await chrome.storage.session.get("lock")).lock || null;

function baseDomain(host) {
  const parts = host.split(".");
  if (parts.length <= 2 || /(^|\.)google\.com$/.test(host)) return host;
  const tld = parts[parts.length - 1], sld = parts[parts.length - 2];
  if (tld.length === 2 && ["co", "com", "org", "net", "gov", "edu", "ac"].includes(sld)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

function urlAllowed(url, lock) {
  try {
    const u = new URL(url);
    if (u.protocol === "chrome-extension:") return u.hostname === chrome.runtime.id;
    if (!/^https?:$/.test(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    return lock.hosts.some((d) => h === d || h.endsWith("." + d));
  } catch { return false; }
}

// Blocks a top-level page only when it is on no allowed site AND was not reached from an allowed page.
// So links, redirects and "open in new tab" from the assignment (a Google Doc or Slides, an outside site, a login page) always work,
// while typed addresses and bookmarks to other sites are blocked. Sites the assignment leads to are added to the allowed list as you land on them.
function lockRule(lock) {
  const condition = { urlFilter: "|http", resourceTypes: ["main_frame"], excludedRequestDomains: lock.hosts, excludedInitiatorDomains: lock.hosts };
  if (lock.grace) condition.excludedTabIds = [lock.tabId]; // while the assignment tab first loads, let any redirect (like a login) through
  return { id: LOCK_RULE, priority: 1, action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } }, condition };
}
const applyRule = (lock) => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [LOCK_RULE], addRules: [lockRule(lock)] });

let lockQueue = Promise.resolve();
function updateLock(fn) { // one change at a time; fn(lock) returns true when it changed something
  lockQueue = lockQueue.then(async () => {
    const lock = await getLock();
    if (!lock || !fn(lock)) return;
    await chrome.storage.session.set({ lock });
    await applyRule(lock);
  }).catch(() => {});
  return lockQueue;
}
function learnHost(url) {
  let h;
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return; h = u.hostname.toLowerCase(); } catch { return; }
  updateLock((lock) => {
    if (lock.hosts.some((d) => h === d || h.endsWith("." + d))) return false;
    lock.hosts.push(h);
    return true;
  });
}

// Runs inside the locked page: a small pill with a countdown and an Exit button, plus short messages.
function pageLockUI(o) {
  let host = document.getElementById("taskbite-lock-host");
  if (o.remove) { host?.remove(); return; }
  if (!host) {
    host = document.createElement("div");
    host.id = "taskbite-lock-host";
    host.style.cssText = "all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:8px;padding-top:10px;";
    const sh = host.attachShadow({ mode: "open" });
    sh.innerHTML = '<style>.pill{pointer-events:auto;display:flex;align-items:center;gap:10px;background:#26302b;color:#fff;font:600 14px system-ui,sans-serif;padding:8px 8px 8px 14px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.25)}.t{font-variant-numeric:tabular-nums;color:#a8d9bc}button{font:600 13px system-ui,sans-serif;background:#fff;color:#26302b;border:0;border-radius:999px;padding:6px 12px;cursor:pointer}.toast{pointer-events:none;background:#fffdf8;color:#26302b;font:600 14px system-ui,sans-serif;padding:10px 16px;border-radius:14px;box-shadow:0 6px 20px rgba(0,0,0,.2);max-width:90vw;text-align:center}[hidden]{display:none}</style><div class="pill"><span>🔒 Focus mode</span><span class="t"></span><button>Exit</button></div><div class="toast" hidden></div>';
    sh.querySelector("button").onclick = () => { if (confirm("Leave focus mode?")) chrome.runtime.sendMessage({ type: "lockEnd" }); };
    document.documentElement.appendChild(host);
  }
  const sh = host.shadowRoot;
  const pill = sh.querySelector(".pill"), clock = sh.querySelector(".t"), toast = sh.querySelector(".toast");
  clearInterval(window.__tbTick);
  if (o.ending) {
    pill.hidden = true;
  } else if (o.endsAt) {
    pill.hidden = false;
    const tick = () => {
      const s = Math.max(0, Math.round((o.endsAt - Date.now()) / 1000));
      clock.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    };
    tick();
    window.__tbTick = setInterval(tick, 1000);
  }
  if (o.toast) {
    toast.textContent = o.toast;
    toast.hidden = false;
    clearTimeout(window.__tbToast);
    window.__tbToast = setTimeout(() => { toast.hidden = true; if (o.ending) host.remove(); }, o.ending ? 5000 : 3500);
  }
}
async function lockUI(tabId, o) {
  try { await chrome.scripting.executeScript({ target: { tabId }, func: pageLockUI, args: [o] }); } catch { /* tab can't be scripted */ }
}

async function startLock({ tabId, url, seconds, taskId }) {
  if (await getLock()) await endLock(false);
  let tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const webHost = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.hostname.toLowerCase() : ""; } catch { return ""; } };
  const taskHost = webHost(url || "");
  const tabHost = webHost(tab?.url || "");
  let opened = false;
  if (taskHost && (!tabHost || baseDomain(tabHost) !== baseDomain(taskHost))) { tab = await chrome.tabs.create({ url, active: true }); opened = true; }
  const host = taskHost || tabHost;
  if (!tab || !host) return { ok: false, error: "Open your assignment page first." };

  const { allowSites } = await chrome.storage.local.get("allowSites");
  const hosts = [...new Set([baseDomain(host), ...(allowSites || DEFAULT_ALLOW)].map((h) => String(h).trim().toLowerCase()).filter(Boolean))];
  const secs = Math.max(60, Math.min(4 * 3600, Math.round(Number(seconds) || 1500)));
  const old = (await chrome.tabs.query({})).map((t) => t.id).filter((id) => id !== tab.id); // tabs that were already open
  const lock = { tabId: tab.id, windowId: tab.windowId, hosts, old, grace: opened, taskId: taskId || "", startedAt: Date.now(), endsAt: Date.now() + secs * 1000 };

  await chrome.storage.session.set({ lock });
  await applyRule(lock);
  chrome.alarms.create(LOCK_ALARM, { when: lock.endsAt });
  refreshBadge();
  // Not fullscreen on purpose: the browser toolbar (and this extension's icon) must stay reachable.
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  lockUI(tab.id, { endsAt: lock.endsAt });
  return { ok: true, endsAt: lock.endsAt, hosts };
}

async function endLock(finished) {
  const lock = await getLock();
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [LOCK_RULE] }).catch(() => {});
  await chrome.storage.session.remove("lock");
  chrome.alarms.clear(LOCK_ALARM);
  refreshBadge();
  if (!lock) return;
  lockUI(lock.tabId, finished ? { ending: true, toast: "Focus time is over. Nice work!" } : { remove: true });
  const f = await getFocus();
  if (lock.taskId && f?.taskId !== lock.taskId) { // count the locked time toward this task's pace (a running focus timer already does)
    const { tasks = {} } = await chrome.storage.local.get("tasks");
    if (tasks[lock.taskId]) {
      tasks[lock.taskId].actualMs = (tasks[lock.taskId].actualMs || 0) + (Date.now() - lock.startedAt);
      await chrome.storage.local.set({ tasks });
    }
  }
}

async function bounce(lock) {
  await chrome.windows.update(lock.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(lock.tabId, { active: true }).catch(() => {});
  lockUI(lock.tabId, { toast: "Focus mode is on. Finish up or tap Exit." });
}

// Web pages are handled by the network rule. This catches what it can't: new-tab pages and chrome:// pages.
async function enforceTab(tab) {
  const lock = await getLock();
  if (!lock || !tab?.id) return;
  const url = tab.pendingUrl || tab.url || "";
  if (!url || url === "about:blank" || /^https?:/.test(url) || url.startsWith("chrome-error:") || url.startsWith(chrome.runtime.getURL(""))) return;
  if (tab.id === lock.tabId) chrome.tabs.goBack(tab.id).catch(() => {});
  else chrome.tabs.remove(tab.id).catch(() => {});
  lockUI(lock.tabId, { toast: "Focus mode is on. Finish up or tap Exit." });
}

chrome.tabs.onCreated.addListener(enforceTab);
chrome.tabs.onUpdated.addListener(async (id, info, tab) => {
  if (info.url) { enforceTab(tab); learnHost(info.url); } // a page that loaded got past the rule, so it belongs to the assignment
  if (info.status === "complete") {
    updateLock((lock) => { // the assignment tab finished its first load: from now on the rule applies to it too
      if (lock.tabId !== id || !lock.grace) return false;
      lock.grace = false;
      return true;
    });
    const lock = await getLock();
    if (lock && lock.tabId === id) lockUI(id, { endsAt: lock.endsAt });
  }
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const lock = await getLock();
  if (!lock || tabId === lock.tabId) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.url || tab?.pendingUrl || "";
  if (tab && url && lock.old?.includes(tabId) && !urlAllowed(url, lock)) bounce(lock); // only tabs that were open before locking
});
chrome.windows.onFocusChanged.addListener(async (wid) => {
  const lock = await getLock();
  if (!lock || wid === chrome.windows.WINDOW_ID_NONE || wid === lock.windowId) return;
  const tabs = await chrome.tabs.query({ active: true, windowId: wid }).catch(() => []);
  if (tabs[0] && lock.old?.includes(tabs[0].id) && !urlAllowed(tabs[0].url || "", lock)) bounce(lock);
});
chrome.tabs.onRemoved.addListener(async (id) => {
  const lock = await getLock();
  if (lock && lock.tabId === id) endLock(false); // closing the assignment tab always ends the lock
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === LOCK_ALARM) endLock(true); });

// Safety net: if no lock is recorded (e.g. after a restart), make sure no blocking rule is left behind.
getLock().then((l) => {
  if (!l) {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [LOCK_RULE] }).catch(() => {});
  }
  refreshBadge();
  scheduleTimer();
});


// ---- Focus timer: "Need more time? Need more help?" ------------------------------------
// The popup owns the timer and saves it as `focus` = { taskId, stepIdx, running, segStart, elapsed, extra, prompted }.
// Because it is saved, the timer keeps running when the popup closes. This worker sets an alarm for the moment time runs out
// and shows a small card on the page, since the popup is usually closed by then.
const TIMER_ALARM = "taskbite-timeup";
const getFocus = async () => (await chrome.storage.local.get("focus")).focus || null;

async function focusLimitMs(f) {
  const { tasks = {} } = await chrome.storage.local.get("tasks");
  const min = tasks[f.taskId]?.steps?.[f.stepIdx]?.min || 25;
  return (Math.max(1, min) * 60 + (f.extra || 0)) * 1000;
}
const focusElapsedMs = (f) => (f.elapsed || 0) + (f.running ? Date.now() - f.segStart : 0);

async function refreshBadge() {
  const [f, lock] = await Promise.all([getFocus(), getLock()]);
  if (f?.running && f.prompted) {
    chrome.action.setBadgeBackgroundColor({ color: "#c2722d" });
    chrome.action.setBadgeText({ text: "TIME" });
  } else if (lock) {
    chrome.action.setBadgeBackgroundColor({ color: "#3f7d5c" });
    chrome.action.setBadgeText({ text: "ON" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

async function scheduleTimer() {
  await chrome.alarms.clear(TIMER_ALARM);
  const f = await getFocus();
  if (!f?.running || f.prompted) return;
  const left = (await focusLimitMs(f)) - focusElapsedMs(f);
  chrome.alarms.create(TIMER_ALARM, { when: Date.now() + Math.max(left, 1000) });
}

// Runs inside the page: a card with extra-time choices, a box to type your own, and a help button.
function pageTimeUp(o) {
  let host = document.getElementById("taskbite-timeup-host");
  host?.remove();
  if (o.remove) return;
  host = document.createElement("div");
  host.id = "taskbite-timeup-host";
  host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;";
  const sh = host.attachShadow({ mode: "open" });
  sh.innerHTML = '<style>*{box-sizing:border-box}.c{width:300px;background:#f6f4ee;color:#26302b;font:15px/1.35 system-ui,sans-serif;border-radius:18px;padding:14px;box-shadow:0 16px 50px rgba(0,0,0,.28);display:grid;gap:10px}h2{margin:0;font-size:17px}p{margin:0;color:#6d756f;font-size:13px}.r{display:flex;gap:8px}button{font:600 14px system-ui,sans-serif;border:0;border-radius:12px;padding:10px 12px;cursor:pointer}.t{flex:1;background:#3f7d5c;color:#fff}.h{background:#f3e6c8;color:#5c4a22}.g{background:#fff;color:#26302b;border:1.5px solid #c9c3b6}input{flex:1;min-width:0;font:inherit;padding:9px 10px;border:1.5px solid #cfc9bb;border-radius:10px}.x{position:absolute;top:8px;right:10px;background:none;padding:2px 6px;color:#6d756f;font-size:16px}</style><div class="c"><button class="x" title="Close">✕</button><h2>Time\u2019s up for this step</h2><p class="n"></p><div class="r"><button class="t" data-m="5">+5 min</button><button class="t" data-m="10">+10 min</button><button class="t" data-m="15">+15 min</button></div><div class="r"><input type="number" min="1" max="120" placeholder="Type minutes" /><button class="g add">Add</button></div><button class="h help">Need more help? Get help</button></div>';
  sh.querySelector(".n").textContent = `${o.name ? o.name + ". " : ""}Need more time? Need more help?`;
  ["keydown", "keyup", "keypress"].forEach((t) => sh.addEventListener(t, (e) => e.stopPropagation()));
  const extend = (m) => {
    m = Math.round(Number(m));
    if (!(m >= 1 && m <= 120)) return;
    chrome.runtime.sendMessage({ type: "focusExtend", minutes: m });
    host.remove();
  };
  sh.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => extend(b.dataset.m)));
  const input = sh.querySelector("input");
  sh.querySelector(".add").onclick = () => extend(input.value);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") extend(input.value); });
  sh.querySelector(".help").onclick = () => { chrome.runtime.sendMessage({ type: "focusHelp" }); host.remove(); };
  sh.querySelector(".x").onclick = () => host.remove();
  document.documentElement.appendChild(host);
}

async function timeUpUI(tabId, o) {
  try { await chrome.scripting.executeScript({ target: { tabId }, func: pageTimeUp, args: [o] }); return true; } catch { return false; }
}

async function onTimeUp() {
  const f = await getFocus();
  if (!f?.running || f.prompted) return;
  if ((await focusLimitMs(f)) - focusElapsedMs(f) > 2000) return scheduleTimer(); // state changed since the alarm was set
  f.prompted = true;
  const { tasks = {} } = await chrome.storage.local.get("tasks");
  const lock = await getLock();
  let tabId = lock?.tabId;
  if (!tabId) tabId = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  if (tabId && (await timeUpUI(tabId, { name: tasks[f.taskId]?.name || "" }))) await chrome.storage.session.set({ timeupTab: tabId });
  await chrome.storage.local.set({ focus: f }); // onChanged paints the TIME badge
}

async function clearTimeUpUI() {
  const { timeupTab } = await chrome.storage.session.get("timeupTab");
  if (!timeupTab) return;
  await chrome.storage.session.remove("timeupTab");
  timeUpUI(timeupTab, { remove: true });
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.focus) return;
  scheduleTimer();
  refreshBadge();
  const nf = ch.focus.newValue;
  if (!(nf?.running && nf.prompted)) clearTimeUpUI();
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === TIMER_ALARM) onTimeUp(); });

// Add minutes to the running step (and to focus mode's lock, if it is on).
async function extendFocus(minutes) {
  const m = Math.round(Number(minutes));
  const f = await getFocus();
  if (!f || !(m >= 1 && m <= 120)) return { ok: false };
  f.extra = (f.extra || 0) + m * 60;
  f.prompted = false;
  await chrome.storage.local.set({ focus: f });
  if (await getLock()) {
    await updateLock((l) => { l.endsAt = Math.max(l.endsAt, Date.now()) + m * 60000; return true; });
    const l = await getLock();
    if (l) {
      chrome.alarms.create(LOCK_ALARM, { when: l.endsAt });
      lockUI(l.tabId, { endsAt: l.endsAt });
    }
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "submit") {
    (async () => {
      const tab = await chrome.tabs.create({ url: msg.url, active: true });
      await new Promise((res) => {
        const l = (id, info) => { if (id === tab.id && info.status === "complete") { chrome.tabs.onUpdated.removeListener(l); res(); } };
        chrome.tabs.onUpdated.addListener(l);
      });
      await wait(3000);
      const run = async () => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pressSubmit }))[0].result;
      const first = await run();
      if (first === "clicked") { await wait(1500); await run(); }
      // Turn in first, then celebrate.
      if (first === "clicked") await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageConfetti }).catch(() => {});
      reply({ result: first });
    })().catch((e) => reply({ result: "error", error: e.message }));
    return true;
  }
  if (msg.type === "startHelp") {
    (async () => {
      let tabId = msg.tabId || sender.tab?.id;
      if (!tabId) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = tab?.id;
      }
      if (!tabId) throw new Error("no tab");
      await injectHelp(tabId, msg.task);
      reply({ ok: true });
    })().catch((e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "cropCapture") {
    (async () => {
      const tab = sender.tab;
      if (!tab) throw new Error("no tab");
      const dataUrl = await cropCapture(tab, msg.rect);
      reply({ dataUrl });
    })().catch((e) => reply({ error: e.message }));
    return true;
  }
  if (msg.type === "coachAsk") {
    coachAsk(msg).then(reply).catch(() => reply({}));
    return true;
  }
  if (msg.type === "aiTest") {
    const t0 = Date.now();
    const done = () => reply({ ok: true, resolvedModel: msg.cfg.resolvedModel || "", model: aiModelName(msg.cfg), ms: Date.now() - t0 });
    callAI(msg.cfg, {
      system: "This is a connection test. Reply with the single word: ok",
      turns: [{ role: "user", text: "ping" }],
      maxTokens: 50,
    })
      .then(done)
      .catch((e) => (e?.code === "empty" ? done() : reply({ ok: false, ...aiFriendlyError(e), status: e?.status })));
    return true;
  }
  if (msg.type === "lockStart") {
    startLock(msg).then(reply).catch((e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "lockEnd") {
    endLock(false).then(() => reply({ ok: true })).catch(() => reply({ ok: false }));
    return true;
  }
  if (msg.type === "lockState") {
    getLock().then((l) => reply({ on: !!l, endsAt: l?.endsAt || 0 }));
    return true;
  }
  if (msg.type === "lockBounce") {
    (async () => {
      const l = await getLock();
      if (!l) return reply({ ended: true });
      if (sender.tab?.id === l.tabId) return reply({ sameTab: true });
      if (sender.tab?.id) chrome.tabs.remove(sender.tab.id).catch(() => {});
      bounce(l);
      reply({});
    })();
    return true;
  }
  if (msg.type === "focusExtend") {
    extendFocus(msg.minutes).then(reply).catch(() => reply({ ok: false }));
    return true;
  }
  if (msg.type === "focusHelp") {
    (async () => {
      const f = await getFocus();
      const { tasks = {} } = await chrome.storage.local.get("tasks");
      const tabId = sender.tab?.id || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
      if (!tabId) throw new Error("no tab");
      await injectHelp(tabId, tasks[f?.taskId] || null);
      reply({ ok: true });
    })().catch((e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "openOptions") {
    chrome.runtime.openOptionsPage();
    reply({ ok: true });
    return false;
  }
});
