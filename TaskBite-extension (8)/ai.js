// Provider-agnostic vision chat. Loaded by the background worker (importScripts) and the setup page (<script>).
// The API key never leaves this file's callers: only background.js and options.js use it.

const AI_PROVIDERS = {
  anthropic: {
    name: "Anthropic (Claude)",
    model: "claude-sonnet-5-5",
    keyHint: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    name: "OpenAI (ChatGPT)",
    model: "gpt-4.1-mini",
    keyHint: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  gemini: {
    name: "Google Gemini",
    model: "gemini-2.5-flash",
    keyHint: "AIza…",
    keyUrl: "https://aistudio.google.com/apikey",
  },
};

// "Reasoning" models think for several seconds before the first word; we avoid them or turn the effort down.
const aiIsReasoning = (id) => /^(gpt-5|o\d)/.test(id || "");

// The model name a request will actually use (typed override > auto-picked > built-in default).
function aiModelName(cfg) {
  return (cfg?.model || "").trim() || cfg?.resolvedModel || AI_PROVIDERS[cfg?.provider]?.model || "";
}

// APIs want strictly alternating turns; merge neighbours that share a role.
function aiMergeTurns(turns) {
  const out = [];
  for (const t of turns || []) {
    if (!t?.text) continue;
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.text += "\n\n" + t.text;
    else out.push({ role: t.role, text: t.text });
  }
  return out;
}

function aiParseDataUrl(u) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(u || "");
  return m ? { mime: m[1], data: m[2] } : null;
}

// Turn a thrown error into something a student can act on.
function aiFriendlyError(e) {
  const s = e?.status;
  if (s === 401 || s === 403) return { error: "Your API key was rejected. Open AI settings and paste it again.", settings: true };
  if (s === 404) return { error: "That model name wasn't found. Check the model in AI settings (or clear it to use the default).", settings: true };
  if (s === 429) return { error: "Your AI account hit its rate limit or is out of credit. Wait a minute, or check billing with your provider.", settings: false };
  if (e?.code === "network") return { error: e.message, settings: false };
  return { error: e?.message ? `The AI had a problem: ${e.message}` : "The AI had a problem. Try again.", settings: false };
}

// ---- Model discovery: ask the provider which models this key can use ----------
async function aiListModels(cfg) {
  let url, headers;
  if (cfg.provider === "anthropic") {
    url = "https://api.anthropic.com/v1/models?limit=100";
    headers = { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
  } else if (cfg.provider === "openai") {
    url = "https://api.openai.com/v1/models";
    headers = { authorization: `Bearer ${cfg.key}` };
  } else {
    url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200";
    headers = { "x-goog-api-key": cfg.key };
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw Object.assign(new Error("Couldn't list models"), { status: res.status });
  const data = await res.json();
  if (cfg.provider === "gemini") {
    return (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => String(m.name).replace(/^models\//, ""));
  }
  return (data.data || []).map((m) => m.id);
}

// Choose a fast, cheap, vision-capable default from a provider's model list.
function aiPickModel(provider, ids) {
  const ver = (id) => parseFloat((/(\d+(?:\.\d+)?)/.exec(id) || [])[1]) || 0;
  const best = (list) => list.slice().sort((a, b) => ver(b) - ver(a))[0];
  if (provider === "anthropic") {
    // The API lists newest first.
    return ids.find((i) => /sonnet/.test(i)) || ids.find((i) => /haiku/.test(i)) || ids[0];
  }
  if (provider === "openai") {
    // Prefer non-reasoning models: they start answering immediately.
    const fast = ids.find((i) => i === "gpt-4.1-mini") || ids.find((i) => i === "gpt-4o-mini") || ids.find((i) => i === "gpt-4.1") || ids.find((i) => i === "gpt-4o");
    if (fast) return fast;
    const plain = ids.filter((i) => /^gpt-\d+(\.\d+)?(-mini)?$/.test(i));
    const minis = plain.filter((i) => /-mini$/.test(i));
    return best(minis) || best(plain) || ids.find((i) => /^gpt-/.test(i)) || ids[0];
  }
  const flash = ids.filter((i) => /^gemini-\d+(\.\d+)?-flash$/.test(i));
  return best(flash) || best(ids.filter((i) => /flash/.test(i) && !/lite|image|tts|live|preview|exp/.test(i))) || ids[0];
}

// If the built-in default model isn't available for this account, find a working one and retry.
// cfg.model (typed by the user) is always respected; the auto-picked name goes in cfg.resolvedModel.
// If a provider rejects the speed settings we send for reasoning models, retry once without them.
async function callAI(cfg, opts = {}) {
  try {
    return await aiCall(cfg, opts);
  } catch (e) {
    if (e?.status === 404 && !(cfg.model || "").trim()) {
      let pick = null;
      try { pick = aiPickModel(cfg.provider, await aiListModels(cfg)); } catch { /* keep the original error */ }
      const failed = cfg.resolvedModel || AI_PROVIDERS[cfg.provider].model;
      if (pick && pick !== failed) {
        cfg.resolvedModel = pick;
        return callAI(cfg, opts);
      }
    }
    if (e?.status === 400 && !opts.plain && /reasoning|thinking/i.test(e.message || "")) {
      return callAI(cfg, { ...opts, plain: true });
    }
    throw e;
  }
}

// Read a server-sent-events body, calling onDelta(textChunk) as words arrive. Returns the full text.
async function aiReadStream(res, pickDelta, onDelta, meta, t0) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let d;
      try { d = JSON.parse(payload); } catch { continue; }
      if (d.type === "error" || d.error) throw new Error(d.error?.message || "The AI stopped partway through.");
      const t = pickDelta(d);
      if (t) {
        if (!full && meta) meta.ttfb = Date.now() - t0;
        full += t;
        onDelta(t);
      }
    }
  }
  return full;
}

// cfg = { provider, key, model?, resolvedModel? }
// opts = { system, turns:[{role:"user"|"assistant", text}], image (data: URL, attached to first user turn),
//          maxTokens, onDelta(chunk) -> stream the reply, meta -> filled with { model, ms, ttfb }, plain }
async function aiCall(cfg, { system, turns, image, maxTokens = 600, onDelta, meta, plain } = {}) {
  const p = AI_PROVIDERS[cfg?.provider];
  if (!p) throw new Error("No AI provider selected.");
  if (!cfg.key) throw new Error("No API key saved.");
  const model = (cfg.model || "").trim() || cfg.resolvedModel || p.model;
  const t = aiMergeTurns(turns);
  if (!t.length || t[0].role !== "user") throw new Error("The conversation must start with a user turn.");
  const img = image ? aiParseDataUrl(image) : null;
  const stream = typeof onDelta === "function";

  let url, headers, body, pick, pickDelta;

  if (cfg.provider === "anthropic") {
    url = "https://api.anthropic.com/v1/messages";
    headers = {
      "content-type": "application/json",
      "x-api-key": cfg.key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
    body = {
      model,
      max_tokens: maxTokens,
      system,
      messages: t.map((m, i) => ({
        role: m.role,
        content: i === 0 && img
          ? [{ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } }, { type: "text", text: m.text }]
          : m.text,
      })),
    };
    if (stream) body.stream = true;
    pick = (d) => (d?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    pickDelta = (d) => (d.type === "content_block_delta" && d.delta?.type === "text_delta" ? d.delta.text : "");
  } else if (cfg.provider === "openai") {
    const reasoning = aiIsReasoning(model);
    url = "https://api.openai.com/v1/chat/completions";
    headers = { "content-type": "application/json", authorization: `Bearer ${cfg.key}` };
    body = {
      model,
      // Reasoning tokens count against this cap, so leave room or the visible answer comes back empty.
      // Without effort control (plain retry) the model may think at length, so it needs much more headroom.
      max_completion_tokens: reasoning ? Math.max(maxTokens, plain ? 2000 : 1000) : maxTokens,
      messages: [
        { role: "system", content: system },
        ...t.map((m, i) => ({
          role: m.role,
          content: i === 0 && img
            ? [{ type: "text", text: m.text }, { type: "image_url", image_url: { url: image } }]
            : m.text,
        })),
      ],
    };
    if (reasoning && !plain) body.reasoning_effort = "minimal";
    if (stream) body.stream = true;
    pick = (d) => d?.choices?.[0]?.message?.content;
    pickDelta = (d) => d?.choices?.[0]?.delta?.content || "";
  } else {
    const gc = { maxOutputTokens: maxTokens };
    if (!plain) {
      // Turn hidden "thinking" down: it adds seconds of delay before any text appears.
      if (/gemini-2\.5-flash/.test(model)) gc.thinkingConfig = { thinkingBudget: 0 };
      else if (/^gemini-3/.test(model)) gc.thinkingConfig = { thinkingLevel: "low" };
    }
    // Thinking tokens count against the cap: leave room unless thinking is fully off.
    if (!gc.thinkingConfig) gc.maxOutputTokens = maxTokens + 1500;
    else if (gc.thinkingConfig.thinkingLevel) gc.maxOutputTokens = maxTokens + 500;
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    headers = { "content-type": "application/json", "x-goog-api-key": cfg.key };
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: t.map((m, i) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: i === 0 && img
          ? [{ inlineData: { mimeType: img.mime, data: img.data } }, { text: m.text }]
          : [{ text: m.text }],
      })),
      generationConfig: gc,
    };
    pick = (d) => (d?.candidates?.[0]?.content?.parts || []).map((x) => x.text || "").join("");
    pickDelta = (d) => (d?.candidates?.[0]?.content?.parts || []).map((x) => x.text || "").join("");
  }

  const t0 = Date.now();
  if (meta) meta.model = model;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000);
  const netErr = (e) => Object.assign(
    new Error(e?.name === "AbortError" ? "The AI took too long to answer. Try again." : "Couldn't reach the AI. Check your internet connection."),
    { code: "network" }
  );
  try {
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });
    } catch (e) { throw netErr(e); }

    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch { /* non-JSON error body */ }
      const msg = data?.error?.message || (typeof data?.error === "string" ? data.error : "") || res.statusText || "Request failed";
      throw Object.assign(new Error(String(msg).slice(0, 300)), { status: res.status });
    }

    let text;
    if (stream) {
      try { text = await aiReadStream(res, pickDelta, onDelta, meta, t0); }
      catch (e) { throw e?.name === "AbortError" ? netErr(e) : e; }
    } else {
      let data = null;
      try { data = await res.json(); } catch { /* ignore */ }
      text = pick(data);
    }
    text = String(text || "").trim();
    if (!text) throw Object.assign(new Error("The AI sent back an empty answer."), { code: "empty" });
    if (meta) meta.ms = Date.now() - t0;
    return text;
  } finally {
    clearTimeout(timer);
  }
}
