import type { MessageKind } from "@/lib/email-template";
import type { Language } from "@/lib/preferences";

export type MailContent = { subject: string; body: string };

type AdvanceRest = { dueMinor: number; amount: string };

// {{castka}} of a final invoice is its full total, which this line reconciles with what is left.
// `amount` is the size of the rest: the sign is what picks the sentence, it is never printed.
export const ADVANCE_FINAL_LINE: Record<Language, (rest: AdvanceRest, zaloha: string) => string> = {
  cs: ({ dueMinor, amount }, zaloha) => {
    const counted = `Na fakturu je započtena uhrazená záloha ${zaloha}.`;
    if (dueMinor > 0) return `${counted} Zbývá uhradit ${amount}.`;
    if (dueMinor < 0) return `${counted} Přeplatek k vrácení činí ${amount}.`;
    return `${counted} Faktura je tím uhrazena.`;
  },
  en: ({ dueMinor, amount }, zaloha) => {
    const counted = `The advance payment of ${zaloha} has been deducted.`;
    if (dueMinor > 0) return `${counted} The amount outstanding is ${amount}.`;
    if (dueMinor < 0) return `${counted} The overpayment to be refunded is ${amount}.`;
    return `${counted} The invoice is now paid in full.`;
  },
};

// Printed to the client in the invoice's language, so they belong to the document and not to the UI
// texts. Plain text only: there is no link or image to track or confirm anything with (MAIL-007).
export const DEFAULT_MAIL_CONTENT: Record<Language, Record<MessageKind, MailContent>> = {
  cs: {
    invoice: {
      subject: "Faktura {{cislo_faktury}}",
      body: [
        "Dobrý den,",
        "",
        "v příloze posílám fakturu {{cislo_faktury}} na částku {{castka}} se splatností {{splatnost}}.",
        "Variabilní symbol je {{vs}}.",
        "",
        "S pozdravem",
        "{{dodavatel}}",
      ].join("\n"),
    },
    advance: {
      subject: "Zálohová faktura {{cislo_faktury}}",
      body: [
        "Dobrý den,",
        "",
        "v příloze posílám zálohovou fakturu {{cislo_faktury}} na částku {{castka}} se splatností {{splatnost}}.",
        "Variabilní symbol je {{vs}}.",
        "",
        "S pozdravem",
        "{{dodavatel}}",
      ].join("\n"),
    },
    credit_note: {
      subject: "Opravná faktura {{cislo_faktury}}",
      body: [
        "Dobrý den,",
        "",
        "v příloze posílám opravnou fakturu {{cislo_faktury}} na částku {{castka}}.",
        "",
        "S pozdravem",
        "{{dodavatel}}",
      ].join("\n"),
    },
    reminder: {
      subject: "Upomínka k faktuře {{cislo_faktury}}",
      body: [
        "Dobrý den,",
        "",
        "dovoluji si připomenout fakturu {{cislo_faktury}} se splatností {{splatnost}}. Zbývá uhradit {{zbyva}}.",
        "Variabilní symbol je {{vs}}. Fakturu najdete v příloze.",
        "",
        "Pokud jste již platili, považujte tuto zprávu za bezpředmětnou.",
        "",
        "S pozdravem",
        "{{dodavatel}}",
      ].join("\n"),
    },
    payment_receipt: {
      subject: "Potvrzení platby faktury {{cislo_faktury}}",
      body: [
        "Dobrý den,",
        "",
        "děkuji za platbu {{prijato}} k faktuře {{cislo_faktury}}. Doklad je v příloze.",
        "",
        "S pozdravem",
        "{{dodavatel}}",
      ].join("\n"),
    },
  },
  en: {
    invoice: {
      subject: "Invoice {{cislo_faktury}}",
      body: [
        "Hello,",
        "",
        "please find attached invoice {{cislo_faktury}} for {{castka}}, due on {{splatnost}}.",
        "The payment reference is {{vs}}.",
        "",
        "Kind regards,",
        "{{dodavatel}}",
      ].join("\n"),
    },
    advance: {
      subject: "Advance invoice {{cislo_faktury}}",
      body: [
        "Hello,",
        "",
        "please find attached advance invoice {{cislo_faktury}} for {{castka}}, due on {{splatnost}}.",
        "The payment reference is {{vs}}.",
        "",
        "Kind regards,",
        "{{dodavatel}}",
      ].join("\n"),
    },
    credit_note: {
      subject: "Credit note {{cislo_faktury}}",
      body: [
        "Hello,",
        "",
        "please find attached credit note {{cislo_faktury}} for {{castka}}.",
        "",
        "Kind regards,",
        "{{dodavatel}}",
      ].join("\n"),
    },
    reminder: {
      subject: "Reminder: invoice {{cislo_faktury}}",
      body: [
        "Hello,",
        "",
        "this is a reminder about invoice {{cislo_faktury}}, due on {{splatnost}}. The amount outstanding is {{zbyva}}.",
        "The payment reference is {{vs}}. The invoice is attached.",
        "",
        "If you have already paid, please disregard this message.",
        "",
        "Kind regards,",
        "{{dodavatel}}",
      ].join("\n"),
    },
    payment_receipt: {
      subject: "Payment received for invoice {{cislo_faktury}}",
      body: [
        "Hello,",
        "",
        "thank you for your payment of {{prijato}} towards invoice {{cislo_faktury}}. The document is attached.",
        "",
        "Kind regards,",
        "{{dodavatel}}",
      ].join("\n"),
    },
  },
};
