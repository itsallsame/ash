/**
 * The registry (HUB-MODULES §1.3): who is here now and which words each speaks. Memory only; a hand or a body that is
 * registered or revoked is remembered by the module that owns it, not here.
 */
import type { MemberKind } from "../../../../sdk/src/ids";
import type { Member, WordContract } from "../../../../sdk/src/word";
import type { MemberInfo, Registry } from "../types";

/** A member may say it lives on this machine (a hand on the local link); `findByWord` puts those first. */
export type LocalMember = Member & { local?: boolean };

/** A contract written for a kind of member (`agent:*`) belongs to every member of that kind. */
const speaks = (member: Member, contract: WordContract): boolean =>
  contract.member === member.id || (contract.member.endsWith(":*") && member.id.startsWith(contract.member.slice(0, -1)));

const infoOf = (m: Member): MemberInfo => ({ id: m.id, kind: m.kind, name: m.name });

export function createRegistry(): Registry {
  const members = new Map<string, LocalMember>();
  const watchers = new Set<(id: string, change: "added" | "removed") => void>();
  const emit = (id: string, change: "added" | "removed") => {
    for (const cb of [...watchers]) { try { cb(id, change); } catch { /* a listener must not break the registry */ } }
  };
  const contractOf = (member: Member, word: string): WordContract | undefined =>
    member.words().find((c) => c.word === word && speaks(member, c));

  return {
    add(m) { members.set(m.id, m); emit(m.id, "added"); },
    remove(id) { if (members.delete(id)) emit(id, "removed"); },
    get(id) { return members.get(id) ?? null; },
    find(to, word) {
      const member = members.get(to);
      const contract = member && contractOf(member, word);
      return member && contract ? { member, contract } : null;
    },
    findByWord(word, prefer) {
      const all = [...members.values()].filter((m) => contractOf(m, word) !== undefined);
      const rank = (m: LocalMember) => (prefer?.kind && m.kind === prefer.kind ? 0 : 2) + (m.local ? 0 : 1);
      return all.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
    },
    listeners(word) {
      return [...members.values()].filter((m) => m.listens?.some((p) => (p.endsWith("*") ? word.startsWith(p.slice(0, -1)) : p === word)));
    },
    list(filter) {
      return [...members.values()].filter((m) => !filter?.kind || m.kind === (filter.kind as MemberKind)).map(infoOf);
    },
    describe(id) {
      const m = members.get(id);
      return m ? { info: infoOf(m), words: m.words().filter((c) => speaks(m, c)) } : null;
    },
    onChange(cb) { watchers.add(cb); return () => { watchers.delete(cb); }; },
  };
}
