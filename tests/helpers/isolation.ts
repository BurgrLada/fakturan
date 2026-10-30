import { randomUUID } from "node:crypto";
import { expect } from "vitest";

type Awaitable<T> = T | Promise<T>;

export type IsolationSubject<Id> = {
  create: (ownerId: string) => Awaitable<Id>;
  // Empty (null, undefined, empty array) means "not visible to this owner".
  find: (ownerId: string, id: Id) => Awaitable<unknown>;
  list?: (ownerId: string) => Awaitable<Id[]>;
  // Attempt the write as ownerId and return the rows changed; throwing counts as refused.
  update?: (ownerId: string, id: Id) => Awaitable<number>;
  remove?: (ownerId: string, id: Id) => Awaitable<number>;
  owners?: readonly [string, string];
};

function visible(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value != null;
}

async function assertForeignWriteRefused<Id>(
  subject: IsolationSubject<Id>,
  write: (ownerId: string, id: Id) => Awaitable<number>,
  [owner, stranger]: [string, string],
  id: Id,
): Promise<void> {
  const before = await subject.find(owner, id);
  const changed = await Promise.resolve()
    .then(() => write(stranger, id))
    .catch(() => 0);
  expect(changed, "zápis změnil cizí záznam").toBe(0);
  expect(await subject.find(owner, id), "zápis změnil cizí záznam").toEqual(before);
}

export async function assertIsolated<Id>(subject: IsolationSubject<Id>): Promise<void> {
  const [a, b] = subject.owners ?? [randomUUID(), randomUUID()];
  const idA = await subject.create(a);
  const idB = await subject.create(b);

  expect(visible(await subject.find(a, idA)), "vlastník nevidí vlastní záznam").toBe(true);
  expect(visible(await subject.find(b, idB)), "vlastník nevidí vlastní záznam").toBe(true);
  expect(visible(await subject.find(b, idA)), "B vidí záznam uživatele A").toBe(false);
  expect(visible(await subject.find(a, idB)), "A vidí záznam uživatele B").toBe(false);

  if (subject.list) {
    expect(await subject.list(a)).not.toContain(idB);
    expect(await subject.list(b)).not.toContain(idA);
  }

  // The owner's own write runs last so a no-op implementation cannot pass as isolated.
  if (subject.update) {
    await assertForeignWriteRefused(subject, subject.update, [a, b], idA);
    expect(await subject.update(a, idA), "vlastník nezměnil vlastní záznam").toBeGreaterThan(0);
  }
  if (subject.remove) {
    await assertForeignWriteRefused(subject, subject.remove, [a, b], idA);
    expect(await subject.remove(a, idA), "vlastník nesmazal vlastní záznam").toBeGreaterThan(0);
    expect(visible(await subject.find(a, idA)), "smazaný záznam zůstal").toBe(false);
  }
}
