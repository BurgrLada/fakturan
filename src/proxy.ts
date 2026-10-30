import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { recordAdminDenial } from "@/server/auth/session";
import { getCatalogItem } from "@/server/services/catalog";
import { getCustomer } from "@/server/services/customers";
import { getInvoice } from "@/server/services/invoices";

const DETAIL = /^\/(?:(zakaznici|cenik)\/([^/]+)|(faktury)\/([^/]+)(?:\/upravit)?)$/;
const NEW_PAGES = new Set(["novy", "nova"]);
const FINDERS = {
  zakaznici: getCustomer,
  cenik: getCatalogItem,
  faktury: getInvoice,
};

// The pages sit behind Suspense, where notFound() can no longer change a status already sent as 200,
// so existence and ownership are decided here, before any rendering.
export async function proxy(request: NextRequest) {
  const session = await auth.api.getSession({
    headers: request.headers,
    query: { disableRefresh: true },
  });
  const notFound = () =>
    NextResponse.rewrite(new URL("/stranka-neexistuje", request.url), { status: 404 });
  const { pathname } = request.nextUrl;

  if (pathname === "/administrace") {
    if (session && session.user.role !== "admin") {
      recordAdminDenial(request.headers, session.user.id);
      return notFound();
    }
    return NextResponse.next();
  }

  const detail = DETAIL.exec(pathname);
  const section = (detail?.[1] ?? detail?.[3]) as keyof typeof FINDERS | undefined;
  const id = detail?.[2] ?? detail?.[4];
  if (section && id && session && request.method === "GET" && !NEW_PAGES.has(id)) {
    let key: string;
    try {
      key = decodeURIComponent(id);
    } catch {
      return notFound();
    }
    if (!FINDERS[section](session.user.id, key)) return notFound();
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/administrace",
    "/zakaznici/:id",
    "/cenik/:id",
    "/faktury/:id",
    "/faktury/:id/upravit",
  ],
};
