# Single sign-on

Single sign-on is optional. Without it, people sign in with the email and password an administrator gives them. With it, the sign-in page also offers your OpenID Connect provider, such as Keycloak, Authentik, or Google.

## Set it up

1. In your provider, register a client with the redirect URI `<APP_ORIGIN>/api/auth/callback`, such as `https://proxdesk.example.com/api/auth/callback`. The provider must include a verified email address in the ID token, with `email_verified: true`.
2. Set all three of `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` (or `OIDC_CLIENT_SECRET_FILE`), and restart Proxdesk. On NixOS, the options are `oidc.issuer`, `oidc.clientId`, and `oidc.clientSecretFile`.

Single sign-on always runs on `APP_ORIGIN`: started from an address in `APP_ADDITIONAL_ORIGINS`, it moves to `APP_ORIGIN` first.

## Accounts

The first single sign-on of a new email creates a disabled member. An administrator enables it under **Members** and grants VMs; it has none until then.

If an account with that email already exists, the sign-in links to it. From then on, the account is bound to the provider's subject identifier, not the email, and another identity with the same email is refused.
