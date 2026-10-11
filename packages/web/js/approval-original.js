/** The gate's unabridged request snapshot, never HTML or a model-generated paraphrase. */
export function appendApprovalOriginal(parent, ask, label = "查看原文") {
  if (ask?.from !== "service:gate" || typeof ask.original !== "string") return;
  const details = document.createElement("details");
  details.className = "approval-original";
  const summary = document.createElement("summary");
  summary.textContent = label;
  const original = document.createElement("pre");
  original.className = "approval-original-text";
  original.textContent = ask.original;
  details.append(summary);
  details.append(original);
  parent.append(details);
}
