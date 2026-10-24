<p align="right">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<picture>
  <source media="(max-width: 600px)" srcset="docs/brand/readme-header-compact.svg">
  <img src="docs/brand/readme-header.svg" alt="Aivory — Self-hosted AI workspace" width="100%">
</picture>

# Aivory

Aivory is a self-hosted AI workspace for multi-model chat, knowledge search, tool-assisted work, and team collaboration. It provides personal and team deployments, with data stored on infrastructure you control.

[Deployment guide](deploy/README.md) · [Product documentation](https://docs.aivorygo.com) · [Live demo](https://demo.aivorygo.com)

## Deploy

Deploy with Docker 24 or later and the Docker Compose plugin. Choose the personal profile for a single-user server with SQLite, or the full profile for PostgreSQL, Redis, Qdrant, and the bundled Python sandbox.

### Full deployment

```bash
git clone https://github.com/hjxwz123/Aivory.git
cd Aivory/deploy
cp .env.example .env
```

Edit `.env` and set strong values for `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, and `JWT_SECRET`. For a domain or HTTPS reverse proxy, also set `ALLOWED_ORIGINS` to the exact site origin, for example `https://chat.example.com`.

```bash
docker compose --env-file .env -f docker-compose.prod.yml pull
docker compose --env-file .env -f docker-compose.prod.yml up -d
```

Open the server address. The first account created through the setup page becomes the administrator. Add model provider credentials in **Admin → Channels**.

### Personal deployment

```bash
git clone https://github.com/hjxwz123/Aivory.git
cd Aivory/deploy
cp .env.personal.example .env.personal
```

Set `JWT_SECRET` in `.env.personal` and set `ALLOWED_ORIGINS` when using a domain or HTTPS reverse proxy.

```bash
docker compose --env-file .env.personal -f docker-compose.personal.yml pull
docker compose --env-file .env.personal -f docker-compose.personal.yml up -d
```

The personal profile uses a single SQLite database and is intended for one app instance. Its persistent data is stored under `DATA_DIR` (default `deploy/data-personal`).

### Upgrade and restore

To deploy a specific release, set `IMAGE_TAG` in the active environment file to the release version without the leading `v`. If `APP_IMAGE_TAG` or `SANDBOX_IMAGE_TAG` is set, update it to the same version. Keep existing volumes and `DATA_DIR` in place.

```bash
# Full deployment
docker compose --env-file .env -f docker-compose.prod.yml pull
docker compose --env-file .env -f docker-compose.prod.yml up -d --no-build

# Personal deployment
docker compose --env-file .env.personal -f docker-compose.personal.yml pull
docker compose --env-file .env.personal -f docker-compose.personal.yml up -d --no-build
```

For a full backup restore, place the ZIP in `BACKUP_DIR`. The default host path is `deploy/data/backups` for the full profile and `deploy/data-personal/backups` for the personal profile. Open **Admin → Backup & Migration**, select **Restore from server directory**, and type `REPLACE`. Restore replaces all current data; keep a separate copy of the archive and back up the destination first.

For version-specific deployment, proxy configuration, storage paths, and recovery procedures, see the [deployment guide](deploy/README.md).

## Contributing

For substantial changes, open an issue before starting work. Pull requests should describe the user-facing change and include relevant tests. Run checks for the areas you changed; for example:

```bash
npm run lint
npm run build
cd server && go test ./... && go vet ./...
```

## Acknowledgements

Thanks to the open-source communities and contributors behind [Qdrant](https://qdrant.tech/), [Radix UI](https://www.radix-ui.com/), and the projects and people who help improve Aivory.

## License

[Apache License 2.0](./LICENSE).
