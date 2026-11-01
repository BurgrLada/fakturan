"use client";

import { PaymentDialog, type PaymentTarget } from "./payment-dialog";

export function RefundDialog({
  open,
  target,
  onClose,
  onDone,
}: {
  open: boolean;
  target: PaymentTarget;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <PaymentDialog
      open={open}
      target={target}
      payment={null}
      refund
      onClose={onClose}
      onDone={onDone}
    />
  );
}
