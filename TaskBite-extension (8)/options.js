const $ = (id) => document.getElementById(id);
const sel = $("provider"), key = $("key"), model = $("model");

for (const [id, p] of Object.entries(AI_PROVIDERS)) {
  const o = document.createElement("option");
  o.value = id;
  o.textContent = p.name;
  sel.appendChild(o);
}

function say(text, kind) {
  const m = $("msg");
  m.textContent = text;
  m.className = kind || "";
}

function paintProvider() {
  const p = AI_PROVIDERS[sel.value];
  key.placeholder = p.keyHint;
  model.placeholder = p.model;
  $("getKey").href = p.keyUrl;
  $("getKey").textContent = `Get a ${p.name} key`;
}
sel.onchange = () => { paintProvider(); $("saveAnyway").hidden = true; say(""); };
$("showKey").onchange = (e) => { key.type = e.target.checked ? "text" : "password"; };

async function load() {
  const { ai } = await chrome.storage.local.get("ai");
  if (ai?.provider && AI_PROVIDERS[ai.provider]) {
    sel.value = ai.provider;
    key.value = ai.key || "";
    model.value = ai.model || "";
    $("remove").hidden = false;
    say("A key is already saved. Change it and press Save & test to replace it.");
  }
  paintProvider();
}

const readCfg = () => ({ provider: sel.value, key: key.value.trim(), model: model.value.trim() });

async function persist(cfg) {
  await chrome.storage.local.set({ ai: cfg, setupDone: true });
  $("remove").hidden = false;
  $("saveAnyway").hidden = true;
}

$("save").onclick = async () => {
  const cfg = readCfg();
  if (!cfg.key) return say("Paste your API key first.", "bad");
  $("save").disabled = true;
  $("saveAnyway").hidden = true;
  say("Testing your key…");
  let r;
  try { r = await chrome.runtime.sendMessage({ type: "aiTest", cfg }); } catch { r = null; }
  $("save").disabled = false;
  if (r?.ok) {
    if (r.resolvedModel) cfg.resolvedModel = r.resolvedModel; // default model was retired; use the one the provider offered
    await persist(cfg);
    say(`Connected. Model: ${r.model}. Test request took ${(r.ms / 1000).toFixed(1)}s.${r.ms > 6000 ? " That is slow for a tiny request, so consider a faster model under Advanced." : ""}`, "good");
  } else {
    say(r?.error || "That didn't work. Check the key and try again.", "bad");
    // A busy or out-of-credit account can still be a valid key, so let them keep it.
    if (r && r.status !== 401 && r.status !== 403) $("saveAnyway").hidden = false;
  }
};

$("saveAnyway").onclick = async () => {
  const cfg = readCfg();
  if (!cfg.key) return;
  await persist(cfg);
  say("Saved without a successful test. If help doesn't work, check the key here.", "good");
};

$("skip").onclick = async () => {
  await chrome.storage.local.set({ setupDone: true });
  say("Skipped. The help button stays off until you set up Option A or add a key (⚙ in the popup).", "good");
};

$("remove").onclick = async () => {
  await chrome.storage.local.remove("ai");
  key.value = "";
  model.value = "";
  $("remove").hidden = true;
  $("saveAnyway").hidden = true;
  say("Key removed from this browser.", "good");
};

load();

// ---- Focus mode allowed sites ----
const DEFAULT_ALLOW = ["accounts.google.com", "docs.google.com", "drive.google.com", "classroom.google.com", "sites.google.com", "forms.gle", "login.microsoftonline.com"];
chrome.storage.local.get("allowSites").then(({ allowSites }) => { $("allow").value = (allowSites || DEFAULT_ALLOW).join("\n"); });
$("saveAllow").onclick = async () => {
  const list = [...new Set($("allow").value.split(/\s+/).map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean))];
  await chrome.storage.local.set({ allowSites: list });
  $("allow").value = list.join("\n");
  $("allowMsg").textContent = "Saved. Applies the next time you lock in.";
};

// ---- Option A: Chrome's built-in on-device AI ----
// Must match offscreen.js so "available" here means the help chat can use it.
const OD_OPTS = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };
async function odStatus() {
  if (!globalThis.LanguageModel?.availability) return "unsupported";
  try { return await LanguageModel.availability(OD_OPTS); } catch { return "unavailable"; }
}
async function paintOd() {
  const st = await odStatus();
  const msg = {
    available: "Ready. The help button will use the free on-device AI when you have no key saved.",
    downloadable: "Not downloaded yet. Press the button to start the one-time download.",
    downloading: "Downloading in the background. Check again in a few minutes.",
    unavailable: "This computer can't run Chrome's built-in AI. Use Option B (an AI key) instead.",
    unsupported: "This version of Chrome has no built-in AI. Update Chrome, or use Option B.",
  }[st] || "Status unknown.";
  $("odStatus").textContent = msg;
  $("odStatus").style.color = st === "available" ? "var(--accent)" : st === "unavailable" || st === "unsupported" ? "var(--bad)" : "";
  $("odGo").hidden = st !== "downloadable";
  return st;
}
$("odCheck").onclick = paintOd;
$("odGo").onclick = async () => {
  $("odGo").disabled = true;
  $("odBar").hidden = false;
  $("odStatus").textContent = "Starting the download…";
  try {
    const session = await LanguageModel.create({
      ...OD_OPTS,
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          const pct = Math.round((e.loaded / (e.total || 1)) * 100);
          $("odFill").style.width = `${pct}%`;
          $("odStatus").textContent = `Downloading… ${pct}%`;
        });
      },
    });
    session.destroy?.();
  } catch (e) {
    $("odStatus").textContent = `Couldn't finish: ${e?.message || "unknown error"}. Check your internet connection and free disk space, then try again.`;
  }
  $("odGo").disabled = false;
  $("odBar").hidden = true;
  if ((await paintOd()) === "available") await chrome.storage.local.set({ setupDone: true });
};
paintOd();
