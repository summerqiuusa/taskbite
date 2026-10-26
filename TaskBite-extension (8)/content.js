// Detects school portals and pulls assignments into chrome.storage.
(() => {
  const host = location.hostname;
  function detect() {
    if (host === "classroom.google.com") return "Google Classroom";
    if (host.includes("instructure.com") || document.querySelector('link[href*="instructure"], #application.ic-app')) return "Canvas";
    if (window.M?.cfg || document.querySelector('body[class*="pagelayout-"]') || /moodle/i.test(document.querySelector('meta[name="keywords"]')?.content || "")) return "Moodle";
    if (host.includes("blackboard") || document.querySelector("#bb-learn, bb-base-layout, .bb-ui")) return "Blackboard";
    if (host.includes("schoology")) return "Schoology";
    return null;
  }

  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
  // Canvas's planner API returns relative links ("/courses/1/assignments/2"). Make every link absolute so it opens from the popup
  // and the same assignment from two endpoints gets the same id.
  function absUrl(u) {
    try { const x = new URL(u, location.href); x.hash = ""; return /^https?:$/.test(x.protocol) ? x.href : ""; } catch { return ""; }
  }
  const dueFrom = (t) => (t.match(/(due[:\s][^|•\n]{3,40})/i) || [])[1] || "";

  // Best-effort date from page text ("Oct 5, 11:59 PM"). Chrome assumes 2001 when the year is missing, so fix that.
  function parseDue(text) {
    if (!text) return null;
    const d = new Date(String(text).replace(/^due[:\s]*/i, ""));
    if (Number.isNaN(+d)) return null;
    if (d.getFullYear() < 2015) d.setFullYear(new Date().getFullYear());
    return +d;
  }

  const MISSING_RE = /\b(missing|overdue|late|past due|not turned in|not submitted|no submission|unsubmitted|incomplete|missed)\b/i;

  function fromLinks(platform, pattern, scope = document) {
    const seen = new Set(), out = [];
    scope.querySelectorAll("a[href]").forEach((a) => {
      if (!pattern.test(a.href) || seen.has(a.href)) return;
      const name = clean(a.innerText || a.getAttribute("aria-label"));
      if (name.length < 3 || name.length > 160) return;
      seen.add(a.href);
      const box = a.closest("li, tr, [role=listitem], .event, .card, div");
      const near = box?.innerText || "";
      const due = clean(dueFrom(box?.innerText || ""));
      const dueAt = parseDue(due);
      out.push({ id: a.href, platform, missing: MISSING_RE.test(near), name: name.split(" Due")[0], due, url: a.href, desc: clean(box?.innerText).slice(0, 600), ...(dueAt ? { dueAt } : {}) });
    });
    return out;
  }

  async function canvasGet(path) {
    const all = [];
    let url = path.startsWith("http") ? path : `${location.origin}${path}`;
    for (let i = 0; i < 6 && url; i++) {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) break;
      const data = await r.json();
      if (!Array.isArray(data)) return all.length ? all : data;
      all.push(...data);
      url = ((r.headers.get("Link") || "").match(/<([^>]+)>;\s*rel="next"/) || [])[1] || "";
    }
    return all;
  }

  function canvasTask(platform, a, extra = {}) {
    const url = absUrl(a.html_url || extra.url);
    if (!url) return null;
    const dueRaw = a.due_at || extra.due_at;
    const dueDate = dueRaw ? new Date(dueRaw) : null;
    const submitted = extra.submitted;
    const pastDue = dueDate && !Number.isNaN(+dueDate) && dueDate < new Date();
    return {
      id: url,
      platform,
      missing: !!(extra.missing || (pastDue && !submitted)),
      name: a.name || a.title || extra.name || "Assignment",
      due: dueDate && !Number.isNaN(+dueDate) ? dueDate.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "",
      ...(dueDate && !Number.isNaN(+dueDate) ? { dueAt: +dueDate } : {}),
      url,
      points: a.points_possible || extra.points || 0,
      desc: extra.desc || clean((a.description || "").replace(/<[^>]+>/g, " ")).slice(0, 1500),
      course: extra.course || a.course?.name,
    };
  }

  function mergeFound(lists) {
    const map = new Map();
    for (const t of lists.flat()) {
      if (!t?.id) continue;
      const prev = map.get(t.id);
      if (!prev) { map.set(t.id, t); continue; }
      map.set(t.id, {
        ...prev,
        ...t,
        missing: !!(prev.missing || t.missing),
        desc: (t.desc || "").length > (prev.desc || "").length ? t.desc : prev.desc,
        points: t.points || prev.points,
        course: t.course || prev.course,
        due: t.due || prev.due,
        dueAt: t.dueAt || prev.dueAt,
      });
    }
    return [...map.values()];
  }

  async function parse(platform) {
    if (platform === "Canvas") {
      try {
        const past = new Date(Date.now() - 120 * 864e5).toISOString();
        const future = new Date(Date.now() + 60 * 864e5).toISOString();
        const [todo, missing, planner] = await Promise.all([
          canvasGet("/api/v1/users/self/todo?per_page=50"),
          canvasGet("/api/v1/users/self/missing_submissions?per_page=50&include[]=course"),
          canvasGet(`/api/v1/planner/items?start_date=${encodeURIComponent(past)}&end_date=${encodeURIComponent(future)}&per_page=50`),
        ]);
        const fromTodo = (Array.isArray(todo) ? todo : []).map((i) => {
          const a = i.assignment || i.quiz || i;
          return canvasTask(platform, a, { course: i.context_name, url: a.html_url || i.html_url });
        });
        const fromMissing = (Array.isArray(missing) ? missing : []).map((a) => canvasTask(platform, a, { missing: true, course: a.course?.name }));
        const fromPlanner = (Array.isArray(planner) ? planner : []).filter((p) => {
          if (!/assignment|quiz|discussion_topic/i.test(p.plannable_type || "")) return false;
          const sub = p.submissions || {};
          if (sub.missing) return true;
          return !(sub.submitted || sub.graded || sub.excused);
        }).map((p) => {
          const a = p.plannable || {};
          const sub = p.submissions || {};
          return canvasTask(platform, a, {
            url: a.html_url || p.html_url,
            due_at: a.due_at || p.plannable_date,
            missing: !!sub.missing,
            submitted: !!(sub.submitted || sub.graded),
            course: p.context_name,
            points: a.points_possible,
            name: a.name || a.title,
          });
        });
        const combined = mergeFound([fromMissing, fromPlanner, fromTodo]).filter(Boolean);
        if (combined.length) return combined;
      } catch { /* fall through to page scrape */ }
      return fromLinks(platform, /\/(assignments|quizzes|discussion_topics)\/\d+/);
    }
    if (platform === "Google Classroom") return fromLinks(platform, /\/c\/[^/]+\/(a|sa|mc)\/[^/]+/);
    if (platform === "Moodle") return fromLinks(platform, /\/mod\/(assign|quiz|forum|workshop|lesson)\/view\.php/);
    if (platform === "Blackboard") return fromLinks(platform, /(uploadAssignment|\/outline\/assessment|\/assessment\/|launchAssessment)/);
    if (platform === "Schoology") return fromLinks(platform, /\/(assignment|assessment)\/\d+/);
    return [];
  }

  async function scan() {
    const platform = detect();
    if (!platform) return { platform: null, found: 0 };
    const found = await parse(platform);
    const { tasks = {} } = await chrome.storage.local.get("tasks");
    if (platform === "Canvas") { // fix tasks saved earlier with a relative link
      for (const key of Object.keys(tasks)) {
        if (/^https?:/i.test(key)) continue;
        const abs = absUrl(key), old = tasks[key];
        delete tasks[key];
        if (!abs) continue;
        const cur = tasks[abs];
        tasks[abs] = cur
          ? { ...cur, done: !!(cur.done || old.done), actualMs: Math.max(cur.actualMs || 0, old.actualMs || 0) }
          : { ...old, id: abs, url: abs };
      }
    }
    for (const t of found) {
      const prev = tasks[t.id];
      tasks[t.id] = {
        ...prev,
        ...t,
        course: t.platform === "Canvas" ? (t.course || prev?.course) : undefined,
        done: prev?.done || false,
        steps: prev?.steps?.length <= 3 ? prev.steps : undefined,
        missing: !!(t.missing || prev?.missing),
        actualMs: prev?.actualMs || 0,
        lastEstimate: prev?.lastEstimate,
      };
    }
    const { origins = {} } = await chrome.storage.local.get("origins");
    origins[platform] = location.origin; // lets the popup open relative links without another scan
    await chrome.storage.local.set({ tasks, lastPlatform: platform, origins });
    return { platform, found: found.length };
  }

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.type === "scan") { scan().then(reply); return true; }
  });
  if (detect()) {
    setTimeout(scan, 2500);
    const chipHost = document.createElement("div");
    window.__taskbiteChip = chipHost;
    chipHost.style.all = "initial";
    chipHost.style.position = "fixed";
    chipHost.style.zIndex = "2147483000";
    const shadow = chipHost.attachShadow({ mode: "open" });
    const btn = document.createElement("button");
    btn.textContent = "I need help";
    btn.style.cssText = "position:fixed;right:16px;bottom:16px;font:600 14px system-ui,sans-serif;background:#3f7d5c;color:#fff;border:0;border-radius:999px;padding:10px 14px;cursor:pointer;box-shadow:0 8px 24px rgba(63,125,92,.35)";
    btn.onclick = () => chrome.runtime.sendMessage({ type: "startHelp" });
    shadow.appendChild(btn);
    document.documentElement.appendChild(chipHost);
  }
})();
