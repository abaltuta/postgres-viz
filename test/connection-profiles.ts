import assert from "node:assert/strict";
import {
  ConnectionProfileStore,
  defaultProfileName,
  type SecretStorageLike,
  type WorkspaceStateLike,
} from "../editors/vscode/connection-profiles";

const STATE_KEY = "postgresViz.connectionProfiles";

class FakeState implements WorkspaceStateLike {
  values = new Map<string, unknown>();
  failNextUpdate = false;

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error("state update failed");
    }
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
    assert.equal(
      profiles.activeProfile()?.id,
      alpha.id,
      "deleting the active profile picks a survivor",
    );
    assert.equal(await profiles.connection(zeta.id), undefined, "deleting removes its secret");
  }

  {
    const profiles = store();
    await profiles.save("alpha", "postgres://u@host/alpha");
    const beta = await profiles.save("beta", "postgres://u@host/beta");
    await profiles.save("zeta", "postgres://u@host/zeta");

    await profiles.setActive("missing");
    assert.equal(
      profiles.activeProfile()?.name,
      "zeta",
      "selecting a missing profile keeps the active profile",
    );

    await profiles.delete(beta.id);
    assert.equal(
      profiles.activeProfile()?.name,
      "zeta",
      "forgetting an inactive profile keeps the active profile",
    );
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
    state.failNextUpdate = true;
    await assert.rejects(
      profiles.save("orphan", "postgres://u@host/orphan"),
      /state update failed/,
    );
    assert.equal(secrets.values.size, 0, "failed metadata save removes the new secret");

    const saved = await profiles.save("stable", "postgres://u@host/stable");
    state.failNextUpdate = true;
    await assert.rejects(
      profiles.save("edited", "postgres://u@host/edited", saved.id),
      /state update failed/,
    );
    assert.equal(
      await profiles.connection(saved.id),
      "postgres://u@host/stable",
      "failed profile edit restores the previous secret",
    );

    state.failNextUpdate = true;
    await assert.rejects(profiles.delete(saved.id), /state update failed/);
    assert.equal(
      await profiles.connection(saved.id),
      "postgres://u@host/stable",
      "failed profile delete restores the secret",
    );
    assert.equal(profiles.activeProfile()?.id, saved.id, "failed delete keeps profile metadata");
  }

  {
    const state = new FakeState();
    const secrets = new FakeSecrets();
    const profiles = store(state, secrets);
    await Promise.all([
      profiles.save("concurrent a", "postgres://u@host/a"),
      profiles.save("concurrent b", "postgres://u@host/b"),
    ]);
    assert.deepEqual(
      profiles.list().map((profile) => profile.name),
      ["concurrent a", "concurrent b"],
      "concurrent saves are serialized without losing profile metadata",
    );
    assert.equal(secrets.values.size, 2, "serialized saves keep one secret per profile");
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
    secrets.values.set(
      "postgresViz.connectionProfile:workspace-a:valid",
      "postgres://u@host/valid",
    );
    secrets.values.set(
      "postgresViz.connectionProfile:workspace-a:padded",
      "postgres://u@host/padded",
    );
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
    const migrated = profiles.activeProfile();
    assert.ok(migrated);
    assert.equal(migrated.name, "Legacy");
    assert.equal((await profiles.activeConnection())?.conn, "postgres://u@host/legacy");

    await profiles.migrateLegacy("Duplicate");
    assert.equal(profiles.list().length, 1, "legacy migration is idempotent");

    await profiles.delete(migrated.id);
    const reopened = store(state, secrets);
    await reopened.migrateLegacy();
    assert.equal(
      reopened.list().length,
      0,
      "forgetting the last profile does not reimport the legacy connection",
    );
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
