// On-page crop + chat coach. Shadow DOM so Canvas/Classroom CSS cannot wreck it.
(() => {
  if (window.__taskbiteHelp) return; // already loaded; its message listener is still registered

  const state = {
    task: null, level: 0, shot: null, pageText: "",
    msgs: [],        // {role, text, local?, error?, settings?, setup?, linkLabel?}
    busy: false, via: "", live: "",
    dragging: false, start: null, rect: null, ac: null,
    panel: null,
  };

  const host = document.createElement("div");
  host.id = "taskbite-help-host";
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.zIndex = "2147483646";
  host.style.pointerEvents = "none";
  const shadow = host.attachShadow({ mode: "open" });
  const root = document.createElement("div");
  root.className = "fl-root";
  shadow.appendChild(root);

  fetch(chrome.runtime.getURL("help-overlay.css")).then((r) => r.text()).then((css) => {
    const s = document.createElement("style");
    s.textContent = css;
    shadow.appendChild(s);
  }).catch(() => {});

  function setChip(on) {
    const chip = window.__taskbiteChip;
    if (chip) chip.style.display = on ? "" : "none";
  }
  function mount() {
    if (!host.isConnected) document.documentElement.appendChild(host);
    setChip(false);
  }
  function abortDrag() {
    state.ac?.abort();
    state.ac = null;
    state.dragging = false;
  }
  function clear() {
    abortDrag();
    root.innerHTML = "";
    state.rect = null;
    state.panel = null;
    host.style.pointerEvents = "none";
  }
  function close() {
    clear();
    host.remove();
    setChip(true);
  }

  // The words under the selection, read straight from the page. This is what lets a text-only on-device model help,
  // and it makes the answer more exact for an API model too. (Pictures and text inside embedded frames aren't readable this way.)
  function textInRect(r) {
    const right = r.x + r.w, bottom = r.y + r.h;
    const inside = (b) => {
      const ix = Math.min(b.right, right) - Math.max(b.left, r.x);
      const iy = Math.min(b.bottom, bottom) - Math.max(b.top, r.y);
      return b.width > 0 && b.height > 0 && ix > 0 && iy > 0 && ix * iy >= 0.4 * b.width * b.height;
    };
    const parts = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue.trim() && !n.parentElement?.closest("script,style,noscript,template") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const range = document.createRange();
    let total = 0;
    for (let n; (n = walker.nextNode()) && total < 6000;) {
      range.selectNodeContents(n);
      if ([...range.getClientRects()].some(inside)) {
        const t = n.nodeValue.replace(/\s+/g, " ").trim();
        parts.push(t);
        total += t.length;
      }
    }
    document.querySelectorAll("img[alt]").forEach((im) => {
      if (im.alt.trim() && inside(im.getBoundingClientRect())) parts.push(`[image: ${im.alt.trim()}]`);
    });
    document.querySelectorAll("textarea, input[type=text], input:not([type])").forEach((f) => {
      if (f.value.trim() && inside(f.getBoundingClientRect())) parts.push(`[student's answer so far: ${f.value.trim().slice(0, 600)}]`);
    });
    return parts.filter((t, i) => t !== parts[i - 1]).join("\n").slice(0, 1800);
  }

  // ---- 1. Crop ---------------------------------------------------------------
  function startCrop(task) {
    state.task = task || state.task;
    state.level = 0;
    state.shot = null;
    state.msgs = [];
    state.busy = false;
    state.via = "";
    state.pageText = "";
    mount();
    clear();
    host.style.pointerEvents = "auto";
    const dim = document.createElement("div");
    dim.className = "fl-dim";
    dim.style.pointerEvents = "auto";
    const banner = document.createElement("div");
    banner.className = "fl-banner";
    banner.textContent = "Drag a box around the part you need help with.";
    const cancel = document.createElement("button");
    cancel.className = "fl-cancel";
    cancel.textContent = "Cancel";
    cancel.onclick = (e) => { e.stopPropagation(); close(); };
    const sel = document.createElement("div");
    sel.className = "fl-sel";
    sel.hidden = true;
    root.append(dim, banner, cancel, sel);

    state.ac = new AbortController();
    const sig = { signal: state.ac.signal };
    const pos = (e) => ({ x: e.clientX, y: e.clientY });
    dim.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      state.dragging = true;
      state.start = pos(e);
      sel.hidden = false;
    }, sig);
    window.addEventListener("mousemove", (e) => {
      if (!state.dragging) return;
      const p = pos(e);
      const x = Math.min(state.start.x, p.x);
      const y = Math.min(state.start.y, p.y);
      const w = Math.abs(p.x - state.start.x);
      const h = Math.abs(p.y - state.start.y);
      state.rect = { x, y, w, h, dpr: window.devicePixelRatio || 1 };
      Object.assign(sel.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    }, sig);
    window.addEventListener("mouseup", async () => {
      if (!state.dragging) return;
      state.dragging = false;
      const r = state.rect;
      if (!r || r.w < 24 || r.h < 24) {
        banner.textContent = "Make the box a little bigger.";
        return;
      }
      banner.textContent = "Capturing…";
      state.pageText = textInRect(r);
      host.style.visibility = "hidden";
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      try {
        const res = await chrome.runtime.sendMessage({ type: "cropCapture", rect: r });
        host.style.visibility = "";
        if (!res?.dataUrl) throw new Error(res?.error || "capture failed");
        state.shot = res.dataUrl;
        openCoach();
      } catch {
        host.style.visibility = "";
        banner.textContent = "Couldn't capture this page. Open the assignment tab and try again.";
      }
    }, sig);
  }

  // ---- 2. Chat panel ---------------------------------------------------------
  const mk = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function openCoach() {
    abortDrag();
    root.innerHTML = "";
    host.style.pointerEvents = "none";

    const panel = mk("div", "fl-panel");
    panel.style.pointerEvents = "auto";
    // Keep typing inside the panel from triggering the school site's keyboard shortcuts.
    ["keydown", "keyup", "keypress"].forEach((t) => panel.addEventListener(t, (e) => e.stopPropagation()));

    const head = mk("div", "fl-head");
    head.append(mk("h2", "", "Help with this problem"));
    const x = mk("button", "fl-x", "✕");
    x.title = "Close";
    x.onclick = close;
    head.append(x);

    const soft = mk("p", "fl-soft", "I'll explain the problem and check your work, but I won't give you answers to submit.");
    soft.id = "soft";
    panel.append(head, soft);

    if (state.shot) {
      const img = mk("img", "fl-shot");
      img.alt = "The part you selected";
      img.src = state.shot;
      panel.append(img);
    }

    const log = mk("div", "fl-log");
    log.setAttribute("aria-live", "polite");

    const ask = mk("div", "fl-ask");
    const input = mk("textarea", "fl-input");
    input.rows = 2;
    input.placeholder = "Describe what you tried or what's unclear";
    const send = mk("button", "fl-btn primary fl-send", "Send");
    const submit = () => {
      const text = input.value.trim();
      if (!text || state.busy) return;
      input.value = "";
      ask_(text);
    };
    send.onclick = submit;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    ask.append(input, send);

    const actions = mk("div", "fl-actions");
    const add = (label, cls, fn) => {
      const b = mk("button", `fl-btn ${cls}`, label);
      b.onclick = fn;
      actions.append(b);
      return b;
    };
    add("Next hint", "primary", () => nudge(state.level + 1, "I tried that. Give me the next hint."));
    add("Still stuck", "ghost", () => nudge(Math.max(state.level + 1, 2), "I'm still stuck. Be more specific about my problem."));
    const really = add("Show an example", "ghost", () => nudge(3, "Show me a similar worked example."));
    add("Select a different part", "ghost", () => startCrop(state.task));

    panel.append(log, ask, actions);
    root.append(panel);
    state.panel = { panel, log, input, send, actions, really, soft };
    paint();
    ask_();
  }

  function nudge(level, text) {
    if (state.busy) return;
    state.level = Math.min(3, level);
    ask_(text);
  }

  // Streams the reply over a port so words appear as they are written.
  // Resolves with the final result, or null if the extension can't be reached (then the scripted hint is used).
  function requestCoach(payload, onDelta) {
    return new Promise((resolve) => {
      let port, settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        try { port?.disconnect(); } catch { /* already closed */ }
        resolve(r);
      };
      try { port = chrome.runtime.connect({ name: "coach" }); } catch { return finish(null); }
      port.onMessage.addListener((m) => {
        if (m?.delta) onDelta(m.delta);
        else if (m?.done) finish(m.res || null);
      });
      port.onDisconnect.addListener(() => finish(null));
      port.postMessage({ type: "coachAsk", ...payload });
    });
  }

  const tidy = (t) => String(t || "").replace(/\*\*/g, "").replace(/^#{1,6}\s*/gm, "").replace(/`/g, "");

  const SETUP = {
    downloadable: { text: "Free on-device AI needs a one-time download (a few GB) before it can help. Open setup and press the download button.", link: "Set up free on-device AI" },
    downloading: { text: "The on-device AI is still downloading. Try again in a few minutes.", link: "Check setup" },
    unavailable: { text: "This computer can't run Chrome's built-in AI (it needs a recent Chrome, about 22 GB free space, and a strong graphics card or 16 GB of memory). To get help here, add an AI key.", link: "Add an AI key" },
    unsupported: { text: "This version of Chrome has no built-in AI. Update Chrome, or add an AI key to get help.", link: "Open AI setup" },
  };

  // Send the conversation so far and show the reply (your API key, or Chrome's on-device AI). No canned tips.
  async function ask_(userText) {
    if (state.busy) return;
    if (userText) state.msgs.push({ role: "user", text: userText });

    state.busy = true;
    state.live = "";
    paint();
    const res = await requestCoach({
      task: state.task,
      level: state.level,
      dataUrl: state.shot,
      pageText: state.pageText,
      chat: state.msgs
        .filter((m) => !m.local && !m.error && !m.setup)
        .map((m) => ({ role: m.role, text: m.text })),
    }, (chunk) => { state.live += chunk; paint(); });
    state.busy = false;
    state.live = "";

    if (res?.text) {
      const sec = (n) => (n / 1000).toFixed(1);
      const meta = res.ms
        ? `${sec(res.ms)}s · ${res.model}${res.ttfb != null ? ` · first words ${sec(res.ttfb)}s` : ""}${res.image ? " · photo sent" : ""}`
        : res.via === "device" ? "On-device AI" : "";
      state.msgs.push({ role: "assistant", text: res.text, meta });
      state.via = res.via || "";
    } else if (res?.needsSetup) {
      const info = SETUP[res.reason] || SETUP.unsupported;
      state.msgs.push({ role: "assistant", local: true, setup: true, text: info.text, linkLabel: info.link });
    } else {
      state.msgs.push({ role: "assistant", error: true, text: res?.error || "I couldn't reach the AI. Try again.", settings: !!res?.settings });
    }
    paint();
  }

  function paint() {
    const p = state.panel;
    if (!p) return;
    p.log.innerHTML = "";
    for (const m of state.msgs) {
      const b = mk("div", `fl-bubble ${m.role === "user" ? "me" : m.error ? "err" : "coach"}`, m.text);
      if (m.meta) b.append(mk("div", "fl-meta", m.meta));
      if (m.settings || m.setup) {
        const link = mk("button", "fl-link", m.linkLabel || "Open AI settings");
        link.onclick = () => chrome.runtime.sendMessage({ type: "openOptions" }).catch(() => {});
        b.append(document.createElement("br"), link);
      }
      p.log.append(b);
    }
    if (state.busy) {
      const live = tidy(state.live);
      p.log.append(live ? mk("div", "fl-bubble coach", live) : mk("div", "fl-bubble coach fl-wait", "Thinking…"));
    }
    p.log.scrollTop = p.log.scrollHeight;

    p.input.disabled = state.busy;
    p.send.disabled = state.busy;
    p.actions.querySelectorAll("button").forEach((b) => { b.disabled = state.busy; });
    p.really.hidden = state.level < 2;
    if (state.via === "api") p.soft.textContent = "I'll explain the problem and check your work, but I won't give you answers to submit. The part you selected was sent to your AI provider.";
    else if (state.via === "device") p.soft.textContent = "I'll explain the problem and check your work, but I won't give you answers to submit. This runs on your computer; nothing is sent anywhere.";
  }

  function onMsg(msg, _s, reply) {
    if (msg.type === "startHelp") {
      startCrop(msg.task || null);
      reply?.({ ok: true });
      return true;
    }
  }

  chrome.runtime.onMessage.addListener(onMsg);
  window.__taskbiteHelp = { onMsg, startCrop };
})();
