document.getElementById("back").onclick = async () => {
  let r = null;
  try { r = await chrome.runtime.sendMessage({ type: "lockBounce" }); } catch { /* ignore */ }
  if (!r || r.sameTab || r.ended) history.back();
};
document.getElementById("exit").onclick = async () => {
  if (!confirm("Leave focus mode?")) return;
  try { await chrome.runtime.sendMessage({ type: "lockEnd" }); } catch { /* ignore */ }
  history.back();
};
