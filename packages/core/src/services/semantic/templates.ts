import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PersonaFile } from "./persona";

/** The starting text of the persona files and of PULSE.md. */
export type SemanticTemplates = Record<PersonaFile, string> & { "PULSE.md": string };

/** The starting texts are `<dir>/<SOUL|IDENTITY|PULSE>.template.md` (ash-skills/persona). Throws when one is missing. */
export function fileTemplates(dir: string): SemanticTemplates {
  const read = (name: string): string => readFileSync(join(dir, `${name}.template.md`), "utf8");
  return { "SOUL.md": read("SOUL"), "IDENTITY.md": read("IDENTITY"), "PULSE.md": read("PULSE") };
}
