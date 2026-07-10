import { randomUUID } from "node:crypto";

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
  private mutations: Promise<void> = Promise.resolve();

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
    return this.enqueueMutation(() => this.saveNow(name, conn, profileId));
  }

  async setActive(profileId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const state = this.state();
      if (!state.profiles.some((p) => p.id === profileId)) return;
      await this.writeState({ ...state, activeId: profileId });
    });
  }

  async delete(profileId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const state = this.state();
      const profiles = state.profiles.filter((p) => p.id !== profileId);
      const key = this.secretKey(profileId);
      const previousConnection = await this.secrets.get(key);
      await this.secrets.delete(key);
      const activeId = profiles.some((p) => p.id === state.activeId)
        ? state.activeId
        : sortedProfiles(profiles)[0]?.id;
      try {
        await this.writeState({ profiles, activeId });
      } catch (stateError) {
        if (previousConnection !== undefined) {
          try {
            await this.secrets.store(key, previousConnection);
          } catch (rollbackError) {
            throw new AggregateError(
              [stateError, rollbackError],
              "failed to delete connection profile and restore its secret",
            );
          }
        }
        throw stateError;
      }
    });
  }

  async migrateLegacy(defaultName = "Default"): Promise<void> {
    return this.enqueueMutation(async () => {
      if (this.state().profiles.length > 0) return;
      const legacy = await this.secrets.get(this.legacySecretKey);
      if (!legacy) return;
      await this.saveNow(defaultName, legacy);
    });
  }

  private async saveNow(
    name: string,
    conn: string,
    profileId?: string,
  ): Promise<ConnectionProfile> {
    const state = this.state();
    const now = Date.now();
    const existing = profileId ? state.profiles.find((p) => p.id === profileId) : undefined;
    const profile: ConnectionProfile = existing
      ? { ...existing, name, updatedAt: now }
      : {
          id: randomUUID(),
          name,
          createdAt: now,
          updatedAt: now,
        };
    const profiles = existing
      ? state.profiles.map((p) => (p.id === profile.id ? profile : p))
      : [...state.profiles, profile];
    const key = this.secretKey(profile.id);
    const previousConnection = await this.secrets.get(key);
    await this.secrets.store(key, conn);
    try {
      await this.writeState({ profiles, activeId: profile.id });
    } catch (stateError) {
      try {
        if (previousConnection === undefined) await this.secrets.delete(key);
        else await this.secrets.store(key, previousConnection);
      } catch (rollbackError) {
        throw new AggregateError(
          [stateError, rollbackError],
          "failed to save connection profile and restore its secret",
        );
      }
      throw stateError;
    }
    return profile;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation, () => operation());
    this.mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
