import { Storage } from "@plasmohq/storage";
import { DEFAULT_FOLLOW_UP_DAYS } from "@crm/shared/constants";

export interface Settings {
  apiBaseUrl: string;
  /** Shared secret for the proxy. No LLM provider key is ever stored here. */
  authToken: string;
  /** Prefixes every resume filed in the vault, ahead of company and role. */
  userName: string;
  followUpDays: number;
  /** Master switch for background polling. */
  pollingEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiBaseUrl: "http://localhost:8787",
  authToken: "",
  userName: "",
  followUpDays: DEFAULT_FOLLOW_UP_DAYS,
  pollingEnabled: true,
};

const storage = new Storage({ area: "local" });
const KEY = "settings";

export async function getSettings(): Promise<Settings> {
  const stored = await storage.get<Partial<Settings>>(KEY);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await storage.set(KEY, next);
  return next;
}

export function isConfigured(settings: Settings): boolean {
  return settings.apiBaseUrl.length > 0 && settings.authToken.length > 0;
}
