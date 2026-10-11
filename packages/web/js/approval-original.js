/** The gate's unabridged request snapshot, never HTML or a model-generated paraphrase. */
export function appendApprovalOriginal(parent, ask, label = "查看原文", { onReadOriginal, lifetime } = {}) {
  if (ask?.from !== "service:gate" || typeof ask.original !== "string") return;
  const details = document.createElement("details");
  details.className = "approval-original";
  const summary = document.createElement("summary");
  summary.textContent = label;
  const original = document.createElement("pre");
  original.className = "approval-original-text";
  original.textContent = ask.original;
  if (ask.original_full) {
    let loading = false, opened = null, controller;
    const release = () => { controller?.abort(); opened?.release?.(); opened = null; original.textContent = ""; };
    lifetime?.cleanup.add(release);
    details.addEventListener("toggle", async () => {
      if (!details.open) { release(); return; }
      if (loading || opened) return;
      controller = new AbortController();
      loading = true; original.textContent = "正在读取完整原文…";
      try {
        const result = await onReadOriginal?.(ask, controller.signal);
        if (!result || typeof result.text !== "string") throw new Error("原文暂时无法读取");
        if (!details.open || lifetime?.disposed || details.isConnected === false) { result.release?.(); return; }
        opened = result; original.textContent = result.text;
      } catch (error) { original.textContent = error?.message || "原文暂时无法读取，请收起后再试。"; }
      finally { loading = false; }
    });
  }
  details.append(summary);
  details.append(original);
  parent.append(details);
}
