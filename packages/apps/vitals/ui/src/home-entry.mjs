import { start } from "./app.mjs";
// 脚本在 <head> 里（见 host.mjs）：页面的骨架还没解析完，等它好了再画。
const go = () => start({ surface: "home", avatar: __AVATAR__ });
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
