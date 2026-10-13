---
name: pi-runtime
description: 把帮手换到 pi 运行时（和 DSH 并列的另一个 agent 运行时），连上 Codex（ChatGPT 订阅）、配代理 v2rayA，并看懂连不上时自动切到 DeepSeek 的提示。
whenToUse: 主人想让某个帮手改用 pi 或 Codex 模型、要登录 Codex、问为什么模型被切到 DeepSeek、或要配 v2rayA 代理；用 service:agents/update、service:agents/configure、service:agents/runtimes 之前。
---

# pi 运行时与 Codex

pi 是和 DSH 并列的另一个 agent 运行时。同样的帮手、同样的工具和审批，只是脑子换了。默认用 DeepSeek（密钥和 DSH 用的是同一把），什么都不用配，不走代理。Codex（主人的 ChatGPT 订阅）是可选的：主人登录之后才启用。

## 切到 pi

1. `service:agents/runtimes {}` 看有没有 `pi`。
2. `service:agents/update {agent, runtime: {kind: "pi", model: "openai-codex/gpt-5.5"}}`。`model` 写 `提供方/模型`；只写 `deepseek-flash` 这样的名字就是 DeepSeek 的，没写模型默认 `deepseek/deepseek-flash`。选了 Codex 模型但主人还没登录，这一轮先用 DeepSeek 并告诉他一声。改完这个帮手会自己重启，会话接着用。
3. 换回 DSH：`runtime: {kind: "dsh"}`。
4. 只改模型、不换运行时：`service:agents/configure {agent, config: {model: "deepseek/deepseek-v4-pro"}}`，思考强度是 `effort`。不带 `config` 就是读回现状：现在用哪个模型、期望哪个模型、走的是代理还是直连（`route`）、是不是因为连不上在用 DeepSeek（`fallback`）、Codex 登录了没有（`codex_login`）。

## 登录 Codex（要主人配合，约一分钟）

Codex 要登录 ChatGPT 账号。手机上没有终端，所以用设备码：

1. 先让主人**临时打开手机的全局 VPN**：他手机的浏览器要能打开 OpenAI 的登录页。登录完就能关，平时用不着。VPN 你开不了，只能请他开。
2. `service:agents/configure {agent, config: {login: "openai-codex"}}`。返回 `verification_uri` 和 `user_code`（有效期 `expires_in` 秒）。
3. 用 `human_say` 把链接和码一起发给主人（码单独成一行，方便复制），请他点链接，在页面里输码、登录。
4. 不要轮询。登录好了你会收到一条「Codex 登录成功」；码过期或失败也会有一条话。想主动看就 `configure` 不带 `config`，`codex_login` 是 `ready` 就好了。
5. 返回说连不上 OpenAI（`unavailable`）：多半是 VPN 没开，也可能 v2rayA 没配好（下一节）。

## 平时怎么出去：v2rayA

日常不开全局 VPN。容器里有 v2rayA（代理），Codex 的请求走它；DeepSeek 一直直连，不走代理。主人自己配一次：

- 在手机浏览器打开 `http://127.0.0.1:2017`（v2rayA 的管理页，和 Ash 在同一台手机上）。第一次要建一个账号，然后导入订阅、选一个节点、点启动。HTTP 代理端口保持默认 20171。
- 订阅是主人的私有东西，只放在 v2rayA 里，不用给你，你也不要问他要。
- v2rayA 只在用到 Codex（选了 Codex 模型、或发起 Codex 登录）时才会起来。只用 DeepSeek 的 pi 帮手不会起它。

Codex 登录后，出去的路每次开工前都会自己选：v2rayA 通就走它；不通但直连通（主人开着全局 VPN）就直连；都不通，这一轮改用 DeepSeek。

## 连不上时：自动切到 DeepSeek

Codex 中途连不上、或登录失效，pi 会在**同一个会话**里改用 DeepSeek 接着做（历史都在），并给主人发一句话。你不用管；之后每分钟试一次，通了自动切回 Codex，再发一句话。登录失效的情况要重新登录才会切回（见上）。主人问起来，用 `configure` 读回的 `fallback`（`network` 或 `login`）和 `route` 回答。

## 好的样子

主人说：「让小助手改用 Codex。」你先 `runtimes` 确认有 `pi`，`update` 把它的运行时换成 `pi`、模型 `openai-codex/gpt-5.5`；再 `configure` 读回，看到 `codex_login` 是 `none`，就对主人说一句：「已经换成 pi 了，Codex 还没登录。你先打开手机的 VPN，我给你一个登录链接和一个码，输进去就行。」发出 `login` 后，用 `human_say` 把链接和码发给他。登录成功的话到了，才告诉他可以关 VPN。

## 常见错误

- 没让主人开 VPN 就发起登录：返回 `unavailable`，或者他点开的页面打不开。
- 把码、订阅链接、令牌写进文件或回给别的 agent：它们只给主人本人。
- 反复轮询 `configure` 等登录：等通知就行。
- 看到被切到 DeepSeek 就当出错重试：这是设计，通了会自己切回。
- 以为换运行时会丢记忆：会话接着用，只是脑子换了。

## 怎么核对

`service:agents/configure {agent}` 不带 `config`：`model` 是 `openai-codex/…` 且 `fallback` 是 `null`、`codex_login` 是 `ready`，才算 Codex 用上了。再让这个帮手回一句话，确认真的在回。
