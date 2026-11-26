{
  lib,
  buildNpmPackage,
  importNpmLock,
  nodejs_24,
  makeWrapper,
}:
let
  manifest = lib.importJSON ../package.json;
in
buildNpmPackage rec {
  pname = manifest.name;
  inherit (manifest) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../app
      ../bin
      ../deploy/nix
      ../lib
      ../types
      ../next.config.mjs
      ../next-env.d.ts
      ../package.json
      ../package-lock.json
      ../tsconfig.json
    ];
  };

  nodejs = nodejs_24;
  # Fetching from the lockfile's integrity hashes needs no separate hash, so
  # release version bumps and dependency updates do not break the build.
  npmDeps = importNpmLock { npmRoot = src; };
  inherit (importNpmLock) npmConfigHook;

  nativeBuildInputs = [ makeWrapper ];

  env.NEXT_TELEMETRY_DISABLED = "1";

  # The runtime is plain JavaScript once optional dependencies (prebuilt SWC
  # and sharp binaries, needed only by `next build`) are pruned, so the output
  # carries no native code besides Node itself.
  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --omit=optional --no-audit --no-fund
    rm -rf .next/cache .next/dev .next/types
    find node_modules -mindepth 1 -maxdepth 1 -type d -empty -delete

    app=$out/lib/proxdesk
    mkdir -p $app
    cp -r package.json package-lock.json next.config.mjs .next dist node_modules $app/

    makeWrapper ${lib.getExe nodejs_24} $out/bin/proxdesk \
      --add-flags $app/dist/proxdesk.js \
      --set-default NEXT_TELEMETRY_DISABLED 1

    install -Dm644 deploy/nix/proxdesk.service $out/share/proxdesk/proxdesk.service
    install -Dm755 deploy/nix/proxdesk $out/share/proxdesk/proxdesk-admin

    runHook postInstall
  '';

  meta = {
    description = "Self-service portal for shared Proxmox VMs";
    license = lib.licenses.asl20;
    mainProgram = "proxdesk";
    platforms = lib.platforms.linux;
  };
}
