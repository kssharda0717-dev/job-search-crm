import type { ReactNode } from "react";
import type { ContactStatus, JobStatus } from "@crm/shared";

export function Section({ title, action, children }: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Card({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={`rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800 ${
        onClick ? "cursor-pointer hover:border-brand-500" : ""
      }`}
    >
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500 dark:border-slate-700">
      {children}
    </p>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
}) {
  const styles = {
    primary: "bg-brand-500 text-white hover:bg-brand-600",
    ghost: "border border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700",
    danger: "border border-red-300 text-red-600 hover:bg-red-50",
  }[variant];

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full px-3 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${styles}`}
    >
      {children}
    </button>
  );
}

const JOB_STATUS_STYLES: Record<JobStatus, string> = {
  Pending: "bg-slate-100 text-slate-600",
  Applied: "bg-blue-100 text-blue-700",
  Interviewing: "bg-amber-100 text-amber-700",
  Offer: "bg-green-100 text-green-700",
  Rejected: "bg-red-100 text-red-700",
  Ghosted: "bg-slate-200 text-slate-500",
};

const CONTACT_STATUS_STYLES: Record<ContactStatus, string> = {
  Pending: "bg-slate-100 text-slate-600",
  Accepted: "bg-blue-100 text-blue-700",
  Replied: "bg-green-100 text-green-700",
  Follow_Up_Required: "bg-amber-100 text-amber-700",
};

export function Badge({ status }: { status: JobStatus | ContactStatus }) {
  const style =
    JOB_STATUS_STYLES[status as JobStatus] ??
    CONTACT_STATUS_STYLES[status as ContactStatus] ??
    "bg-slate-100 text-slate-600";

  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${style}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
