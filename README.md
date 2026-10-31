# offline-koordinater

POC för att hämta enhetens position och visa den igen efter en vanlig sidladdning, även när nätet är avstängt.

Sajten är statisk HTML, CSS och JavaScript utan byggsteg. Positionen läses i sidan. Service workern gör bara en sak: den gör själva filerna tillgängliga offline.

## Köra

Service workers fungerar inte från `file://`. Starta en statisk server i repots rot:

```bash
python3 -m http.server 8080
```

Öppna `http://localhost:8080`. Första besöket måste ha nätverk så att cachen fylls. Därefter kan sidorna laddas om offline.

## Prova

1. Första besöket sparar hela sajten.
2. Stäng av nätverket och ladda om. Statusraden ska visa att nätet är offline och att cachen är aktiv.
3. På Start: **Hämta position**, bekräfta, och vänta in GPS. En indikator visas medan positionen hämtas.
4. Öppna **Om** med en vanlig sidladdning. Senaste position ligger kvar.
5. Reglaget **Polla position** läser positionen löpande. Byt sida eller flik: den synliga sidan tar över läsningen. Av stänger av pollningen.

## Varför uppdelningen ser ut så här

Webbläsaren exponerar inte Geolocation API i en service worker. Där finns inte heller `localStorage`, och en behörighetsfråga kan inte visas därifrån. Den tidigare workern försökte ändå äga hela flödet: avgöra om en hämtning fick starta, lagra koordinater i IndexedDB och utse vilken flik som skulle läsa GPS. Det blev en egen tillståndsmaskin för något workern inte kan utföra själv.

Det som är fördelaktigt med en service worker är ett annat problem: att svara på navigering när nätet är borta. `localStorage` kan lagra siffror, men inte fånga ett dokumentbyte till `about.html`. Cache API anropat från sidan kan spara svar, men inte intercepta själva sidladdningen. Utan worker blir en omladdning offline ett nätverksfel.

Andra worker-förmågor hjälper inte här:

- Background Sync och Periodic Background Sync kan inte läsa GPS, och den senare finns knappt utanför Chromium.
- Push har inget med en lokal position att göra.
- Ett bibliotek som Workbox skulle bara kapsla in en precache på ett tiotal rader, och POC:n ska inte ha ett byggsteg.
- Stale-while-revalidate kan uppdatera en fil i taget medan en annan ligger kvar. Sidan är ES-moduler. En blandning av gammal och ny kod går sönder tyst. En versionsatt cache byts ut i ett svep när `CACHE_NAME` ändras, så HTML, JS och CSS hör ihop.

Därför är workern cache-first och inget mer. Allt som rör position, bekräftelse och om pollning är på ligger i dokumentet, där API:erna faktiskt finns.

## Delarna

### `sw.js`

Installerar en precache av varje fil sajten behöver, tar över direkt (`skipWaiting` + `clients.claim`) och svarar på GET från samma origin med cache först. Saknas filen och nätet är nere får en navigering `index.html` eller den kända sidan, annars 503. Workern tar inte emot meddelanden och lagrar ingen position.

När en fil läggs till, byter namn eller tas bort ska sökvägen in i `PRECACHE_URLS` och `CACHE_NAME` räknas upp i samma ändring. Det är så den gamla uppsättningen släpps.

### `js/app.js`

Startar Alpine. Persist-pluginet registreras före stores, annars finns inte `Alpine.$persist`. Därefter registreras stores och komponenter, och `Alpine.start()` kopplar dem till DOM.

`ui`-storen håller bara vilken bekräftelsedialog som är öppen (`oneshot` eller `poll`). Den sparas inte. En omladdning ska inte öppna dialogen igen.

### `js/geo-store.js`

Global position, via `Alpine.store("geo")`. Fälten som ska överleva en sidladdning är inlindade i `Alpine.$persist(...).as("ok.…")`. Persist skriver dem till `localStorage` som JSON. Alpine läser tillbaka dem innan komponenterna ritas, så Om-sidan visar senaste träff direkt.

| Nyckel | Innehåll |
| --- | --- |
| `ok.longitude`, `ok.latitude` | Senaste godkända koordinater |
| `ok.updatedAt` | Tidsstämpel från GPS-träffen, i millisekunder |
| `ok.polling` | Om löpande läsning är på |
| `ok.acquiring` | Om en hämtning pågår och ännu inte fått träff eller fel |
| `ok.acquiringSince` | När den pågående hämtningen började |
| `ok.acquireMode` | `oneshot`, `poll` eller `null` |
| `ok.error` | `denied`, `unavailable`, `timeout`, `unsupported`, `insecure` eller `null` |

`checking` och `immediate` ligger på storen men är inte persistade. De beskriver bara den sida som just nu frågar.

Innan en hämtning startar avgör sidan själv, inte workern:

- finns `navigator.geolocation`
- är sammanhanget secure (`localhost` eller https)
- är behörigheten redan `denied`, om Permissions API svarar

Saknas Permissions API, eller kastar det (Firefox gör det ibland för geolocation), får anropet gå vidare. Då visar webbläsaren sin egen fråga. Nekad, saknad eller osäker position räknas som ett stoppande fel och slår av pollning.

Själva läsningen är `getCurrentPosition` för ett engångsanrop och `watchPosition` medan pollning är på. Träffen normaliseras (ändliga tal, lat inom ±90, long inom ±180) och skrivs till storen. Persist speglar den till `localStorage`.

En hängande engångshämtning som fortfarande är markerad efter 120 sekunder blir `timeout` vid nästa sidladdning. Pollning får fortsätta; den är tänkt att vara långlivad.

### En läsare åt gången

Flera flikar delar `localStorage`, men bara en ska anropa GPS. Den synliga sidan begär ett exklusivt Web Lock, `offline-koordinater-geo`. Låset släpps när sidan döljs, navigerar bort eller stänger av pollningen, och webbläsaren släpper det också om dokumentet försvinner. Nästa synliga sida tar över och läser `ok.polling` / `ok.acquireMode` för att veta om den ska fortsätta.

Persist lyssnar inte på andra flikar. `storage`-händelsen gör det, och den når bara de andra dokumenten. Där skrivs fältet in i storen så att en öppen Om-flik uppdateras medan Start läser GPS. Samma värde skrivs inte om, så flikarna studsar inte händelser mellan sig.

Web Locks kräver secure context, samma krav som geolocation och service workers. Saknas API:et läser sidan ändå, utan flik-lås.

### `js/offline-store.js`

`Alpine.store("offline")` håller `online` (från `online` / `offline`) och `cache`:

- `installing` medan workern registreras och ännu inte styr sidan
- `active` när `navigator.serviceWorker.controller` finns
- `unavailable` om workern saknas eller registreringen misslyckas

Positionen väntar inte på workern. Offline-cachen är en status, inte en grind för GPS.

### `js/components.js`

Komponenterna registreras med `Alpine.data` och används som `x-data="statusPlate"` och så vidare. De läser stores via `this.$store` och äger bara sitt eget DOM.

- `statusPlate` väljer statustext, spinner, koordinater, tidsstämpel, nät och cache. Prioritet: kontroll pågår, fel, hämtning, pollning, sparad position, tomt.
- `fetchPosition` öppnar bekräftelsen. Är pollning redan på räcker det medgivandet, och knappen ber om en färsk träff direkt.
- `pollSwitch` speglar `polling` till reglaget. På öppnar dialogen utan att slå på reglaget först. Av anropar `stopPolling()`.
- `confirmDialog` öppnar den inbyggda `<dialog>` när `ui.mode` sätts, och stänger den på Avbryt, Tillåt eller Escape.

### `vendor/`

Alpine.js 3.17.5 och `@alpinejs/persist` 3.17.5, som ES-moduler. Alpine-filen innehåller även `@vue/reactivity`, som Alpine använder internt. Båda är MIT. De importeras med relativa sökvägar så att workern kan cacha dem. Ingen CDN-träff sker i runtime.

### `css/app.css`

Utseende, lägen på statusplattan (`acquiring`, `polling`, `error`) och `[x-cloak]` så att sparad position inte blinkar förbi som tom innan Alpine hunnit läsa `localStorage`.

## Flöde

```text
bekräftelse i sidan
        │
        ▼
geo-store avgör om enheten kan läsa position
        │
        ├─ nej → fel sparas i localStorage, båda sidorna visar det
        │
        └─ ja → synlig sida tar Web Lock och anropar Geolocation
                    │
                    ▼
              träff eller fel skrivs med Alpine.$persist
                    │
                    ▼
              nästa dokument läser samma nycklar vid start
              dolda flikar får storage-händelsen

sw.js ligger vid sidan av det här och svarar bara på filhämtning
```
