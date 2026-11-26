class PostgresViz < Formula
  desc "Explore PostgreSQL dependencies in an offline viewer"
  homepage "https://github.com/abaltuta/postgres-viz"
  version "0.11.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/abaltuta/postgres-viz/releases/download/v#{version}/postgres-viz-darwin-arm64.zip"
      sha256 "5ddcc73eeaef464cfd3eb0509ebb397ec191b5c03369958813c8ca903a9fece0"
    else
      url "https://github.com/abaltuta/postgres-viz/releases/download/v#{version}/postgres-viz-darwin-amd64.zip"
      sha256 "21adb93a9ea061dfa6e8c1f9d32dc82fcfd7d5a17bd265a42b577df89fcf5cf3"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/abaltuta/postgres-viz/releases/download/v#{version}/postgres-viz-linux-arm64.zip"
      sha256 "17171afa31548859445c92f128cc87060c5c2cc5af15885f501c34b4e69f023d"
    else
      url "https://github.com/abaltuta/postgres-viz/releases/download/v#{version}/postgres-viz-linux-amd64.zip"
      sha256 "32d125b45852d8c1f628738f1daf731eab5b6fac28cd35c8f1339c467d3a460b"
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
