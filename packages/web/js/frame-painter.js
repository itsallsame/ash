/**
 * Repaints at most once per animation frame, with the latest state.
 *
 * The conversation used to be rebuilt in full for every ledger message. A long task writes hundreds of them, and a page
 * that was in the background (or catching up) replayed every one of those rebuilds at once when it came back: seconds of
 * blank screen. A hidden page gets no animation frames, so nothing is painted until it is shown again, and then once.
 *
 * `change(value, conversation)` says whether this change touches the conversation area; the next paint is told whether
 * any change since the previous paint did. The optional third argument is a set of changed entity IDs;
 * null requests a complete range check (initial history, reset, or local presentation changes).
 */
export function framePainter(paint, schedule = (frame) => requestAnimationFrame(frame)) {
  let queued = false;
  let latest;
  let conversationDirty = false;
  let dirtyIds = new Set();
  return (value, conversation = true, ids = null) => {
    latest = value;
    if (conversation) {
      conversationDirty = true;
      if (ids === null) dirtyIds = null;
      else if (dirtyIds) for (const id of ids) dirtyIds.add(id);
    }
    if (queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      const redraw = conversationDirty;
      const changed = dirtyIds;
      conversationDirty = false;
      dirtyIds = new Set();
      paint(latest, redraw, changed);
    });
  };
}
