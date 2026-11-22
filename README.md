# cloudron-deployer

Lokalna aplikacja (tylko LAN) do wdrażania obrazów z ghcr.io na serwery Cloudron.
Stan: etap 4 (logowanie, ustawienia, repozytoria i tagi, wdrożenie przez Cloudron CLI z logiem na żywo, historia).

## Uruchomienie lokalnie

    APP_SECRET=zmien-mnie-na-dlugi-losowy-tekst ADMIN_PASSWORD=zmien-mnie npm start

Adres: http://localhost:3000, login `admin`.

## Docker Compose (zalecane)

    cp .env.example .env      # uzupelnij APP_SECRET i ADMIN_PASSWORD
    docker compose up -d --build

Adres: http://adres-maszyny:3000. Dane (baza) sa w wolumenie `cloudron-deployer-data`.

## Docker (bez Compose)

    docker build -t cloudron-deployer .
    docker run -d --restart unless-stopped -p 3000:3000 \
      -e APP_SECRET=zmien-mnie-na-dlugi-losowy-tekst \
      -e ADMIN_PASSWORD=zmien-mnie \
      -v cloudron-deployer-data:/data cloudron-deployer

`APP_SECRET` szyfruje tokeny w bazie. Jego zmiana unieważnia zapisane tokeny.
`ADMIN_PASSWORD` działa tylko przy pierwszym starcie; potem hasło zmienia się w aplikacji.

## Testy

    npm test
