import { useState } from "react";
import { ExternalLink, LoaderCircle } from "lucide-react";
import { airtableEmbedUrl } from "../lib/format";

/**
 * A school's Airtable registration & M-PESA form, shown inside the app. The
 * "Open" button is always there too: some phones block forms inside apps, and
 * opening it in the browser always works.
 */
export function AirtableForm({ url, schoolName }: { url: string; schoolName: string }) {
  const embed = airtableEmbedUrl(url);
  const [loaded, setLoaded] = useState(false);
  return (
    <div>
      {embed ? (
        <div className="relative overflow-hidden rounded-[22px] bg-white ring-1 ring-line">
          {!loaded && (
            <div className="absolute inset-0 grid place-items-center text-slate" role="status">
              <span className="flex items-center gap-2"><LoaderCircle className="h-5 w-5 animate-spin" /> Loading {schoolName}'s form…</span>
            </div>
          )}
          <iframe
            key={embed}
            src={embed}
            title={`${schoolName} registration and M-PESA payment form`}
            className="block h-[78vh] min-h-[560px] w-full border-0"
            loading="lazy"
            onLoad={() => setLoaded(true)}
          />
        </div>
      ) : (
        <p className="sheet text-[15px] text-slate">This form opens in your browser.</p>
      )}
      <a href={url} target="_blank" rel="noreferrer" className="btn-primary mt-3 h-12 w-full text-base">
        <ExternalLink className="h-4 w-4" /> Open Registration & M-PESA Form
      </a>
    </div>
  );
}
