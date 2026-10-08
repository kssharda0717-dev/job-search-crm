import { useEffect, useState } from "react";
import {
  clampFollowUpDays,
  MAX_FOLLOW_UP_DAYS,
  MIN_FOLLOW_UP_DAYS,
} from "@crm/shared/constants";
import { DEFAULT_SETTINGS, getSettings, saveSettings, type Settings } from "../lib/settings";
import { Button, Card } from "./components";

export function SettingsTab({ onSaved }: { onSaved: () => void }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void getSettings().then(setSettings);
  }, []);

  const save = async () => {
    await saveSettings(settings);
    setStatus("Saved");
    onSaved();
    setTimeout(() => setStatus(null), 2000);
  };

  const testConnection = async () => {
    setStatus("Testing…");
    try {
      const res = await fetch(`${settings.apiBaseUrl}/health`);
      setStatus(res.ok ? "Server reachable" : `Server returned ${res.status}`);
    } catch {
      setStatus("Could not reach the server. Is it running?");
    }
  };

  return (
    <div className="space-y-3">
      <Card>
        <label className="block text-xs font-semibold">Proxy server URL</label>
        <input
          value={settings.apiBaseUrl}
          onChange={(e) => setSettings({ ...settings, apiBaseUrl: e.target.value })}
          placeholder="http://localhost:8787"
          className="mt-1 w-full rounded border border-slate-300 bg-transparent px-2 py-1 text-xs dark:border-slate-600"
        />

        <label className="mt-3 block text-xs font-semibold">Auth token</label>
        <input
          type="password"
          value={settings.authToken}
          onChange={(e) => setSettings({ ...settings, authToken: e.target.value })}
          placeholder="CRM_AUTH_TOKEN from server/.env"
          className="mt-1 w-full rounded border border-slate-300 bg-transparent px-2 py-1 text-xs dark:border-slate-600"
        />
        <p className="mt-1 text-[10px] text-slate-500">
          This is the shared secret for your own proxy. Your OpenAI key stays on
          the server and is never stored in the browser.
        </p>

        <label className="mt-3 block text-xs font-semibold">Your name</label>
        <input
          value={settings.userName}
          onChange={(e) => setSettings({ ...settings, userName: e.target.value })}
          placeholder="Arjun Nair"
          className="mt-1 w-full rounded border border-slate-300 bg-transparent px-2 py-1 text-xs dark:border-slate-600"
        />
        <p className="mt-1 text-[10px] text-slate-500">
          Every resume is filed in the vault as Name_Company_Role.pdf, whatever
          it was called on disk. Without this it is filed as Company_Role.pdf.
        </p>

        <label className="mt-3 block text-xs font-semibold">
          Days of silence before a follow-up
        </label>
        <input
          type="number"
          min={MIN_FOLLOW_UP_DAYS}
          max={MAX_FOLLOW_UP_DAYS}
          value={settings.followUpDays}
          onChange={(e) =>
            setSettings({ ...settings, followUpDays: clampFollowUpDays(e.target.value) })
          }
          className="mt-1 w-20 rounded border border-slate-300 bg-transparent px-2 py-1 text-xs dark:border-slate-600"
        />
        <p className="mt-1 text-[10px] text-slate-500">
          After a message you sent goes unanswered this long, the contact moves
          to Follow-up required and a follow-up is drafted for you. This is the
          same number the Drafts tab counts down, and the one the server
          enforces. Between {MIN_FOLLOW_UP_DAYS} and {MAX_FOLLOW_UP_DAYS} days.
        </p>

        <label className="mt-3 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={settings.pollingEnabled}
            onChange={(e) => setSettings({ ...settings, pollingEnabled: e.target.checked })}
          />
          Background polling for accepted connections
        </label>
        <p className="mt-1 text-[10px] text-slate-500">
          Sweeps read your own "Sent invitations" and "Connections" pages — never
          anyone's profile, so nobody is ever notified that you looked. They run
          at random 30-90 minute intervals and pause between 22:00 and 07:00.
        </p>

        <div className="mt-3 flex gap-1">
          <Button onClick={() => void save()}>Save</Button>
          <Button variant="ghost" onClick={() => void testConnection()}>
            Test connection
          </Button>
        </div>

        {status && <p className="mt-2 text-[11px] text-brand-600">{status}</p>}
      </Card>

      <Card>
        <p className="text-xs font-semibold">What the vault captures</p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          When you attach a PDF on a job application — an Easy Apply modal, an
          ATS form, a company careers page — it is uploaded to your own server
          and stored, so it can be filed against the application once you
          submit it. You are shown a toast each time this happens.
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          PDFs you attach anywhere else are ignored. The extension loads on
          every site, but only reads a file when the page is a job application
          or you reached it from a LinkedIn posting.
        </p>
      </Card>

      <Card>
        <p className="text-xs font-semibold">Human-in-the-loop guarantee</p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          This extension reads the page DOM and never calls LinkedIn's private
          APIs. It will never send a message or a connection request for you. It
          fills the composer and highlights LinkedIn's own Send button; the final
          click is always yours.
        </p>
      </Card>
    </div>
  );
}
