class PostgresViz < Formula
  desc "Explore PostgreSQL dependencies in an offline viewer"
  homepage "https://github.com/abaltuta/postgres-viz"
  version "0.11.1"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/abaltuta/postgres-viz/releases/download/v#{version}/postgres-viz-darwin-arm64.zip"
      sha256 "1922400a6237652eff91776d6d331be2b297bd96aa9e0b31d08091f6c43df512"
    else
      url "https://github.com/abaltuta/postgres-viz/releases/download/v#{version}/postgres-viz-darwin-amd64.zip"
      sha256 "ed329f1c26882e23c5a8f8a13de6eea5902c5d2354d389c6f72b0415922e586e"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/abaltuta/postgres-viz/releases/download/v#{version}/postgres-viz-linux-arm64.zip"
      sha256 "2d56305f726ce93776e5affe2cbdc142ad702171c4430b3cbb18180ed0fe1365"
    else
      url "https://github.com/abaltuta/postgres-viz/releases/download/v#{version}/postgres-viz-linux-amd64.zip"
      sha256 "1e3ebe35ce5162737f5838df477af9dfac82cab885cc2a722a8169639f3aa0f8"
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
