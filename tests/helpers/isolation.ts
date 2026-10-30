import { randomUUID } from "node:crypto";
import { expect } from "vitest";

type Awaitable<T> = T | Promise<T>;

export type IsolationSubject<Id> = {
  create: (ownerId: string) => Awaitable<Id>;
  // Empty (null, undefined, empty array) means "not visible to this owner".
  find: (ownerId: string, id: Id) => Awaitable<unknown>;
  list?: (ownerId: string) => Awaitable<Id[]>;
  owners?: readonly [string, string];
};

function visible(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value != null;
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
}
