import { TEXTS } from "@/lib/texts";

// Release switch: false hides every section that is still only a "Připravujeme" placeholder.
export const SHOW_PLANNED_SECTIONS = true;

export type NavKey = keyof typeof TEXTS.nav;

export type NavRoute = {
  key: NavKey;
  label: string;
  href: string;
  planned: boolean;
  adminOnly: boolean;
};

function route(
  key: NavKey,
  href: string,
  flags: { planned?: boolean; adminOnly?: boolean } = {},
): NavRoute {
  return {
    key,
    label: TEXTS.nav[key],
    href,
    planned: flags.planned ?? false,
    adminOnly: flags.adminOnly ?? false,
  };
}

export const NAV_ROUTES: readonly NavRoute[] = [
  route("overview", "/"),
  route("invoices", "/faktury"),
  route("recurring", "/pravidelne"),
  route("customers", "/zakaznici"),
  route("catalog", "/cenik"),
  route("payments", "/platby"),
  route("reports", "/prehledy"),
  route("settings", "/nastaveni/ucet"),
  route("admin", "/administrace", { adminOnly: true }),
];

export function isVisible(
  entry: Pick<NavRoute, "planned" | "adminOnly">,
  role: string | null | undefined,
  showPlanned: boolean = SHOW_PLANNED_SECTIONS,
): boolean {
  return (showPlanned || !entry.planned) && (!entry.adminOnly || role === "admin");
}

export const SETTINGS_TABS: readonly { href: string; label: string }[] = [
  { href: "/nastaveni/ucet", label: TEXTS.settings.account },
  { href: "/nastaveni/dodavatel", label: TEXTS.settings.supplier },
  { href: "/nastaveni/ucty", label: TEXTS.settings.bankAccounts },
  { href: "/nastaveni/rady", label: TEXTS.settings.numberSeries },
  { href: "/nastaveni/vychozi", label: TEXTS.settings.defaults },
  { href: "/nastaveni/designy", label: TEXTS.settings.designs },
  { href: "/nastaveni/posta", label: TEXTS.settings.mail },
  { href: "/nastaveni/aviza", label: TEXTS.settings.bankMailbox },
  { href: "/nastaveni/automatizace", label: TEXTS.settings.automation },
  { href: "/nastaveni/import", label: TEXTS.importing.nav },
  { href: "/nastaveni/export", label: TEXTS.exporting.nav },
  { href: "/nastaveni/zaloha", label: TEXTS.backup.nav },
  { href: "/nastaveni/historie", label: TEXTS.settings.history },
];
