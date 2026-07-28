import { useEffect, useState } from "react";
import { api } from "../api/client";

export interface BucketSeverityMeta {
  category: "normal" | "npa";
  is_current: boolean;
}

/**
 * Every bucket tag in every customer list rendered the same orange
 * regardless of delinquency stage or NPA status -- a bucket-1 account and
 * an NPA account looked identical. GET /buckets with no company_id already
 * returns one row per distinct label agency-wide (same de-duplication the
 * bucket filter dropdowns already rely on) -- good enough to color-code by,
 * even though two companies could in principle define the same label
 * differently; that ambiguity already exists everywhere else this label is
 * used unscoped.
 */
export function useBucketSeverity(): Map<string, BucketSeverityMeta> {
  const [meta, setMeta] = useState<Map<string, BucketSeverityMeta>>(new Map());

  useEffect(() => {
    let cancelled = false;
    api
      .get("/buckets")
      .then((res) => {
        if (cancelled) return;
        const map = new Map<string, BucketSeverityMeta>();
        for (const b of res.data.buckets as { label: string; category: "normal" | "npa"; is_current: boolean }[]) {
          map.set(b.label.toLowerCase(), { category: b.category, is_current: b.is_current });
        }
        setMeta(map);
      })
      .catch(() => {
        // Falls back to the flat default color everywhere below -- not
        // worth a toast for a purely cosmetic enhancement.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return meta;
}

/** Green for the "fully current" bucket, red for NPA, the existing default
 *  orange for everything in between (early-to-mid delinquency). */
export function bucketSeverityColor(label: string | null | undefined, meta: Map<string, BucketSeverityMeta>): string {
  if (!label) return "default";
  const m = meta.get(label.toLowerCase());
  if (!m) return "orange";
  if (m.is_current) return "green";
  if (m.category === "npa") return "red";
  return "orange";
}
