# owner.mjs: the owner from a command line

One file, no dependencies, Node 22 or newer. It connects to the hub's local link (`ws://127.0.0.1:<port>/link`) as the
owner's human channel: the same connection a phone makes, to say things, read what comes back, answer cards and call words.
Build it from the repository with `node tools/e2e/build-owner.mjs` (the built file is committed; a test fails when it is
out of date). Source: `owner.ts`. Test: `packages/core/test/edges/owner-cli/owner.test.ts`.

## How it is let in

There is one way in, and the tool uses it as it is (SPEC-03 §2.2, "local" row):

1. `Authorization: Bearer <local token>`: the hub makes this token each time it starts and hands it, with the port, to the
   hand app only (`hands.handoff`, then `IHand.attach` over Binder). It lives in memory; it is not in `host.json`, a log or a file.
2. A signature over the hub's challenge with this client's own key (ECDSA P-256). The key is made on first use and kept in
   `--state` (default `~/.ash-owner/identity.json`, mode 600); the hub registers the channel under it (`paired_by=local`),
   and the owner can list or revoke it like any hand (`service:devices`).

There is no test mode, no switch and no environment variable that skips either check. A wrong token is closed with 4001.

**Consequence for an `adb forward`:** the forwarded connection reaches the hub as a loopback connection, but loopback alone
is not trusted: without the token it is refused. Nothing on the phone gives the token to an adb shell, on purpose. So the
tool needs the token from somewhere the owner chose to put it (`--token-file`, `--token-stdin`); see "Where the token
comes from" below.

## Use

```
owner.mjs --port 8765 --token-file ./token say "你好"
owner.mjs --port 8765 --token-file ./token watch 120
owner.mjs --port 8765 --token-file ./token answer <card id> once
owner.mjs --port 8765 --token-file ./token call service:admin status
owner.mjs --port 8765 --token-file ./token call service:history query '{"limit":20}'
owner.mjs --port 8765 --token-file ./token set-key < deepseek-key.txt
```

Connection: `--port N` (or `--url ws://127.0.0.1:N/link`; env `ASH_OWNER_PORT`), the token from `--token-file PATH`
(env `ASH_OWNER_TOKEN_FILE`) or `--token-stdin` (first line). The token and any key are **never arguments**: arguments
land in the shell history and in `ps`. `--state DIR` keeps the identity key (one hand per state dir); `--name` names the channel.

| Command | What it does |
|---|---|
| `say "<text>"` | Sends the text to `agent:main` (`--to agent:x` for another), waits for this round's answer (`say`, `show`, `ask` for the owner), then for `--settle` seconds (default 1.5) of quiet for more bubbles, and prints them. Ends at once on a question waiting for the owner. `--timeout` (default 120 s) gives up with exit 2. `--all` prints every ledger message that arrives, not only those for the owner. |
| `watch [seconds]` | Prints everything that arrives: ledger messages, cards, questions, and `present` frames (notification, status). Default 60 s, 0 = until Ctrl-C. Declares the `chat` and `notification` surfaces (`--surfaces` to change). |
| `answer <id> <option> [text]` | `<id>` is the message id (or seq) of a card. An approval or a question (`ask` line): sends the owner's answer (`once`, `always`, `deny`, or a question's option; free text for cards that allow it). An option card (`card` line): picks that option for the agent that showed it. A second answer to the same card is refused (exit 3). |
| `call <member> <word> ['<json>' \| - \| @file]` | Calls a word as the owner and prints the result. The body is a JSON object: in the argument, on standard input (`-`) or in a file (`@path`). |
| `set-key [REF]` | `service:vault/set` for `REF` (default `DEEPSEEK_API_KEY`), the key from `--key-file PATH` or standard input; nothing of it is printed. |

### Setting the model key

The owner's word is **`service:vault/set`** with `{ref, value}`; `DEEPSEEK_API_KEY` is the ref the hub's agents and small
model read (`OPENROUTER_API_KEY` for OpenRouter). It is owner-only and local-only: it works only from a channel on the same
machine, which this tool is (local token). Through a relay the hub refuses it.

```
owner.mjs --port N --token-file T set-key < /path/to/deepseek-key.txt        # DEEPSEEK_API_KEY
owner.mjs --port N --token-file T set-key OPENROUTER_API_KEY --key-file k.txt
owner.mjs --port N --token-file T call service:vault list                     # configured: true/false, never a value
```

`call service:vault set '{"ref":"…","value":"…"}'` also works but puts the key in the arguments; use `set-key`, or
`call service:vault set -` with the JSON on standard input. The choice of the main model is a separate word:
`call service:admin model.set '{"provider":"deepseek","model":"…"}'`.

## Output

One line per event on standard output, each starting with a UTC time with milliseconds, then a kind and `key=value`
fields (values with spaces are JSON-quoted). Easy to grep:

```
2026-10-10T15:52:36.491Z conn state=welcomed hand=RxOI… client=client:4puy… local=true
2026-10-10T15:52:36.586Z sent seq=22 id=m_Ny0h… to=agent:main
2026-10-10T15:52:36.943Z msg seq=27 id=m_gFJI… from=agent:main to=person:owner mkind=request word=say text=你好，我在。
2026-10-10T15:52:38.493Z done replies=1 waited_ms=1907
```

Kinds: `conn`, `sent`, `msg` (a message), `card` (an option card: `options=a:text,b:text`), `ask` (an approval or a question:
`options=once:…,always:…,deny:…`), `present`, `history` (`--history N`), `result` (of `call`), `answered`, `timeout`, `done`,
`error`. `--json` prints one JSON object per line (`at`, `kind`, the same fields, and `raw` for the ledger message or frame).

Exit codes: 0 done; 1 cannot connect or refused (4001: wrong token; 4003: revoked); 2 `say` got no reply in time;
3 the hub refused or failed a word; 64 usage.

## Where the token comes from

Only the hand app holds it. What is available without touching the hub:

- On a machine where the hub runs as a plain process (tests, `startHub` with a fake host), the host's `hands.handoff` call
  carries it: that is how `packages/core/test/scenarios` and this tool's test get it.
- On a phone, nothing hands it to an outside process, and that is intended. A way to give an adb-driven tool the token
  has to be a decision of the owner on the phone (for example an explicit, switched-off-by-default action in the hand
  app that writes the token for a debugging session), not something the tool or an adb shell can reach into.
- A relay (a computer paired with `web_ui`) is the other formal door for a remote owner; it gives the human channel with
  `local=false`, so `say`, `answer` and most `call`s work but the local-only words (`vault/set`, `admin/pause`, `admin/logs`) are refused.
  This tool does not speak the relay.
