import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilitySpec } from "../../../../sdk/src/link";
import { capabilityContract, HandMember } from "../../../src/edges/link-server/hands/hand-member";

const cap = (name: string, label?: string): CapabilitySpec => ({ name, description: "x", input_schema: { type: "object" }, effect: "read", risk: "none", ...(label !== undefined ? { label } : {}) } as CapabilitySpec);

test("a capability the hand gave no label is labelled by the device's name, never by the capability's raw name", () => {
  const phone = new HandMember({ id: "device:phone", kind: "device", name: "Redmi K30", capabilities: [cap("camera.snap"), cap("calendar.list", "在看日程")], session: () => null, local: true });
  const labels = Object.fromEntries(phone.words().map((c) => [c.word, c.label.doing]));
  assert.deepEqual(labels, { "camera.snap": "在用 Redmi K30 的能力", "calendar.list": "在看日程" });
});

test("a capability with no label on a device with no readable name is 在处理", () => {
  for (const name of [undefined, "", "device:phone", "my_phone"]) {
    const label = capabilityContract("device:phone", cap("camera.snap"), name).label.doing;
    assert.equal(label, "在处理", JSON.stringify(name));
    assert.ok(!label.includes("camera"));
  }
});
