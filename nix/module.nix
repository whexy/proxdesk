{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.proxdesk;
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    mkPackageOption
    types
    ;

  # A Nix path, or a string naming a store path, would put the secret in the
  # world-readable Nix store, so secret files are absolute paths given as strings.
  secretFile =
    types.addCheck types.str (
      path: lib.hasPrefix "/" path && !lib.hasPrefix "${builtins.storeDir}/" path
    )
    // {
      description = ''absolute path outside the Nix store, given as a string such as "/run/secrets/proxdesk" (a Nix path like ./secret would copy the secret into the world-readable store)'';
    };

  nullOr =
    type: description:
    mkOption {
      type = types.nullOr type;
      default = null;
      inherit description;
    };

  # Secret files are handed to the service through LoadCredential, so the
  # sources may stay readable by root only.
  credentials = lib.filterAttrs (_: path: path != null) {
    proxmox-token-secret = cfg.proxmox.tokenSecretFile;
    proxmox-ca = cfg.proxmox.caFile;
    slack-app-token = cfg.slack.appTokenFile;
    slack-bot-token = cfg.slack.botTokenFile;
    discord-bot-token = cfg.discord.botTokenFile;
    oidc-client-secret = cfg.oidc.clientSecretFile;
    bootstrap-admin-password = cfg.bootstrapAdmin.passwordFile;
  };
  credentialVariables = {
    proxmox-token-secret = "PROXMOX_TOKEN_SECRET_FILE";
    proxmox-ca = "PROXMOX_CA_FILE";
    slack-app-token = "SLACK_APP_TOKEN_FILE";
    slack-bot-token = "SLACK_BOT_TOKEN_FILE";
    discord-bot-token = "DISCORD_BOT_TOKEN_FILE";
    oidc-client-secret = "OIDC_CLIENT_SECRET_FILE";
    bootstrap-admin-password = "BOOTSTRAP_ADMIN_PASSWORD_FILE";
  };

  environment = lib.filterAttrs (_: value: value != null) (
    {
      NODE_ENV = "production";
      NEXT_TELEMETRY_DISABLED = "1";
      APP_ORIGIN = cfg.origin;
      APP_ADDITIONAL_ORIGINS =
        if cfg.additionalOrigins == [ ] then null else lib.concatStringsSep "," cfg.additionalOrigins;
      HOST = cfg.host;
      PORT = toString cfg.port;
      DATABASE_PATH = "${cfg.dataDir}/proxdesk.sqlite";
      PROXMOX_URL = cfg.proxmox.url;
      PROXMOX_TOKEN_ID = cfg.proxmox.tokenId;
      PROXMOX_FINGERPRINT = cfg.proxmox.fingerprint;
      SLACK_CHANNEL_ID =
        if cfg.slack.channelIds != [ ] then
          lib.concatStringsSep "," cfg.slack.channelIds
        else
          cfg.slack.channelId;
      DISCORD_CHANNEL_IDS =
        if cfg.discord.channelIds == [ ] then null else lib.concatStringsSep "," cfg.discord.channelIds;
      DISCORD_ALLOW_DMS = if cfg.discord.allowDMs then "true" else null;
      PROXDESK_EXTENSIONS =
        if cfg.extensions == [ ] then null else lib.concatStringsSep "," cfg.extensions;
      OIDC_ISSUER = cfg.oidc.issuer;
      OIDC_CLIENT_ID = cfg.oidc.clientId;
      BOOTSTRAP_ADMIN_EMAIL = cfg.bootstrapAdmin.email;
    }
    // cfg.settings
  );

  credentialEnvironment =
    directory:
    lib.mapAttrs' (
      name: _: lib.nameValuePair credentialVariables.${name} "${directory}/${name}"
    ) credentials;

  # Runs a command in a transient unit with the service's user, credentials,
  # and environment, so maintenance commands see exactly what the server sees.
  cli = pkgs.writeShellApplication {
    name = "proxdesk";
    runtimeInputs = [ config.systemd.package ];
    text = ''
      if [ "$(id -u)" -ne 0 ]; then
        echo "proxdesk: run as root, for example: sudo proxdesk $*" >&2
        exit 1
      fi
      unit="proxdesk-cli-$$"
      args=(
        --unit="$unit" --quiet --wait --collect --working-directory=${cfg.dataDir}
        --uid=${cfg.user} --gid=${cfg.group}
        --property=UMask=0077
        ${lib.concatMapStringsSep " " (
          name: "--property=LoadCredential=${name}:${lib.escapeShellArg credentials.${name}}"
        ) (lib.attrNames credentials)}
        ${lib.optionalString (
          cfg.environmentFile != null
        ) "--property=EnvironmentFile=${lib.escapeShellArg cfg.environmentFile}"}
        ${lib.concatStringsSep " " (
          lib.mapAttrsToList (name: value: "--setenv=${lib.escapeShellArg "${name}=${value}"}") environment
        )}
        ${lib.concatStringsSep " " (
          lib.mapAttrsToList (name: value: ''"--setenv=${name}=${value}"'') (
            credentialEnvironment "/run/credentials/$unit.service"
          )
        )}
      )
      if [ -t 0 ] && [ -t 1 ]; then args+=(--pty); else args+=(--pipe); fi
      exec systemd-run "''${args[@]}" -- ${lib.getExe cfg.package} "$@"
    '';
  };
in
{
  options.services.proxdesk = {
    enable = mkEnableOption "Proxdesk, a self-service portal for shared Proxmox VMs";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "proxdesk.packages.\${system}.default";
      description = "The Proxdesk package to run.";
    };

    origin = mkOption {
      type = types.str;
      example = "https://proxdesk.example.com";
      description = ''
        Primary browser-facing origin (APP_ORIGIN). Public origins must use
        HTTPS; private LAN and loopback addresses may use HTTP.
      '';
    };

    additionalOrigins = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Further browser origins that may use the portal (APP_ADDITIONAL_ORIGINS).";
    };

    host = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = "Address the HTTP server listens on. Use 0.0.0.0 to accept remote connections without a reverse proxy.";
    };

    port = mkOption {
      type = types.port;
      default = 3000;
      description = "HTTP listening port.";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open the listening port in the firewall.";
    };

    user = mkOption {
      type = types.str;
      default = "proxdesk";
      description = "User account the service runs as; created when left at the default.";
    };

    group = mkOption {
      type = types.str;
      default = "proxdesk";
      description = "Group the service runs as; created when left at the default.";
    };

    dataDir = mkOption {
      type = types.str;
      default = "/var/lib/proxdesk";
      description = ''
        Directory holding the database. Relative paths given to `proxdesk`
        commands resolve against it.
      '';
    };

    environmentFile = nullOr secretFile ''
      File of KEY=value lines loaded by systemd, for settings or secrets not
      covered by other options. It is read by systemd as root.
    '';

    proxmox = {
      url = nullOr types.str "Proxmox API base URL, such as https://pve.example.com:8006.";
      tokenId = nullOr types.str "Proxmox API token ID, such as proxdesk@pve!portal.";
      tokenSecretFile = nullOr secretFile "File containing the Proxmox API token secret.";
      caFile = nullOr types.path "PEM certificate authority that signed the Proxmox certificate.";
      fingerprint = nullOr types.str "SHA-256 fingerprint of the Proxmox certificate to pin.";
    };

    slack = {
      appTokenFile = nullOr secretFile "File containing the Slack app-level token (xapp-…).";
      botTokenFile = nullOr secretFile "File containing the Slack bot token (xoxb-…).";
      channelId = nullOr types.str "Slack channel ID, such as C0123456789.";
      channelIds = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = [
          "C0123ABCD45"
          "G0456EFGH78"
        ];
        description = "Slack channel IDs the bot answers in. Use this or channelId.";
      };
    };

    discord = {
      botTokenFile = nullOr secretFile "File containing the Discord bot token.";
      channelIds = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = [ "1234567890123456789" ];
        description = "Discord channel IDs the bot answers in; required with botTokenFile.";
      };
      allowDMs = mkOption {
        type = types.bool;
        default = false;
        description = "Whether the Discord bot also takes requests in direct messages.";
      };
    };

    extensions = mkOption {
      # Interpolating a path copies it to the store, so it is in the closure.
      type = types.listOf (types.coercedTo types.path (path: "${path}") types.str);
      default = [ ];
      example = lib.literalExpression ''[ ./proxdesk/uptime.mjs ]'';
      description = ''
        Extension modules loaded at start (PROXDESK_EXTENSIONS): absolute
        paths or package names. Extensions run inside the service with all
        of its privileges; list only code you trust.
      '';
    };

    oidc = {
      issuer = nullOr types.str "OpenID Connect issuer URL.";
      clientId = nullOr types.str "OpenID Connect client ID.";
      clientSecretFile = nullOr secretFile "File containing the OpenID Connect client secret.";
    };

    bootstrapAdmin = {
      email = nullOr types.str "Email of the administrator created on an empty database.";
      passwordFile = nullOr secretFile "File containing the initial administrator password.";
    };

    settings = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = {
        NODE_EXTRA_CA_CERTS = "/etc/ssl/proxmox-ca.pem";
      };
      description = "Additional environment variables for the service. These end up in the Nix store; keep secrets out.";
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.slack.channelId == null || cfg.slack.channelIds == [ ];
        message = "services.proxdesk: set slack.channelId or slack.channelIds, not both.";
      }
      {
        assertion =
          (cfg.discord.botTokenFile != null) == (cfg.discord.channelIds != [ ])
          && (cfg.discord.allowDMs -> cfg.discord.botTokenFile != null);
        message = "services.proxdesk: discord.channelIds and discord.allowDMs need discord.botTokenFile, which needs discord.channelIds.";
      }
      {
        assertion =
          lib.length (
            lib.filter (set: set) [
              (cfg.proxmox.caFile != null)
              (cfg.proxmox.fingerprint != null)
              (cfg.settings ? PROXMOX_CA_FILE)
              (cfg.settings ? PROXMOX_FINGERPRINT)
            ]
          ) <= 1;
        message = ''
          services.proxdesk: set at most one of proxmox.caFile and
          proxmox.fingerprint (including PROXMOX_CA_FILE or PROXMOX_FINGERPRINT
          in settings). Proxdesk refuses to start with both, because a pinned
          fingerprint skips CA validation.
        '';
      }
    ];

    users.users = mkIf (cfg.user == "proxdesk") {
      proxdesk = {
        isSystemUser = true;
        inherit (cfg) group;
        home = cfg.dataDir;
      };
    };
    users.groups = mkIf (cfg.group == "proxdesk") { proxdesk = { }; };

    environment.systemPackages = [ cli ];

    systemd.tmpfiles.settings.proxdesk = mkIf (cfg.dataDir != "/var/lib/proxdesk") {
      ${cfg.dataDir}.d = {
        inherit (cfg) user group;
        mode = "0700";
      };
    };

    networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [ cfg.port ];

    systemd.services.proxdesk = {
      description = "Proxdesk VM self-service portal";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      environment = environment // credentialEnvironment "%d";
      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        ExecStart = "${lib.getExe cfg.package} serve";
        EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;
        LoadCredential = lib.mapAttrsToList (name: path: "${name}:${path}") credentials;
        Restart = "on-failure";
        RestartSec = "5s";
        TimeoutStopSec = "15s";
        StateDirectory = "proxdesk";
        StateDirectoryMode = "0700";
        ReadWritePaths = mkIf (cfg.dataDir != "/var/lib/proxdesk") [ cfg.dataDir ];
        WorkingDirectory = cfg.dataDir;
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        RestrictNamespaces = true;
        RestrictSUIDSGID = true;
        RestrictRealtime = true;
        LockPersonality = true;
        CapabilityBoundingSet = "";
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
        SystemCallArchitectures = "native";
      };
    };
  };
}
