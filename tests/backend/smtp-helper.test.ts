import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTransport } from "nodemailer";
import { startSmtp, type TestSmtp } from "../helpers/smtp";

describe("testovací SMTP", () => {
  let smtp: TestSmtp;
  const send = (attachments: { filename: string; content: string }[] = []) =>
    createTransport({ host: "127.0.0.1", port: smtp.port, secure: false }).sendMail({
      from: "a@example.cz",
      to: "b@example.cz",
      subject: "Předmět",
      text: "Žluťoučký kůň",
      attachments,
    });

  beforeAll(async () => {
    smtp = await startSmtp();
  });
  afterAll(() => smtp.stop());

  test("zachytí text i rozparsované přílohy", async () => {
    await send([{ filename: "faktura.pdf", content: "%PDF-obsah" }]);
    const mail = await smtp.waitFor("b@example.cz");
    expect(mail.body).toContain("Žluťoučký kůň");
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0].filename).toBe("faktura.pdf");
    expect(mail.attachments[0].content.toString()).toBe("%PDF-obsah");
  });

  test("rejectNext odmítne jednu zprávu daným kódem", async () => {
    smtp.rejectNext(451);
    await expect(send()).rejects.toMatchObject({ responseCode: 451 });
    await expect(send()).resolves.toBeDefined();
  });

  test("dropDuringData přeruší spojení bez přijetí zprávy", async () => {
    const before = smtp.messages.length;
    smtp.dropDuringData();
    await expect(send()).rejects.toThrow();
    expect(smtp.messages).toHaveLength(before);
  });

  test("holdData podrží odpověď na DATA do uvolnění", async () => {
    const before = smtp.messages.length;
    const release = smtp.holdData();
    let settled = false;
    const sending = send().finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    release();
    await sending;
    expect(smtp.messages).toHaveLength(before + 1);
  });
});
