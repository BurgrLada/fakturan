import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DraftSaver, type SaveReply } from "@/lib/draft-saver";

type Payload = { note: string };

function harness(reply: (payload: Payload) => Promise<SaveReply<number>>) {
  const sent: Payload[] = [];
  const states: string[] = [];
  const saved: number[] = [];
  const saver = new DraftSaver<Payload, number>({
    send: (payload) => {
      sent.push(payload);
      return reply(payload);
    },
    onSaved: (result) => saved.push(result),
    onStatus: (status) => states.push(status.kind),
  });
  return { saver, sent, states, saved };
}

const ok = (result = 1): Promise<SaveReply<number>> => Promise.resolve({ kind: "saved", result });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("automatické ukládání", () => {
  test("[INV-017] uloží po 1,5 s nečinnosti a poslední hodnota vyhrává", async () => {
    const { saver, sent } = harness(() => ok());

    saver.change("a", { note: "a" });
    await vi.advanceTimersByTimeAsync(1000);
    saver.change("b", { note: "b" });
    await vi.advanceTimersByTimeAsync(1499);
    expect(sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([{ note: "b" }]);
  });

  test("[INV-017] běží jeden požadavek a pak se pošle jen nejnovější hodnota", async () => {
    let finish = (_reply: SaveReply<number>) => {};
    const replies = [
      new Promise<SaveReply<number>>((resolve) => {
        finish = resolve;
      }),
      ok(2),
    ];
    const { saver, sent } = harness(() => replies.shift()!);

    saver.change("a", { note: "a" });
    await vi.advanceTimersByTimeAsync(1500);
    saver.change("b", { note: "b" });
    await vi.advanceTimersByTimeAsync(1500);
    saver.change("c", { note: "c" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(sent).toEqual([{ note: "a" }]);

    finish({ kind: "saved", result: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([{ note: "a" }, { note: "c" }]);
  });

  test("[INV-017] obsah shodný s posledním uloženým se neposílá", async () => {
    const { saver, sent } = harness(() => ok());
    const same = new DraftSaver<Payload, number>({
      send: () => ok(),
      onSaved: () => {},
      onStatus: () => {},
      baseline: "a",
    });
    same.change("a", { note: "a" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(same.isDirty()).toBe(false);

    saver.change("a", { note: "a" });
    await vi.advanceTimersByTimeAsync(1500);
    saver.change("a", { note: "a" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(sent).toHaveLength(1);
  });

  test("[INV-017] návrat na uložený obsah zruší čekající zápis", async () => {
    const { saver, sent } = harness(() => ok());
    saver.change("a", { note: "a" });
    await vi.advanceTimersByTimeAsync(1500);

    saver.change("b", { note: "b" });
    saver.change("a", { note: "a" });
    await vi.advanceTimersByTimeAsync(1500);

    expect(sent).toHaveLength(1);
    expect(saver.isDirty()).toBe(false);
  });

  test("[INV-017] po ztracené odpovědi jde první znovu stejný obsah, až pak novější", async () => {
    const replies = [Promise.reject<SaveReply<number>>(new Error("síť")), ok(1), ok(2)];
    replies[0]!.catch(() => {});
    const { saver, sent, states, saved } = harness(() => replies.shift()!);

    saver.change("a", { note: "a" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(states.at(-1)).toBe("offline");

    saver.change("b", { note: "b" });
    await vi.advanceTimersByTimeAsync(5000);

    expect(sent).toEqual([{ note: "a" }, { note: "a" }, { note: "b" }]);
    expect(saved).toEqual([1, 2]);
    expect(states.at(-1)).toBe("saved");
  });

  test("[INV-017] stale zamkne ukládání a další změny se neposílají", async () => {
    const { saver, sent, states } = harness(() => Promise.resolve({ kind: "stale" }));

    saver.change("a", { note: "a" });
    await vi.advanceTimersByTimeAsync(1500);
    saver.change("b", { note: "b" });
    await vi.advanceTimersByTimeAsync(5000);

    expect(sent).toHaveLength(1);
    expect(states.at(-1)).toBe("stale");
    await expect(saver.flush()).resolves.toBe(false);
  });

  test("[INV-017] odmítnutý obsah ukáže chybu a neopakuje se, oprava se pošle", async () => {
    const replies: Promise<SaveReply<number>>[] = [
      Promise.resolve({ kind: "rejected", error: "Špatně" }),
      ok(2),
    ];
    const { saver, sent, states } = harness(() => replies.shift()!);

    saver.change("a", { note: "a" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(1);
    expect(states.at(-1)).toBe("error");

    saver.change("b", { note: "b" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(states.at(-1)).toBe("saved");
  });

  test("[INV-017] návrat z odmítnutého na potvrzený obsah srovná stav i flush", async () => {
    const replies: Promise<SaveReply<number>>[] = [
      ok(1),
      Promise.resolve({ kind: "rejected", error: "Špatně" }),
    ];
    const { saver, sent, states } = harness(() => replies.shift()!);
    saver.change("a", { note: "a" });
    await vi.advanceTimersByTimeAsync(1500);
    saver.change("b", { note: "b" });
    await vi.advanceTimersByTimeAsync(1500);
    await expect(saver.flush()).resolves.toBe(false);

    saver.change("a", { note: "a" });

    expect(states.at(-1)).toBe("saved");
    await expect(saver.flush()).resolves.toBe(true);
    expect(sent).toHaveLength(2);
  });

  test("[INV-017] odmítnutý obsah zůstává problémem, dokud se nezmění", async () => {
    const { saver } = harness(() => Promise.resolve({ kind: "rejected", error: "Špatně" }));
    saver.change("a", { note: "a" });
    await vi.advanceTimersByTimeAsync(1500);

    expect(saver.hasFailed()).toBe(true);
  });

  test("[INV-017] vypršená relace zamkne ukládání", async () => {
    const { saver, states } = harness(() => Promise.resolve({ kind: "expired" }));
    saver.change("a", { note: "a" });
    await vi.advanceTimersByTimeAsync(1500);

    expect(states.at(-1)).toBe("expired");
    await expect(saver.flush()).resolves.toBe(false);
  });

  test("[INV-017] flush pošle čekající změnu hned a dá vědět o výsledku", async () => {
    const { saver, sent } = harness(() => ok());

    saver.change("a", { note: "a" });
    await expect(saver.flush()).resolves.toBe(true);

    expect(sent).toHaveLength(1);
    expect(saver.isDirty()).toBe(false);
  });
});
