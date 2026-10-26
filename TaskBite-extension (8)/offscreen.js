// Runs Chrome's free built-in AI (Gemini Nano) for the help chat. It lives in an offscreen document
// because that model needs a normal window: it isn't available in the background service worker.
// Nothing here leaves the computer. The one-time model download is started from the setup page (it needs a click).
const TEXT_IN = [{ type: "text", languages: ["en"] }];
const optsFor = (withImage) => ({
  expectedInputs: withImage ? [...TEXT_IN, { type: "image" }] : TEXT_IN,
  expectedOutputs: [{ type: "text", languages: ["en"] }],
});

async function availability(withImage) {
  if (!globalThis.LanguageModel?.availability) return "unsupported";
  try { return await LanguageModel.availability(optsFor(withImage)); } catch { return "unavailable"; }
}

async function dataUrlToBlob(u) {
  return (await fetch(u)).blob();
}

// turns = [{role:"user"|"assistant", text}], first turn is from the student's side. image is attached to the first turn.
async function ask({ system, turns, dataUrl }, onDelta, signal) {
  const textStatus = await availability(false);
  if (textStatus !== "available") return { needsSetup: true, reason: textStatus };

  // A picture is a bonus: the selected text is already in the prompt, so fall back to text-only if images aren't supported here.
  const useImage = !!dataUrl && (await availability(true)) === "available";
  const blob = useImage ? await dataUrlToBlob(dataUrl) : null;
  const toMsg = (t, i) => ({
    role: t.role === "assistant" ? "assistant" : "user",
    content: i === 0 && blob ? [{ type: "text", value: t.text }, { type: "image", value: blob }] : t.text,
  });
  const msgs = turns.map(toMsg);
  const last = msgs.pop();

  const session = await LanguageModel.create({
    ...optsFor(useImage),
    initialPrompts: [{ role: "system", content: system }, ...msgs],
    signal,
  });
  try {
    const stream = session.promptStreaming([last], { signal });
    let full = "";
    for await (const chunk of stream) {
      // Newer Chrome sends only the new words; older versions resend everything so far.
      const delta = full && chunk.startsWith(full) ? chunk.slice(full.length) : chunk;
      full = full && chunk.startsWith(full) ? chunk : full + chunk;
      if (delta) onDelta(delta);
    }
    full = full.trim();
    if (!full) return { error: "The on-device AI sent back an empty answer. Try again." };
    return { text: full, via: "device", image: useImage };
  } finally {
    session.destroy?.();
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ondevice") return;
  const ac = new AbortController();
  let gone = false;
  port.onDisconnect.addListener(() => { gone = true; ac.abort(); });
  const send = (m) => { if (!gone) { try { port.postMessage(m); } catch { gone = true; } } };
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== "ask") return;
    const timer = setTimeout(() => ac.abort(), 90000);
    let res;
    try {
      res = await ask(msg, (d) => send({ delta: d }), ac.signal);
    } catch (e) {
      res = { error: e?.name === "AbortError" ? "The on-device AI took too long. Try again." : `The on-device AI had a problem: ${e?.message || "unknown error"}` };
    } finally {
      clearTimeout(timer);
    }
    send({ done: true, res });
  });
});
