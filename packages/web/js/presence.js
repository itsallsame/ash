import { avatarUrl } from "./chat-ui.js";
const FACE = Object.freeze({
  idle: "default", resting: "resting", listening: "listening", thinking: "thinking",
  working: "focused", done: "success", waiting_you: "listening",
});

const DEFAULT_TEXT = Object.freeze({
  idle: "在线", resting: "休息中", listening: "在听", thinking: "正在想",
  working: "在忙", done: "", waiting_you: "等你一句话",
});
/** The ring around the face, the dot on it and the colour of the state line, by state (design: Chat, ChatStates). */
const LOOK = Object.freeze({
  idle: { ring: "", dot: "dot", tone: "" },
  done: { ring: "", dot: "dot", tone: "" },
  resting: { ring: "", dot: "dot off", tone: "" },
  listening: { ring: " av-breath", dot: "dot gone", tone: " c-her" },
  thinking: { ring: " av-breath", dot: "dot gone", tone: " c-her" },
  working: { ring: " av-live", dot: "dot gone", tone: " c-her" },
  waiting_you: { ring: " av-wait", dot: "dot gone", tone: " c-warn" },
});
const BANNER_OFFLINE = "暂时连不上 Ash。你写的消息会先存着，连上就发。";
const BANNER_SEND_ERROR = "消息没发出去，会自动重试。";

export function faceForStatus(state) { return Object.hasOwn(FACE, state) ? FACE[state] : null; }

/**
 * The state and avatar come from the projected ledger (a turn open, a question waiting). Connectivity is separate: the
 * agent's own state line stays in #state, and while the page is connecting or offline a second line (#stateNet) takes its
 * place on screen with the dimmed face (CSS, by `data-net` on the button).
 */
export class PresenceBar {
  constructor(root = document, { onOpen } = {}) {
    this.bar = root.querySelector("#presence");
    this.title = root.querySelector("#title");
    this.state = root.querySelector("#state");
    this.stateNet = root.querySelector("#stateNet");
    this.face = root.querySelector("#face");
    this.avatar = root.querySelector("#face img");
    this.dot = root.querySelector("#dot");
    this.connection = root.querySelector("#connection");
    this.notice = root.querySelector("#presenceNotice");
    this.banner = root.querySelector("#netBanner");
    this.bannerText = root.querySelector("#netBannerText");
    // The home page repeats the same face and state in its header; it is optional in reduced shells.
    this.sheetAvatar = root.querySelector("#agentAvatar");
    this.sheetState = root.querySelector("#agentState");
    this.look = LOOK.idle;
    this.known = false;
    this.net = "connecting";
    this.problemTimer = null;
    this.bar.addEventListener("click", () => {
      if (typeof onOpen === "function") onOpen();
      else this.notice.textContent = "她的主页尚未接入";
    });
  }

  setName(name) {
    this.title.textContent = name;
    this.bar.setAttribute("aria-label", `打开 ${name} 的主页`);
  }

  render(presence) {
    const face = faceForStatus(presence?.state);
    if (!face) {
      this.known = false;
      this.look = LOOK.idle;
      this.bar.dataset.state = "unknown";
      this.state.textContent = "状态待同步";
      this.state.title = "";
      this.avatar.src = avatarUrl("default");
      this.paint();
      this.mirror();
      return;
    }
    const value = typeof presence.text === "string" && presence.text ? presence.text : DEFAULT_TEXT[presence.state];
    this.known = true;
    this.look = LOOK[presence.state];
    this.bar.dataset.state = presence.state;
    this.state.textContent = value;
    this.state.title = value;
    this.avatar.src = avatarUrl(face);
    this.paint();
    this.mirror();
  }

  /** Face, dot and which state line shows: offline dims the face and shows the connection line; so does connecting. */
  paint() {
    const kind = this.net === "offline" ? "offline" : this.net === "connecting" || !this.known ? "connecting" : "online";
    this.bar.dataset.net = kind;
    if (this.stateNet) {
      this.stateNet.dataset.kind = kind;
      this.stateNet.textContent = kind === "offline" ? "离线，正在重连…" : "连接中…";
    }
    if (this.face) this.face.className = `av av-36${kind === "online" ? this.look.ring : ""}`;
    if (this.state) this.state.className = `state${kind === "online" ? this.look.tone : ""}`;
    this.dot.className = kind === "offline" ? "dot off" : kind === "connecting" ? "dot gone" : this.look.dot;
  }

  mirror() {
    if (this.sheetAvatar && this.sheetAvatar.src !== this.avatar.src) this.sheetAvatar.src = this.avatar.src;
    if (this.sheetState) {
      this.sheetState.textContent = this.state.textContent || "在线";
      this.sheetState.dataset.dot = this.look === LOOK.working || this.look === LOOK.thinking || this.look === LOOK.listening || this.look === LOOK.waiting_you ? "running" : this.known && this.look.dot === "dot" ? "idle" : "";
    }
  }

  network(status, detail = "") {
    this.connection.dataset.transport = status;
    this.connection.textContent = detail || (status === "online" ? "已连接" : status === "connecting" ? "连接中…" : status === "send-error" ? "消息未送达，等待重试" : status === "closed" ? "连不上 Ash" : "离线，正在重连…");
    this.net = status === "connecting" ? "connecting" : status === "online" || status === "send-error" ? "online" : "offline";
    this.showBanner(this.net === "offline" ? BANNER_OFFLINE : status === "send-error" ? BANNER_SEND_ERROR : "");
    this.paint();
  }

  /** A short problem to tell the owner (a message that did not go, older records that did not load); it clears itself. */
  problem(text) {
    this.connection.textContent = text;
    this.showBanner(text);
    clearTimeout(this.problemTimer);
    this.problemTimer = setTimeout(() => this.showBanner(this.net === "offline" ? BANNER_OFFLINE : ""), 6000);
  }

  showBanner(text) {
    if (!this.banner || !this.bannerText) return;
    this.bannerText.textContent = text;
    this.banner.hidden = !text;
  }
}
