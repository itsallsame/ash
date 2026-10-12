# Release gate on the test phone

Install both debug packages and wait for the new kernel and the chat page to connect. Run on the machine with adb and Node 22 or newer:

```sh
node tools/release-gate.mjs --serial TEST_SERIAL --link-file private/link.json --state private/identity --input-xy X,Y
```

`X,Y` is the chat input's centre in physical screen pixels, with the keyboard closed. It is required when running `daily`; that phase types a private draft, scrolls, leaves and returns, and reads history. It does not send a message. Start with an empty chat draft and keep the test phone free of other interaction during a run. The scripted draft is removed after its window.

The four windows are foreground idle (600 seconds), background (300), screen off (300), and daily use (180). ADB sampling and health reads add some time. The gate wakes the phone for foreground and daily use, temporarily extends the screen timeout for the idle window, and restores the original setting. It discovers the kernel by its core program, and sums only renderer services bound by this app.

Reports are JSON under `build/release-gate/`, including phase metrics, the busiest threads, health readings and breach events. CPU uses 100% for one fully occupied core. Missing budgeted measurements fail. Budgets are in `tools/release-budgets.json`; the hub's invariant budgets are in `packages/core/src/services/health/budgets.ts`.

`--phases fg_idle` selects one window. `--scale` is only a diagnostic: a scaled run always exits nonzero and never counts as a release gate. For calibration, keep a full unscaled normal report, compare it against budgets, and verify that a known spinning build fails an unscaled foreground window and names the repeated word in health events.

The link file contains a local token; the identity directory contains a private key. Keep them private, do not print them or include them in reports or commits. The tool refreshes the local link after a restart.
