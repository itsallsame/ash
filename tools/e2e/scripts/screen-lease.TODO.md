# Screen lease (timed permission to operate the real screen): to be written

The script waits for `feat/screen-lease` to be in `main`. It should be one script, `screen-lease.json`, with these steps and checks:

1. `service:gate/lease.request` (minutes 1, a purpose) → the owner approves the card (`owner` reaction on the approval card) →
   `lease.status` says active.
2. `screen.tap` on a harmless point succeeds while the lease is active (the same call without the lease is refused with a message that names `lease.request`).
3. A checkpoint where the owner's side reads the phone (`dumpsys` of the island / the notification of the lease) and asserts the indicator is up.
4. `lease.revoke` by the owner (`call` action) → the next `screen.tap` is refused, and the agent got the message that the lease ended.
5. Expiry: a 1-minute lease, an `until` step that polls `lease.status` for `active: false`, then the refusal.

Use the shapes of `approval-*.json` and `vscreen.json`; nothing in the runner has to change.
