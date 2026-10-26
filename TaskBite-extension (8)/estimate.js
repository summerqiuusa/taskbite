// Time-estimation + step-breakdown.
// Base minutes by type, scaled by points & description, plus a 25% buffer.
// Then stretch/shrink using how long this student actually takes (per type + overall).
const TYPES = [
  { type: "Quiz / Test", re: /quiz|test|exam|assessment|midterm|final/i, base: 20, steps: [
    { text: "Review your notes", w: 0.3, cap: 15 }, { text: "Take the quiz", w: 0.6 }, { text: "Submit", w: 0.1, cap: 2 }] },
  { type: "Essay / Writing", re: /essay|paper|report|writ|reflection|journal|response/i, base: 60, steps: [
    { text: "Read the prompt & plan", w: 0.15, cap: 12 }, { text: "Write your draft", w: 0.7 }, { text: "Check it & submit", w: 0.15, cap: 12 }] },
  { type: "Project", re: /project|presentation|poster|slides|lab|model/i, base: 90, steps: [
    { text: "List what you need", w: 0.1, cap: 10 }, { text: "Build it", w: 0.8 }, { text: "Check the rubric & submit", w: 0.1, cap: 10 }] },
  { type: "Discussion", re: /discussion|forum|post|reply|comment/i, base: 15, steps: [
    { text: "Read the question", w: 0.15, cap: 3 }, { text: "Write your post", w: 0.65 }, { text: "Reply & submit", w: 0.2, cap: 8 }] },
  { type: "Reading", re: /read|article|pages|textbook/i, base: 25, steps: [
    { text: "Skim the headings", w: 0.1, cap: 4 }, { text: "Read in chunks", w: 0.75 }, { text: "Note 3 key points", w: 0.15, cap: 6 }] },
  { type: "Homework", re: /./, base: 30, steps: [
    { text: "Read the directions", w: 0.05, cap: 3 }, { text: "Do the work", w: 0.85 }, { text: "Check it & submit", w: 0.1, cap: 6 }] },
];

function round5(n) {
  return Math.max(5, Math.round(n / 5) * 5);
}

function paceRatio(pace, type) {
  if (!pace) return 1;
  const typed = pace.types?.[type];
  const local = typed?.samples >= 1 ? typed.ratio : null;
  const global = pace.samples >= 1 ? pace.ratio : 1;
  const ratio = local != null ? local * 0.7 + global * 0.3 : global;
  return Math.min(2.4, Math.max(0.55, ratio));
}

function estimateTask(t, pace) {
  const text = `${t.name} ${t.desc || ""}`;
  const kind = TYPES.find((k) => k.re.test(t.name)) || TYPES.find((k) => k.re.test(text));
  let min = kind.base;
  const pts = Number(t.points) || 0;
  if (pts >= 100) min *= 1.8; else if (pts >= 50) min *= 1.4; else if (pts > 0 && pts <= 10) min *= 0.7;
  const words = (t.desc || "").split(" ").length;
  if (words > 300) min += 10;
  const ratio = paceRatio(pace, kind.type); // 1 until the student has finished something; then their own speed
  min = Math.max(5, round5(min * 1.15 * ratio));
  // Split by weight, but quick steps (reading directions, submitting) are capped; the extra goes to the main step.
  const raw = kind.steps.map((s) => Math.min(s.cap ?? Infinity, min * s.w));
  const spare = min - raw.reduce((a, b) => a + b, 0);
  const main = kind.steps.reduce((bi, s, i, arr) => (s.w > arr[bi].w ? i : bi), 0);
  raw[main] += spare;
  const mins = raw.map((m) => Math.max(1, Math.round(m)));
  const total = mins.reduce((a, b) => a + b, 0);
  return { type: kind.type, minutes: total, ratio, personal: !!(pace && pace.samples >= 1), blocks: Math.ceil(total / 25), steps: kind.steps.map((s, i) => ({ text: s.text, min: mins[i], done: false })) };
}

// estimatedMin must be the estimate WITHOUT the student's pace applied (paced estimate / the ratio used),
// otherwise the ratio would be measured against an already-adjusted number and drift back toward 1.
function recordPace(pace, type, estimatedMin, actualMin) {
  const next = {
    samples: 0,
    ratio: 1,
    types: {},
    ...(pace || {}),
  };
  next.types = { ...(next.types || {}) };
  const est = Math.max(5, Number(estimatedMin) || 0);
  const act = Math.max(3, Number(actualMin) || 0);
  if (act < 3 || act > 8 * 60) return next;
  const observed = Math.min(2.6, Math.max(0.45, act / est));
  const blend = (oldRatio, samples) => {
    const n = Math.min(8, (samples || 0) + 1);
    const prev = samples ? oldRatio : observed;
    return { ratio: prev * (1 - 1 / n) + observed * (1 / n), samples: (samples || 0) + 1 };
  };
  const g = blend(next.ratio, next.samples);
  next.ratio = g.ratio;
  next.samples = g.samples;
  const prevType = next.types[type] || { ratio: observed, samples: 0 };
  next.types[type] = blend(prevType.ratio, prevType.samples);
  return next;
}
