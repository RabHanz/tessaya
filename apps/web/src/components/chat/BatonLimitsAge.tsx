/**
 * How old a limits reading is (D92). A setup token's windows come from Baton's five-minute probe, so
 * they lag the account, and a stopped probe would otherwise look like a quiet account.
 */
import { limitsAge } from "@t3tools/baton-shared/accountRoom";
import { cn } from "~/lib/utils";

export function BatonLimitsAge(props: {
  readonly checkedAt: string;
  readonly now: number;
  readonly className?: string;
}) {
  const age = limitsAge(props.checkedAt, props.now);
  if (age === null) return null;
  return (
    <span
      data-testid="limits-age"
      className={cn(
        "text-2xs",
        age.stale ? "text-warning-foreground" : "text-muted-foreground",
        props.className,
      )}
    >
      {age.text}
    </span>
  );
}
