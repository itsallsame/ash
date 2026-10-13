/** The gate's unabridged request snapshot, never HTML or a model-generated paraphrase. */
export function appendApprovalOriginal(parent, ask, label = "查看原文", { onReadOriginal, lifetime } = {}) {
  if (ask?.from !== "service:gate" || typeof ask.original !== "string") return;
  appendPlainText(parent, ask.original, ask.original_full, label, { read: signal => onReadOriginal?.(ask, signal), lifetime });
}

/** A custom answer is a separate complete text, read only when the owner opens it. */
export function appendFullAnswer(parent, ask, { onReadAnswer, lifetime, label = "查看完整回答" } = {}) {
  if (ask?.state !== "answered" || typeof ask.answer_text !== "string" || !ask.answer_full) return;
  return appendPlainText(parent, ask.answer_text, ask.answer_full, label, { read: signal => onReadAnswer?.(ask, signal), lifetime });
}

function appendPlainText(parent, preview, hash, label, { read, lifetime }) {
  const details = document.createElement("details");
  details.className = "approval-original";
  const summary = document.createElement("summary");
  summary.textContent = label;
  const original = document.createElement("pre");
  original.className = "approval-original-text";
  original.textContent = preview;
  if (hash) {
    let loading = false, opened = null, controller;
    const release = () => { controller?.abort(); controller = null; loading = false; opened?.release?.(); opened = null; original.textContent = ""; };
    lifetime?.cleanup.add(release);
    details.addEventListener("toggle", async () => {
      if (!details.open) { release(); return; }
      if (loading || opened) return;
      controller = new AbortController();
      const active = controller;
      loading = true; original.textContent = "正在读取完整文字…";
      try {
        const result = await read(active.signal);
        if (!result || typeof result.text !== "string") throw new Error("完整文字暂时无法读取");
        if (active !== controller || active.signal.aborted || !details.open || lifetime?.disposed || details.isConnected === false) { result.release?.(); return; }
        opened = result; original.textContent = result.text;
      } catch (error) { if (active === controller) original.textContent = error?.message || "完整文字暂时无法读取，请收起后再试。"; }
      finally { if (active === controller) loading = false; }
    });
  }
  details.append(summary);
  details.append(original);
  parent.append(details);
  return details;
}
