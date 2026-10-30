import type { Metadata } from "next";
import { Suspense } from "react";
import { DeleteAccountForm } from "@/components/account/delete-account-form";
import { requireSession } from "@/server/auth/session";
import { hasPassword } from "@/server/services/users";

export const metadata: Metadata = { title: "Účet | Fakturan" };

async function AccountContent() {
  const { user } = await requireSession();
  return <DeleteAccountForm hasPassword={hasPassword(user.id)} />;
}

export default function AccountPage() {
  return (
    <>
      <h1 className="font-brand text-2xl">Účet</h1>
      <h2 className="text-lg">Smazání účtu</h2>
      <Suspense>
        <AccountContent />
      </Suspense>
    </>
  );
}
