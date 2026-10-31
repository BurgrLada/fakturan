import {
  CreditCard,
  FileText,
  LayoutDashboard,
  type LucideIcon,
  PieChart,
  Repeat,
  Settings,
  Shield,
  Tag,
  Users,
} from "lucide-react";
import { TEXTS } from "@/lib/texts";

// Release switch: false hides every section that is still only a "Připravujeme" placeholder.
export const SHOW_PLANNED_SECTIONS = true;

export type NavKey = keyof typeof TEXTS.nav;

export type NavItem = {
  key: NavKey;
  label: string;
  href: string;
  icon: LucideIcon;
  planned: boolean;
  adminOnly: boolean;
};

function item(
  key: NavKey,
  href: string,
  icon: LucideIcon,
  flags: { planned?: boolean; adminOnly?: boolean } = {},
): NavItem {
  return {
    key,
    label: TEXTS.nav[key],
    href,
    icon,
    planned: flags.planned ?? false,
    adminOnly: flags.adminOnly ?? false,
  };
}

export const NAV_ITEMS: readonly NavItem[] = [
  item("overview", "/", LayoutDashboard),
  item("invoices", "/faktury", FileText),
  item("recurring", "/pravidelne", Repeat, { planned: true }),
  item("customers", "/zakaznici", Users),
  item("catalog", "/cenik", Tag),
  item("payments", "/platby", CreditCard, { planned: true }),
  item("reports", "/prehledy", PieChart, { planned: true }),
  item("settings", "/nastaveni/ucet", Settings),
  item("admin", "/administrace", Shield, { adminOnly: true }),
];

export function visibleNavItems(
  role: string | null | undefined,
  showPlanned: boolean = SHOW_PLANNED_SECTIONS,
): NavItem[] {
  return NAV_ITEMS.filter(
    (entry) => (showPlanned || !entry.planned) && (!entry.adminOnly || role === "admin"),
  );
}

export function isActive(entry: NavItem, pathname: string): boolean {
  if (entry.key === "overview") return pathname === "/";
  if (entry.key === "settings") return pathname.startsWith("/nastaveni");
  return pathname === entry.href || pathname.startsWith(`${entry.href}/`);
}
