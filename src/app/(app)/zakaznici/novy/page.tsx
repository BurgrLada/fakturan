import type { Metadata } from "next";
import Link from "next/link";
import { CustomerForm } from "@/components/customers/customer-form";
import { buttonVariants } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.customers;

export const metadata: Metadata = { title: `${T.add} | ${TEXTS.appName}` };

export default function NewCustomerPage() {
  return (
    <>
      <Link href="/zakaznici" className={buttonVariants({ variant: "ghost", size: "sm" })}>
        {T.back}
      </Link>
      <h1 className="font-brand text-2xl">{T.add}</h1>
      <CustomerForm initial={null} />
    </>
  );
}
