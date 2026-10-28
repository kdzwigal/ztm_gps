# AI generated code and README
# Warszawski transport na żywo

Mapa pokazuje pozycje autobusów i tramwajów pobierane z [Otwarte Dane Warszawa](https://dane.um.warszawa.pl/pl/catalogue/f319f602-7292-4e8c-b3d1-f5898aa9a638). Katalog dokumentuje autobusy (`type: 1`) i tramwaje (`type: 2`); nie udostępnia w tej karcie lokalizacji SKM ani metra. Pojazdy są widoczne tylko wtedy, gdy znajdują się w aktualnym obszarze mapy. Lokalizacja użytkownika jest pobierana po wybraniu przycisku „Moja lokalizacja”.

## Uruchomienie lokalne

Wymagany jest Node.js 20 lub nowszy oraz klucz API Otwarte Dane Warszawa.

```sh
ZTM_API_KEY=twoj_klucz npm start
```

Otwórz `http://localhost:10000`. Nie zapisuj klucza w kodzie ani w repozytorium; lokalny `apiKey.txt` jest ignorowany przez Git.

## Wdrożenie na Render

1. Wypchnij repozytorium do GitHub, w Render wybierz **New > Web Service** i połącz repozytorium.
2. Wybierz środowisko **Node**, ustaw **Build Command** na `npm ci`, a **Start Command** na `npm start`.
3. Dodaj `ZTM_API_KEY` w sekcji **Environment** usługi jako sekret. Wklej tam klucz API; nie zapisuj go w plikach projektu ani repozytorium.
4. Utwórz usługę. Render wykryje port z `PORT`; strona główna `/` jest dostępna jako ścieżka kontroli zdrowia.

Klucz jest używany wyłącznie przez backend i nie jest wysyłany do przeglądarki. Backend pobiera dane autobusów i tramwajów z częstotliwością nie większą niż raz na 10 sekund i udostępnia je stronie przez `/api/vehicles`. Lokalizacja przeglądarki działa na HTTPS (Render zapewnia HTTPS) lub na `localhost`.

Mapa korzysta z kafelków OpenStreetMap oraz biblioteki Leaflet ładowanej z CDN; do poprawnego wyświetlania mapy przeglądarka musi mieć dostęp do tych usług.

> Uwaga: endpoint ZTM może okresowo zwracać `500 Service unavailable`. W takim przypadku wdrożenie i mapa nadal działają, ale API nie dostarcza bieżących pozycji pojazdów.

Mapa wyświetla również przystanki z katalogu [Lokalizacja przystanków komunikacji miejskiej](https://dane.um.warszawa.pl/pl/catalogue/009fce84-0024-431a-aa5e-9515c539899e). Kliknij znacznik przystanku, aby pobrać listę linii z katalogu [Linie dostępne na przystanku](https://dane.um.warszawa.pl/pl/catalogue/dedad7b7-85f4-4be9-b73e-8395cefb434c); linie są pobierane na żądanie i buforowane na serwerze przez godzinę. Pełna lista przystanków jest odświeżana co 6 godzin. Przycisk „Przystanki” pozwala ukryć lub ponownie pokazać ich znaczniki.

`render.yaml` zawiera równoważną konfigurację dla osób, które później zechcą utworzyć usługę przez Blueprint.
