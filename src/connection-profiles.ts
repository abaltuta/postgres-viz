const STATE_KEY = "postgresViz.connectionProfiles";

export interface WorkspaceStateLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

interface ProfileState {
  activeId?: string;
  profiles: ConnectionProfile[];
}

export interface ActiveConnection {
  profile: ConnectionProfile;
  conn: string;
}

export class ConnectionProfileStore {
  constructor(
    private readonly workspaceState: WorkspaceStateLike,
    private readonly secrets: SecretStorageLike,
    private readonly workspaceId: string,
    private readonly legacySecretKey: string,
  ) {}

  list(): ConnectionProfile[] {
    return sortedProfiles(this.state().profiles);
  }

  activeProfile(): ConnectionProfile | undefined {
    const state = this.state();
    return state.profiles.find((p) => p.id === state.activeId) ?? sortedProfiles(state.profiles)[0];
  }

  async activeConnection(): Promise<ActiveConnection | undefined> {
    const profile = this.activeProfile();
    if (!profile) return undefined;
    const conn = await this.secrets.get(this.secretKey(profile.id));
    return conn ? { profile, conn } : undefined;
  }

  async connection(profileId: string): Promise<string | undefined> {
    return this.secrets.get(this.secretKey(profileId));
  }

  async save(name: string, conn: string, profileId?: string): Promise<ConnectionProfile> {
    const state = this.state();
    const now = Date.now();
    const existing = profileId ? state.profiles.find((p) => p.id === profileId) : undefined;
    const profile: ConnectionProfile = existing
      ? { ...existing, name, updatedAt: now }
      : {
          id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          name,
          createdAt: now,
          updatedAt: now,
        };
    const profiles = existing
      ? state.profiles.map((p) => (p.id === profile.id ? profile : p))
      : [...state.profiles, profile];
    await this.secrets.store(this.secretKey(profile.id), conn);
    await this.writeState({ profiles, activeId: profile.id });
    return profile;
  }

  async setActive(profileId: string): Promise<void> {
    const state = this.state();
    if (!state.profiles.some((p) => p.id === profileId)) return;
    await this.writeState({ ...state, activeId: profileId });
  }

  async delete(profileId: string): Promise<void> {
    const state = this.state();
    const profiles = state.profiles.filter((p) => p.id !== profileId);
    await this.secrets.delete(this.secretKey(profileId));
    const activeId = profiles.some((p) => p.id === state.activeId)
      ? state.activeId
      : sortedProfiles(profiles)[0]?.id;
    await this.writeState({
      profiles,
      activeId,
    });
  }

  async migrateLegacy(defaultName = "Default"): Promise<void> {
    if (this.state().profiles.length > 0) return;
    const legacy = await this.secrets.get(this.legacySecretKey);
    if (!legacy) return;
    const profile = await this.save(defaultName, legacy);
    await this.setActive(profile.id);
  }

  private state(): ProfileState {
    const raw = this.workspaceState.get<Partial<ProfileState>>(STATE_KEY);
    return {
      activeId: nonEmptyTrimmedString(raw?.activeId),
      profiles: Array.isArray(raw?.profiles) ? normalizeProfiles(raw.profiles) : [],
    };
  }

  private async writeState(state: ProfileState): Promise<void> {
    await this.workspaceState.update(STATE_KEY, state);
  }

  private secretKey(profileId: string): string {
    return `postgresViz.connectionProfile:${this.workspaceId}:${profileId}`;
  }
}

export function defaultProfileName(conn: string): string {
  try {
    const url = new URL(conn);
    let db = url.pathname.slice(1) || "postgres";
    try {
      db = decodeURIComponent(db);
    } catch {
      // Keep the raw path if the connection string contains malformed escapes.
    }
    return `${db}@${url.hostname || "localhost"}`;
  } catch {
    return "Default";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function timestampOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonEmptyTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function sortedProfiles(profiles: ConnectionProfile[]): ConnectionProfile[] {
  return [...profiles].sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeProfiles(values: unknown[]): ConnectionProfile[] {
  const profiles = new Map<string, ConnectionProfile>();
  for (const value of values) {
    const profile = normalizeProfile(value);
    if (profile && !profiles.has(profile.id)) profiles.set(profile.id, profile);
  }
  return [...profiles.values()];
}

function normalizeProfile(value: unknown): ConnectionProfile | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = nonEmptyTrimmedString(value.id);
  const name = nonEmptyTrimmedString(value.name);
  if (!id || !name) return undefined;
  const createdAt = timestampOr(value.createdAt, 0);
  return {
    id,
    name,
    createdAt,
    updatedAt: timestampOr(value.updatedAt, createdAt),
  };
}
