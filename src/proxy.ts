import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { recordAdminDenial } from "@/server/auth/session";
import { getCatalogItem } from "@/server/services/catalog";
import { getCustomer } from "@/server/services/customers";

const DETAIL = /^\/(zakaznici|cenik)\/([^/]+)$/;

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
  if (detail && session && request.method === "GET" && detail[2] !== "novy") {
    const [, section, id] = detail;
    const find = section === "cenik" ? getCatalogItem : getCustomer;
    let key: string;
    try {
      key = decodeURIComponent(id);
    } catch {
      return notFound();
    }
    if (!find(session.user.id, key)) return notFound();
  }
  return NextResponse.next();
}

export const config = { matcher: ["/administrace", "/zakaznici/:id", "/cenik/:id"] };
