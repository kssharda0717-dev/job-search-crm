import { useEffect, useState } from "react";
import "./style.css";
import { useCrmData } from "./sidepanel/hooks";
import { JobsTab, ContactsTab, DraftsTab, VaultTab } from "./sidepanel/tabs";
import { SettingsTab } from "./sidepanel/Settings";
import { getSettings, isConfigured } from "./lib/settings";

const TABS = ["Jobs", "Contacts", "Drafts", "Vault", "Settings"] as const;
type Tab = (typeof TABS)[number];

function SidePanel() {
  const [tab, setTab] = useState<Tab>("Jobs");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const { data, loading, error, refresh } = useCrmData();

  const checkConfig = () => {
    void getSettings().then((s) => setConfigured(isConfigured(s)));
  };

  useEffect(checkConfig, []);

  // Send a first-run user straight to Settings; every other tab would just
  // render an auth error.
  useEffect(() => {
    if (configured === false) setTab("Settings");
  }, [configured]);

  const pendingDrafts = data.messages.filter((m) => !m.sent_at).length;

  return (
    <div className="flex h-screen flex-col bg-slate-50 dark:bg-slate-900">
      <header className="border-b border-slate-200 px-3 py-2 dark:border-slate-700">
        <h1 className="text-sm font-bold">Job Search CRM</h1>
        <p className="text-[11px] text-slate-500">
          {data.jobs.length} applications · {data.contacts.length} contacts
        </p>
      </header>

      <nav className="flex gap-1 border-b border-slate-200 px-2 py-1.5 dark:border-slate-700">
        {TABS.map((name) => (
          <button
            key={name}
            onClick={() => setTab(name)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
              tab === name
                ? "bg-brand-500 text-white"
                : "text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
            }`}
          >
            {name}
            {name === "Drafts" && pendingDrafts > 0 && (
              <span className="ml-1 rounded-full bg-amber-400 px-1.5 text-[10px] text-slate-900">
                {pendingDrafts}
              </span>
            )}
          </button>
        ))}
      </nav>

      <main className="flex-1 overflow-y-auto p-3">
        {tab === "Settings" ? (
          <SettingsTab
            onSaved={() => {
              checkConfig();
              void refresh();
            }}
          />
        ) : configured === false ? (
          <p className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500">
            Set your proxy URL and auth token in Settings to get started.
          </p>
        ) : loading ? (
          <p className="text-center text-xs text-slate-500">Loading…</p>
        ) : error ? (
          <div className="rounded bg-red-50 p-3 text-xs text-red-700">
            <p className="font-semibold">Could not load your data</p>
            <p className="mt-1">{error}</p>
          </div>
        ) : tab === "Jobs" ? (
          <JobsTab data={data} refresh={refresh} />
        ) : tab === "Contacts" ? (
          <ContactsTab data={data} refresh={refresh} onShowDrafts={() => setTab("Drafts")} />
        ) : tab === "Drafts" ? (
          <DraftsTab data={data} refresh={refresh} />
        ) : (
          <VaultTab data={data} />
        )}
      </main>
    </div>
  );
}

export default SidePanel;
