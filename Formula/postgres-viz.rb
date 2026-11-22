class PostgresViz < Formula
  desc "Explore PostgreSQL dependencies in an offline viewer"
  homepage "https://github.com/abaltuta/postgres-viz"
  version "0.10.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/abaltuta/postgres-viz/releases/download/v#{version}/postgres-viz-darwin-arm64.zip"
      sha256 "25f305b8434acd4c95b1a3a7330fdfe709d8d5dfd7f611a5e0a04fa069ba726b"
    else
      url "https://github.com/abaltuta/postgres-viz/releases/download/v#{version}/postgres-viz-darwin-amd64.zip"
      sha256 "96e2a10965a58a45d7f81f8deee7cee580d25f1367935285e1408566c0492065"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/abaltuta/postgres-viz/releases/download/v#{version}/postgres-viz-linux-arm64.zip"
      sha256 "022967baa06c748ec29bdcdd172f29309fce5e4beaa8fb6c1faedc2b5a0a5dab"
    else
      url "https://github.com/abaltuta/postgres-viz/releases/download/v#{version}/postgres-viz-linux-amd64.zip"
      sha256 "eea63f3f967909c094d1d51238807677a9a0163ac48ff211dd9b4884b7f9a710"
    end
  end

  def install
    bin.install "postgres-viz"
    pkgshare.install "THIRD-PARTY-NOTICES.txt"
  end

  test do
    assert_match "postgres-viz scan", shell_output("#{bin}/postgres-viz --help 2>&1")
  end
end
