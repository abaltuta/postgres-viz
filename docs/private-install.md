# Install from a private repository

Sign in with `gh auth login` using a GitHub account with read access to `abaltuta/postgres-viz`. For the Homebrew tap or Scoop bucket, run `gh auth setup-git` if Git needs credentials to clone the repository over HTTPS.

## mise

In a POSIX shell:

```sh
MISE_USE_VERSIONS_HOST=false MISE_GITHUB_TOKEN="$(gh auth token)" mise use -g github:abaltuta/postgres-viz@0.10.0
```

In PowerShell:

```powershell
$env:MISE_USE_VERSIONS_HOST = "false"
$env:MISE_GITHUB_TOKEN = gh auth token
mise use -g github:abaltuta/postgres-viz@0.10.0
```

## Homebrew

Tap the repo, download your platform's ZIP into Homebrew's cache using your GitHub login, and install the formula. Homebrew verifies the cached archive against the formula's SHA-256 digest.

```sh
brew tap abaltuta/postgres-viz https://github.com/abaltuta/postgres-viz
formula=abaltuta/postgres-viz/postgres-viz
archive=$(brew --cache --build-from-source "$formula")
mkdir -p "$(dirname "$archive")"
gh release download v0.10.0 --repo abaltuta/postgres-viz --pattern "${archive##*--}" --output "$archive"
brew install "$formula"
```

## Scoop

Scoop uses the token to resolve the private release asset for your CPU.

```powershell
$env:SCOOP_GH_TOKEN = gh auth token
scoop bucket add postgres-viz https://github.com/abaltuta/postgres-viz
scoop install postgres-viz/postgres-viz
```
