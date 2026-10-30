import { TEXTS } from "@/lib/texts";

const T = TEXTS.invoices.form;

export function PdfPreview({ id, revision }: { id: string | null; revision: number }) {
  return (
    <aside className="flex min-w-0 flex-col gap-2 xl:sticky xl:top-4 xl:self-start">
      <h2 className="text-lg">{T.previewTitle}</h2>
      {id ? (
        <iframe
          key={revision}
          title={T.previewTitle}
          src={`/faktury/${id}/nahled?rev=${revision}`}
          className="h-[36rem] w-full rounded-md border bg-card xl:h-[80vh]"
        />
      ) : (
        <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
          {T.previewEmpty}
        </p>
      )}
    </aside>
  );
}
