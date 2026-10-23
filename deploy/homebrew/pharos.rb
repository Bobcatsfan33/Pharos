# DRAFT Homebrew formula for the Pharos CLI (@getpharos/cli). NOT INSTALLABLE YET.
#
# `brew install` does not work anywhere today. Two maintainer actions must happen first:
#
#   1. Publish @getpharos/cli to npm (docs/PUBLISHING.md — OIDC trusted publishing from
#      release.yml; no tokens). Then replace VERSION in `url` with the published version and
#      the sha256 placeholder with the tarball digest:
#        curl -sL https://registry.npmjs.org/@getpharos/cli/-/cli-<version>.tgz | shasum -a 256
#   2. Create the tap repository github.com/Bobcatsfan33/homebrew-pharos and commit this file
#      as Formula/pharos.rb. Then `brew audit --strict --new pharos` and `brew test pharos`.
#      Users would install with:
#        brew tap bobcatsfan33/pharos && brew install pharos
#
# Until both are done this file is documentation of the intended formula, nothing more.
class Pharos < Formula
  desc "Real-time policy verdicts for AI agents with a signed, hash-chained evidence record"
  homepage "https://github.com/Bobcatsfan33/Pharos"
  url "https://registry.npmjs.org/@getpharos/cli/-/cli-VERSION.tgz"
  sha256 "REPLACE_WITH_SHA256_AFTER_FIRST_PUBLISH"
  license "Apache-2.0"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/pharos --version")
  end
end
