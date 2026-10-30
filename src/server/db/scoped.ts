import "server-only";
import { and, eq, type AnyColumn, type SQL } from "drizzle-orm";

type Operators = { eq: typeof eq; and: typeof and };
type Owned = { userId: AnyColumn } | { ownerId: AnyColumn };

function ownerColumn(table: Owned): AnyColumn {
  return "userId" in table ? table.userId : table.ownerId;
}

// Services reach account data only through this condition, so a query cannot omit the owner.
export function scoped(ownerId: string) {
  if (typeof ownerId !== "string" || ownerId === "") {
    throw new Error("scoped() vyžaduje ID vlastníka");
  }
  return {
    ownerId,
    where<T extends Owned>(table: T, extra?: (table: T, ops: Operators) => SQL | undefined): SQL {
      const owner = eq(ownerColumn(table), ownerId);
      const more = extra?.(table, { eq, and });
      return (more ? and(owner, more) : owner) as SQL;
    },
  };
}
