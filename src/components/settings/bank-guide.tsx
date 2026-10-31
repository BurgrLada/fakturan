import { TEXTS } from "@/lib/texts";

const T = TEXTS.bankMailbox.guide;

export function BankGuide() {
  return (
    <section className="flex max-w-xl flex-col gap-3 rounded-lg border p-4">
      <h2 className="text-lg">{T.title}</h2>
      <p className="text-sm">{T.recommend}</p>
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
        {T.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="text-sm text-muted-foreground">{T.note}</p>
    </section>
  );
}
