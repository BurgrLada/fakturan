import {
  CircleHelp,
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
import {
  isVisible,
  NAV_ROUTES,
  SHOW_PLANNED_SECTIONS,
  type NavKey,
  type NavRoute,
} from "@/lib/nav";

export { SHOW_PLANNED_SECTIONS, type NavKey };

export type NavItem = NavRoute & { icon: LucideIcon };

const ICONS: Record<NavKey, LucideIcon> = {
  overview: LayoutDashboard,
  invoices: FileText,
  recurring: Repeat,
  customers: Users,
  catalog: Tag,
  payments: CreditCard,
  reports: PieChart,
  help: CircleHelp,
  settings: Settings,
  admin: Shield,
};

export const NAV_ITEMS: readonly NavItem[] = NAV_ROUTES.map((entry) => ({
  ...entry,
  icon: ICONS[entry.key],
}));

export function visibleNavItems(
  role: string | null | undefined,
  showPlanned: boolean = SHOW_PLANNED_SECTIONS,
): NavItem[] {
  return NAV_ITEMS.filter((entry) => isVisible(entry, role, showPlanned));
}

export function isActive(entry: NavItem, pathname: string): boolean {
  if (entry.key === "overview") return pathname === "/";
  if (entry.key === "settings") return pathname.startsWith("/nastaveni");
  return pathname === entry.href || pathname.startsWith(`${entry.href}/`);
}
