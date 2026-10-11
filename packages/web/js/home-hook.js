// Evaluated before the page's own code: when the page's connection (Net) is started, the home pages are told about it and
// begin reading the same rows. Nothing else of the page's code is touched.
import { Net } from "./net.js";
import { feed, link } from "./home-feed.js";

const start = Net.prototype.start;
Net.prototype.start = function startWithHome() {
  if (!this.homeTee) {
    this.homeTee = true;
    for (const name of ["onMessage", "onHistory", "onState", "onOpen"]) {
      const original = this[name];
      this[name] = (...args) => {
        try {
          if (name === "onMessage") feed.add(args[0]);
          else if (name === "onHistory") feed.addMany(args[0]);
          else globalThis.dispatchEvent?.(new CustomEvent("ash:net-state", { detail: { net: this, event: name } }));
        } catch { /* the home pages never stop the page's own reading */ }
        return original.apply(this, args);
      };
    }
    link.net = this;
    globalThis.dispatchEvent?.(new CustomEvent("ash:net", { detail: { net: this } }));
  }
  return start.call(this);
};
