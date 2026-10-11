/** One owner of reading position, including delayed image/Markdown height changes. */
export class ScrollPosition {
  constructor(root) {
    this.root = root;
    this.anchor = null;
    this.top = root.scrollTop;
    this.compensations = new WeakSet();
    root.style.overflowAnchor = "none";
    this.onScroll = event => {
      // Our compensation also emits scroll; it must not overwrite the pre-resize anchor.
      if (this.compensatedTop === root.scrollTop || this.top === root.scrollTop) this.compensations.add(event);
      else this.capture(true);
      this.compensatedTop = null;
    };
    root.addEventListener("scroll", this.onScroll, { passive: true, capture: true });
    this.observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.restore()) : null;
    this.observer?.observe(root);
  }
  capture(userScroll = false) {
    const root = this.root;
    if (userScroll) this.pendingJump = null;
    let jump = this.pendingJump;
    if (jump && !jump.isConnected) {
      jump = Array.from(root.children).find(node => node.dataset.rowKey === jump.dataset.rowKey);
      this.pendingJump = jump ?? null;
    }
    // Keep the requested row until the reader scrolls: later slices may shrink and regrow even an aligned preview.
    if (jump?.isConnected) {
      this.anchor = { bottom: false, row: jump, node: jump, offset: 0, block: -1, key: jump.dataset.rowKey, top: root.scrollTop };
      this.top = root.scrollTop;
      return this.anchor;
    }
    this.pendingJump = null;
    const bottom = this.followTail !== false && root.scrollHeight - root.scrollTop - root.clientHeight < 100;
    const y = root.getBoundingClientRect().top;
    // Siblings are ordered vertically. Do not read every historical element's geometry.
    const visible = nodes => {
      let low = 0, high = nodes.length;
      while (low < high) { const mid = (low + high) >>> 1; if (nodes[mid].getBoundingClientRect().bottom <= y + 1) low = mid + 1; else high = mid; }
      return nodes[low] ?? null;
    };
    const row = visible(root.children);
    const markdown = row?.querySelector(".markdown");
    const node = markdown ? visible(markdown.children) ?? row : row;
    this.anchor = { bottom, row, node, offset: node ? node.getBoundingClientRect().top - y : 0,
      block: markdown && node !== row ? Array.prototype.indexOf.call(markdown.children, node) : -1,
      key: row?.dataset.rowKey, top: root.scrollTop };
    this.top = root.scrollTop;
    return this.anchor;
  }
  restore() {
    const anchor = this.anchor, root = this.root;
    if (!anchor) return;
    const clamped = root.scrollTop !== this.top;
    if (anchor.bottom) this.scrollTo(root.scrollHeight);
    else {
      let node = anchor.node;
      if (!node?.isConnected && anchor.key) {
        const row = Array.from(root.children).find(child => child.dataset.rowKey === anchor.key);
        node = anchor.block >= 0 ? row?.querySelector(".markdown")?.children[anchor.block] ?? row : row;
      }
      if (node?.isConnected) this.scrollTo(root.scrollTop + node.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset);
      else this.scrollTo(anchor.top);
    }
    if (clamped) this.compensatedTop = root.scrollTop;
    this.top = root.scrollTop;
  }
  scrollTo(top) {
    const before = this.root.scrollTop;
    this.root.scrollTop = top;
    if (this.root.scrollTop !== before) this.compensatedTop = this.root.scrollTop;
  }
  changed() { this.restore(); this.capture(); }
  observe(nodes) { for (const node of nodes) if (node.nodeType === 1) this.observer?.observe(node); }
  unobserve(nodes) { for (const node of nodes) if (node.nodeType === 1) this.observer?.unobserve(node); }
  latest() { this.pendingJump = null; this.scrollTo(this.root.scrollHeight); this.capture(); }
  jump(node) {
    if (!node?.isConnected) return false;
    this.pendingJump = node;
    this.scrollTo(this.root.scrollTop + node.getBoundingClientRect().top - this.root.getBoundingClientRect().top);
    this.capture(); return true;
  }
  dispose() { this.observer?.disconnect(); this.root.removeEventListener("scroll", this.onScroll, true); this.anchor = null; }
}
