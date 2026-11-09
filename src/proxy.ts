import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { recordAdminDenial } from "@/server/auth/session";
import { getCatalogItem } from "@/server/services/catalog";
import { getCustomer } from "@/server/services/customers";
import { getVersion } from "@/server/services/invoice-versions";
import { getInvoice, isFreeDraftId } from "@/server/services/invoices";
import { getRecurring } from "@/server/services/recurring";

const DETAIL = /^\/(?:(zakaznici|cenik|pravidelne)\/([^/]+)|(faktury)\/([^/]+)(?:\/upravit)?)$/;
const VERSION = /^\/faktury\/([^/]+)\/verze\/([^/]+)$/;
const FIXED_PAGES = new Set([
  "/zakaznici/novy",
  "/cenik/novy",
  "/faktury/sablony",
  "/pravidelne/nova",
]);
const NEW_INVOICE = "/faktury/nova";
// Every page of the (app) group; tests/unit/proxy-matcher.test.ts keeps it in sync with the folders.
const APP_SECTIONS =
  /^\/(?:$|(?:administrace|cenik|dashboardy|faktury|napoveda|nastaveni|platby|pravidelne|prehledy|pruvodce|upozorneni|zakaznici)(?:\/|$))/;
const FINDERS = {
  zakaznici: getCustomer,
  cenik: getCatalogItem,
  faktury: getInvoice,
  pravidelne: getRecurring,
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

  // The (app) layout has a static shell that would paint before requireSession() redirects inside
  // Suspense. Only a browser navigation is sent away: route handlers keep their own 401 and 404.
  if (
    !session &&
    request.method === "GET" &&
    request.headers.get("sec-fetch-dest") === "document" &&
    APP_SECTIONS.test(pathname)
  ) {
    return NextResponse.redirect(new URL("/prihlaseni", request.url));
  }

  if (pathname === "/administrace") {
    if (session && session.user.role !== "admin") {
      recordAdminDenial(request.headers, session.user.id);
      return notFound();
    }
    return NextResponse.next();
  }

  // The id is chosen here so the form's address and route match from the start: a later URL swap
  // would leave the router on the old route and a refresh would remount the form.
  if (pathname === NEW_INVOICE && session && request.method === "GET") {
    const target = request.nextUrl.clone();
    target.pathname = `/faktury/${randomUUID()}/upravit`;
    return NextResponse.redirect(target);
  }

  const version = VERSION.exec(pathname);
  if (version && session && request.method === "GET") {
    let found: boolean;
    try {
      const row = getVersion(session.user.id, decodeURIComponent(version[2]!));
      found = row?.invoiceId === decodeURIComponent(version[1]!);
    } catch {
      found = false;
    }
    return found ? NextResponse.next() : notFound();
  }

  const detail = DETAIL.exec(pathname);
  const section = (detail?.[1] ?? detail?.[3]) as keyof typeof FINDERS | undefined;
  const id = detail?.[2] ?? detail?.[4];
  if (
    section &&
    id &&
    session &&
    request.method === "GET" &&
    !FIXED_PAGES.has(pathname) &&
    pathname !== NEW_INVOICE
  ) {
    let key: string;
    try {
      key = decodeURIComponent(id);
    } catch {
      return notFound();
    }
    const unsavedForm = pathname.endsWith("/upravit") && isFreeDraftId(session.user.id, key);
    if (!FINDERS[section](session.user.id, key) && !unsavedForm) return notFound();
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/(administrace|cenik|dashboardy|faktury|napoveda|nastaveni|platby|pravidelne|prehledy|pruvodce|upozorneni|zakaznici)/:path*",
  ],
};
