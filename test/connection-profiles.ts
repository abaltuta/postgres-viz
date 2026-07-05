import assert from "node:assert/strict";
import {
  ConnectionProfileStore,
  defaultProfileName,
  type SecretStorageLike,
  type WorkspaceStateLike,
} from "../src/connection-profiles";

const STATE_KEY = "postgresViz.connectionProfiles";

class FakeState implements WorkspaceStateLike {
  values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

class FakeSecrets implements SecretStorageLike {
  values = new Map<string, string>();
  deleted: string[] = [];

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.values.delete(key);
  }
}

function store(state = new FakeState(), secrets = new FakeSecrets()): ConnectionProfileStore {
  return new ConnectionProfileStore(state, secrets, "workspace-a", "legacy-key");
}

async function main(): Promise<void> {
  {
    const profiles = store();
    const zeta = await profiles.save("zeta", "postgres://u@host/zeta");
    const alpha = await profiles.save("alpha", "postgres://u@host/alpha");

    assert.deepEqual(
      profiles.list().map((p) => p.name),
      ["alpha", "zeta"],
      "profiles list alphabetically",
    );
    assert.equal(profiles.activeProfile()?.id, alpha.id, "saving a profile makes it active");
    assert.equal((await profiles.activeConnection())?.conn, "postgres://u@host/alpha");

    await profiles.setActive(zeta.id);
    assert.equal((await profiles.activeConnection())?.conn, "postgres://u@host/zeta");

    const edited = await profiles.save("beta", "postgres://u@host/beta", zeta.id);
    assert.equal(edited.id, zeta.id, "editing keeps the profile id");
    assert.equal(edited.createdAt, zeta.createdAt, "editing keeps createdAt");
    assert.equal(await profiles.connection(zeta.id), "postgres://u@host/beta");
    assert.equal(profiles.activeProfile()?.id, zeta.id, "editing keeps the edited profile active");

    await profiles.delete(zeta.id);
    assert.equal(profiles.activeProfile()?.id, alpha.id, "deleting the active profile picks a survivor");
    assert.equal(await profiles.connection(zeta.id), undefined, "deleting removes its secret");
  }

  {
    const state = new FakeState();
    const secrets = new FakeSecrets();
    const profiles = store(state, secrets);
    const first = await profiles.save("first", "postgres://u@host/first");
    const second = await profiles.save("second", "postgres://u@host/second");
    state.values.set(STATE_KEY, { activeId: "missing", profiles: profiles.list() });

    await profiles.delete(second.id);
    assert.equal(
      profiles.activeProfile()?.id,
      first.id,
      "delete normalizes a stale active profile id",
    );
  }

  {
    const state = new FakeState();
    const secrets = new FakeSecrets();
    const profiles = store(state, secrets);
    state.values.set(STATE_KEY, {
      activeId: "missing",
      profiles: [
        { id: "zeta", name: "zeta", createdAt: 1, updatedAt: 1 },
        { id: "alpha", name: "alpha", createdAt: 2, updatedAt: 2 },
      ],
    });

    assert.equal(
      profiles.activeProfile()?.id,
      "alpha",
      "stale active id falls back to the first visible profile",
    );

    await profiles.delete("missing");
    assert.equal(
      profiles.activeProfile()?.id,
      "alpha",
      "delete keeps stale-active fallback aligned with visible profile order",
    );
  }

  {
    const state = new FakeState();
    const secrets = new FakeSecrets();
    state.values.set(STATE_KEY, {
      activeId: 42,
      profiles: [
        { id: "valid", name: "valid profile", createdAt: 123 },
        { id: "valid", name: "duplicate profile", createdAt: 456 },
        { id: "blank-id", name: "  ", createdAt: 1 },
        { id: "  ", name: "blank id", createdAt: 1 },
        { id: " padded ", name: " padded profile ", createdAt: 2 },
        { id: "missing-name", createdAt: 1 },
        null,
        "not-a-profile",
      ],
    });
    secrets.values.set("postgresViz.connectionProfile:workspace-a:valid", "postgres://u@host/valid");
    secrets.values.set("postgresViz.connectionProfile:workspace-a:padded", "postgres://u@host/padded");
    const profiles = store(state, secrets);

    assert.deepEqual(
      profiles.list().map((p) => p.name),
      ["padded profile", "valid profile"],
      "malformed and duplicate persisted profiles are ignored",
    );
    assert.equal(
      profiles.activeProfile()?.id,
      "padded",
      "non-string active id falls back to the first visible normalized profile",
    );
    const validProfile = profiles.list().find((p) => p.id === "valid");
    assert.equal(validProfile?.updatedAt, 123, "missing updatedAt falls back to createdAt");
    assert.equal((await profiles.activeConnection())?.conn, "postgres://u@host/padded");
  }

  {
    const state = new FakeState();
    const secrets = new FakeSecrets();
    secrets.values.set("legacy-key", "postgres://u@host/legacy");
    const profiles = store(state, secrets);

    await profiles.migrateLegacy("Legacy");
    assert.equal(profiles.list().length, 1);
    assert.equal(profiles.activeProfile()?.name, "Legacy");
    assert.equal((await profiles.activeConnection())?.conn, "postgres://u@host/legacy");

    await profiles.migrateLegacy("Duplicate");
    assert.equal(profiles.list().length, 1, "legacy migration is idempotent");
  }

  assert.equal(defaultProfileName("postgres://u:p@db.example.com/app"), "app@db.example.com");
  assert.equal(
    defaultProfileName("postgres://u:p@db.example.com/app%20db"),
    "app db@db.example.com",
  );
  assert.equal(
    defaultProfileName("postgres://u:p@db.example.com/app%2Ftenant"),
    "app/tenant@db.example.com",
  );
  assert.equal(defaultProfileName("postgres://u:p@db.example.com"), "postgres@db.example.com");
  assert.equal(defaultProfileName("not a url"), "Default");

  console.log("connection-profiles OK - save, switch, delete, migrate legacy");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
