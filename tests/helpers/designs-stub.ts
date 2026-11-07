export const isDesignId = (): boolean => true;
export const renderInvoicePdf = (): never => {
  throw new Error("Worker nevykresluje PDF");
};
// The e-mail reads only the accent of a design; the PDF itself is never rendered here.
export const getDesign = () => ({
  id: "cisty",
  tokens: { colors: { accent: "#1f2937", surface: "#f3f4f6", text: "#111827", line: "#d1d5db" } },
});
