# Security

## Reporting a vulnerability

Please don't open a public issue for security problems. Use GitHub's private
vulnerability reporting (the **Security** tab → **Report a vulnerability**) instead.
You'll get an answer as soon as possible; please give a reasonable time to fix before
disclosing.

## Running a public instance

EST2 calls paid AI APIs. On a server reachable from the internet:

- **Set `BYOK_REQUIRED=true`** unless you intend to pay for every visitor. Then players
  must bring their own keys (API KEYS dialog) and server keys are not used for their traffic.
- **Set `SESSIONS_ACCESS_KEY`** to a long random value. It protects the cloud-session
  endpoints (`/api/sessions*`).
- **Put HTTPS in front.** Player keys travel in `x-byok-*` request headers. Coolify does this
  through Traefik; without Coolify use a reverse proxy (Caddy, nginx, Traefik).
- **Keep secrets out of git.** `.env*` files are git-ignored; configure keys in the host
  environment or a local `.env`, never in committed files.
- **Use a strong `POSTGRES_PASSWORD`** (e.g. `openssl rand -hex 24`); the bundled database is
  not published on the host.

## How player keys are handled

Keys entered in the browser are stored in that browser's `localStorage` and sent with each
request. The backend (`backend/byok.js`) uses a key only within the request that carried it,
never stores it, and does not write it to logs.
