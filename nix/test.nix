{ self }:
{ pkgs, lib, ... }:
let
  common = {
    imports = [ self.nixosModules.default ];
    services.proxdesk = {
      enable = true;
      origin = "http://127.0.0.1:3000";
      # TEST-NET-1 is unroutable: the portal must start and serve without
      # reaching Proxmox.
      proxmox = {
        url = "https://192.0.2.1:8006";
        tokenId = "proxdesk@pve!portal";
        tokenSecretFile = "/etc/proxdesk/proxmox-token-secret";
      };
      bootstrapAdmin = {
        email = "admin@example.com";
        passwordFile = "/etc/proxdesk/bootstrap-password";
      };
    };
    # Copied into /etc at activation rather than linked to the store, as
    # secrets placed by hand or by a secrets manager would be.
    environment.etc = secrets {
      proxmox-token-secret = "00000000-0000-0000-0000-000000000000";
      bootstrap-password = "correct-horse-battery";
    };
  };
  secrets = lib.mapAttrs' (
    name: text:
    lib.nameValuePair "proxdesk/${name}" {
      text = "${text}\n";
      mode = "0400";
    }
  );
  fingerprint = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";
in
{
  name = "proxdesk";

  nodes.machine = {
    imports = [ common ];
    environment.systemPackages = [ pkgs.curl ];
    services.proxdesk.proxmox.caFile = "${pkgs.path}/nixos/tests/common/acme/server/ca.cert.pem";
  };

  # Also configures the chat bots, which cannot connect here, and an
  # extension, to check the variables the module emits for them.
  nodes.pinned = {
    imports = [ common ];
    services.proxdesk = {
      proxmox.fingerprint = fingerprint;
      slack = {
        appTokenFile = "/etc/proxdesk/slack-app-token";
        botTokenFile = "/etc/proxdesk/slack-bot-token";
        channelIds = [
          "C0123ABCD45"
          "G0456EFGH78"
        ];
      };
      discord = {
        botTokenFile = "/etc/proxdesk/discord-bot-token";
        channelIds = [ "123456789012345678" ];
        allowDMs = true;
      };
      extensions = [ ../examples/extensions/uptime.mjs ];
    };
    environment.etc = secrets {
      slack-app-token = "xapp-1-test";
      slack-bot-token = "xoxb-test";
      discord-bot-token = "MTIz.NDU2.Nzg5";
    };
  };

  testScript = ''
    import json

    def doctor(node, trust, failures=1):
        # Proxmox is unreachable, so doctor passes the configuration checks,
        # reports the failed connection, and exits 1.
        status, report = node.execute("timeout 60 proxdesk doctor")
        print(report)
        assert status == 1, (status, report)
        assert "ok    Configuration valid for http://127.0.0.1:3000" in report, report
        assert f"ok    Proxmox TLS trust: {trust}" in report, report
        assert "FAIL  Proxmox at https://192.0.2.1:8006" in report, report
        summary = "1 check failed" if failures == 1 else f"{failures} checks failed"
        assert summary in report, report

    start_all()
    machine.wait_for_unit("proxdesk.service")
    machine.wait_for_open_port(3000)

    session = json.loads(machine.succeed("curl -sf http://127.0.0.1:3000/api/auth/session"))
    assert session["user"] is None and session["demo"] is False, session

    login = json.loads(machine.succeed(
        "curl -sf -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:3000' "
        "-d '{\"email\":\"admin@example.com\",\"password\":\"correct-horse-battery\"}' "
        "http://127.0.0.1:3000/api/auth/login"
    ))
    assert login["user"]["role"] == "admin", login

    env = machine.succeed("systemctl show -p Environment --value proxdesk.service")
    for variable, credential in [
        ("PROXMOX_CA_FILE", "proxmox-ca"),
        ("PROXMOX_TOKEN_SECRET_FILE", "proxmox-token-secret"),
        ("BOOTSTRAP_ADMIN_PASSWORD_FILE", "bootstrap-admin-password"),
    ]:
        assert f"{variable}=/run/credentials/proxdesk.service/{credential}" in env, env
    assert "PROXMOX_FINGERPRINT" not in env, env

    doctor(machine, "CA file /run/credentials/proxdesk-cli-")

    machine.succeed("proxdesk version")
    machine.succeed("proxdesk backup backup.sqlite")
    owner = machine.succeed("stat -c '%U %a' /var/lib/proxdesk/backup.sqlite").strip()
    assert owner == "proxdesk 600", owner
    machine.fail("proxdesk restore backup.sqlite")
    machine.fail("su -s /bin/sh nobody -c 'proxdesk version'")

    pinned.wait_for_unit("proxdesk.service")
    pinned.wait_for_open_port(3000)
    env = pinned.succeed("systemctl show -p Environment --value proxdesk.service")
    assert "PROXMOX_FINGERPRINT=${fingerprint}" in env and "PROXMOX_CA_FILE" not in env, env
    for variable in [
        "SLACK_CHANNEL_ID=C0123ABCD45,G0456EFGH78",
        "DISCORD_CHANNEL_IDS=123456789012345678",
        "DISCORD_ALLOW_DMS=true",
        "PROXDESK_EXTENSIONS=/nix/store/",
        "SLACK_APP_TOKEN_FILE=/run/credentials/proxdesk.service/slack-app-token",
        "SLACK_BOT_TOKEN_FILE=/run/credentials/proxdesk.service/slack-bot-token",
        "DISCORD_BOT_TOKEN_FILE=/run/credentials/proxdesk.service/discord-bot-token",
    ]:
        assert variable in env, (variable, env)
    pinned.wait_until_succeeds("journalctl -u proxdesk.service | grep -q 'registered the uptime command'")
    # Proxmox, Slack, and Discord are all unreachable.
    doctor(pinned, "pinned certificate fingerprint ${fingerprint}", failures=3)
  '';
}
