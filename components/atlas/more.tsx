// Collapsed explanation: keeps the page scannable while the full method text stays one click away.
import type { ReactNode } from "react";
import { Info } from "lucide-react";

export default function More({ label, children }: { label: string; children: ReactNode }) {
  return <details className="more"><summary><Info size={12} aria-hidden /> {label}</summary><div className="more-body">{children}</div></details>;
}
