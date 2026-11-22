# cloudron-deployer

Lokalna aplikacja (tylko LAN) do wdrażania obrazów z ghcr.io na serwery Cloudron.
Stan: etap 4 (logowanie, ustawienia, repozytoria i tagi, wdrożenie przez Cloudron CLI z logiem na żywo, historia).

## Uruchomienie lokalnie

    APP_SECRET=zmien-mnie-na-dlugi-losowy-tekst ADMIN_PASSWORD=zmien-mnie npm start

Adres: http://localhost:3000, login `admin`.

## Docker Compose (zalecane)

    cp .env.example .env      # uzupelnij APP_SECRET i ADMIN_PASSWORD
    docker compose up -d

Obraz (`ghcr.io/gadziunet/cloudron-deployer`) buduje GitHub Actions: tag `edge` to ostatni commit z `main`,
tagi `vX.Y.Z` daja wersje `X.Y.Z`, `X.Y` i `latest`. Jesli pobieranie obrazu zwroci "denied", ustaw pakiet
jako publiczny (GitHub: Packages -> cloudron-deployer -> Package settings) albo zaloguj sie `docker login ghcr.io`.

Adres: http://adres-maszyny:3000. Dane (baza) sa w wolumenie `cloudron-deployer-data`.
Kontener dziala jako uzytkownik `node` (uid 1000), wiec katalog z danymi musi nalezec do uid 1000.

Budowanie lokalnie zamiast pobierania: `docker build -t cloudron-deployer .` i w compose zamien `image:` na `cloudron-deployer`.

## Docker (bez Compose)

    docker build -t cloudron-deployer .
    docker run -d --restart unless-stopped -p 3000:3000 \
      -e APP_SECRET=zmien-mnie-na-dlugi-losowy-tekst \
      -e ADMIN_PASSWORD=zmien-mnie \
      -v cloudron-deployer-data:/data cloudron-deployer

`APP_SECRET` szyfruje tokeny w bazie. Jego zmiana unieważnia zapisane tokeny.
`ADMIN_PASSWORD` działa tylko przy pierwszym starcie; potem hasło zmienia się w aplikacji.

## Aktualizacja i instalacja

Przycisk "Wdroz" robi `cloudron update` istniejacej aplikacji (jej domena musi byc na serwerze).
Przycisk "Zainstaluj nowa" robi `cloudron install` pod wpisana pelna domena, gdy aplikacji jeszcze nie ma.
Przed instalacja aplikacja sprawdza, czy domena pasuje do domen skonfigurowanych w Cloudronie.

## Wiele serwerow

Kazdy serwer Cloudron ma w ustawieniach rodzaj (testowy lub produkcyjny). Na stronie repozytorium wybierasz
konkretny serwer z listy, a domena aplikacji jest zapamietywana osobno dla kazdej pary repozytorium i serwer.
Przy serwerze produkcyjnym aplikacja pyta o potwierdzenie przed wdrozeniem.

## Rejestr ghcr.io na serwerach Cloudron

Po zapisaniu tokenu GitHub, po dodaniu serwera i po zmianie nazwy uzytkownika ghcr.io aplikacja dodaje
(albo aktualizuje) wpis `ghcr.io` w Cloudronie (Docker -> rejestry), uzywajac tokenu GitHub i nazwy
uzytkownika z ustawien. Inne rejestry zostaja nietkniete. Przycisk "Zsynchronizuj ghcr.io na serwerach"
robi to recznie. Token musi miec uprawnienie `read:packages`.

## Testy

    npm test
