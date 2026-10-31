# offline-koordinater

POC för att hämta enhetens position och visa den igen efter en vanlig sidladdning, även när nätet är avstängt.

Sajten är statisk HTML, CSS och JavaScript utan byggsteg. Positionen läses i sidan. Service workern gör bara en sak: den gör själva filerna tillgängliga utan det publika internet.

## Köra

Service workers fungerar inte från `file://`. Starta en statisk server i repots rot:

```bash
python3 -m http.server 8080
```

Öppna `http://localhost:8080`. Första besöket måste nå värden så att cachen fylls. Därefter fungerar sidorna i en VPN-tunnel utan publikt internet, och med radiot avstängt.

## Tunnel utan publikt internet

Enheten kan ha wifi eller mobildata och ändå sakna det publika internet, för att trafiken går i en VPN-tunnel som inte släpper ut den. `navigator.onLine` är då sant: operativsystemet ser en länk. Anrop mot sajtens värd, och mot allt utanför tunneln, svart-hålas och hänger tills de får timeout.

Sidan startar därför inga egna nätanrop. Ingen värdprob, ingen API-adress, inget anrop som måste ut på internet för att statusraden ska kunna ritas. Det sidan kan veta utan att fråga nätet är två saker:

- **Länk** är bara gränssnittet. Uppe betyder wifi, mobilnät eller VPN-adapter, inte att internet fungerar och inte att värden svarar.
- **Offline-cache** är om workern styr sidan. Den kan vara aktiv både när länken är nere och när länken är uppe men värden inte svarar.

Workern svarar från precache utan att fråga nätet. En omladdning i tunneln väntar alltså inte på en värd som inte går att nå. Ett cache-miss (en fil som inte fanns i cachen) får högst fyra sekunder mot värden, sedan 503 eller den cachade sidan.

Första besöket måste fortfarande nå värden en gång, så att precachen fylls. Uppdateringar likaså: de tas in när `CACHE_NAME` byts och värden går att nå. Inne i tunneln används den uppsättning som redan är sparad.

En meta-`Content-Security-Policy` på båda sidorna låser skript, stil, bilder, typsnitt, worker och `connect-src` till den egna värden (`'self'`), plus `data:` för ikonen. Alpine bygger uttryck med `new Function`, därför står `'unsafe-eval'` med i `script-src`. Policyn stoppar sidkod från att hämta externa resurser. Den stoppar inte anrop som webbläsaren själv gör, se nedan.

### Det sidan inte kan stänga av

När sidan anropar Geolocation API skickar Chrome själv ett POST till `https://www.googleapis.com/geolocation/v1/geolocate`. Det är Chromes nätverkspositionering (wifi- och mastuppslag). Anropet görs av webbläsarprocessen, inte av sidans `fetch`, och det startar även när sidan ber om hög noggrannhet. Det finns inget webb-API för att be om enbart GPS, och en Content-Security-Policy når inte anropet.

På en telefon kan GPS-träffen ändå komma medan det anropet får timeout. På en dator utan GPS är det anropet Chromes enda källa, och hämtningen väntar och misslyckas. POC:n behöver Geolocation API för att läsa position, så anropet går inte att ta bort utan att ta bort positionen.

Webbläsaren kan också fråga efter en ny `sw.js` (uppdateringskoll mot samma värd) och köra egna bakgrundstjänster, till exempel Safe Browsing. De hör inte till sidan och går inte att stänga av härifrån. Uppdateringskollen blockerar inte visningen: cachen svarar direkt.

## Prova

1. Första besöket sparar hela sajten. Statusraden ska visa att länken är uppe och att cachen är aktiv. Nätverksloggen från sidan ska inte innehålla `origin-probe` eller någon adress utanför värden.
2. Stäng av nätverket och ladda om. Länken är nere, cachen är aktiv, senaste position finns kvar.
3. Med wifi eller VPN uppe men värden oåtkomlig: länken är fortfarande uppe, cachen är aktiv, sidan och senaste position finns kvar. Sidan gör ingen värdprob som kan få timeout.
4. På Start: **Hämta position**, bekräfta, och vänta in GPS. En indikator visas medan positionen hämtas. Chrome kan då själv anropa `googleapis.com` (se ovan). Det anropet kommer från webbläsaren, inte från sidans skript.
5. Öppna **Om** med en vanlig sidladdning. Senaste position ligger kvar.
6. Reglaget **Polla position** läser positionen löpande. Byt sida eller flik: den synliga sidan tar över läsningen. Av stänger av pollningen.

## Varför uppdelningen ser ut så här

Webbläsaren exponerar inte Geolocation API i en service worker. Där finns inte heller `localStorage`, och en behörighetsfråga kan inte visas därifrån. Den tidigare workern försökte ändå äga hela flödet: avgöra om en hämtning fick starta, lagra koordinater i IndexedDB och utse vilken flik som skulle läsa GPS. Det blev en egen tillståndsmaskin för något workern inte kan utföra själv.

Det som är fördelaktigt med en service worker är att svara på navigering när värden inte går att nå, även om en länk är uppe. `localStorage` kan lagra siffror, men inte fånga ett dokumentbyte till `about.html`. Cache API anropat från sidan kan spara svar, men inte intercepta själva sidladdningen. Utan worker blir en omladdning i tunneln ett hängande anrop.

Andra worker-förmågor hjälper inte här:

- Background Sync och Periodic Background Sync kan inte läsa GPS, och den senare finns knappt utanför Chromium.
- Push har inget med en lokal position att göra.
- Ett bibliotek som Workbox skulle bara kapsla in en precache på ett tiotal rader, och POC:n ska inte ha ett byggsteg.
- Stale-while-revalidate kan uppdatera en fil i taget medan en annan ligger kvar. Sidan är ES-moduler. En blandning av gammal och ny kod går sönder tyst. Samma strategi skulle också öppna ett nätanrop per fil inne i tunneln, och ett svart hål kan lämna de anropen hängande. En versionsatt cache byts ut i ett svep när `CACHE_NAME` ändras, så HTML, JS och CSS hör ihop, och bara när värden faktiskt nås.

Därför är workern cache-first och inget mer. Allt som rör position, bekräftelse och om pollning är på ligger i dokumentet, där API:erna faktiskt finns.

## Delarna

### `sw.js`

Installerar en precache av varje fil sajten behöver, tar över direkt (`skipWaiting` + `clients.claim`) och svarar på GET från samma origin med cache först. Saknas filen väntar workern högst fyra sekunder på värden. Därefter får en navigering `index.html` eller den kända sidan, annars 503. Workern tar inte emot meddelanden, lagrar ingen position och släpper inte igenom en prob mot värden.

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

Själva läsningen är `getCurrentPosition` för ett engångsanrop och `watchPosition` medan pollning är på. Båda ber om hög noggrannhet, alltså GPS. Chrome startar ändå sin egen nätverkspositionering parallellt; det anropet går inte att stänga av från sidan (se avsnittet om tunneln). Träffen normaliseras (ändliga tal, lat inom ±90, long inom ±180) och skrivs till storen. Persist speglar den till `localStorage`.

En hängande engångshämtning som fortfarande är markerad efter 120 sekunder blir `timeout` vid nästa sidladdning. Pollning får fortsätta; den är tänkt att vara långlivad.

### En läsare åt gången

Flera flikar delar `localStorage`, men bara en ska anropa GPS. Den synliga sidan begär ett exklusivt Web Lock, `offline-koordinater-geo`. Låset släpps när sidan döljs, navigerar bort eller stänger av pollningen, och webbläsaren släpper det också om dokumentet försvinner. Nästa synliga sida tar över och läser `ok.polling` / `ok.acquireMode` för att veta om den ska fortsätta.

Persist lyssnar inte på andra flikar. `storage`-händelsen gör det, och den når bara de andra dokumenten. Där skrivs fältet in i storen så att en öppen Om-flik uppdateras medan Start läser GPS. Samma värde skrivs inte om, så flikarna studsar inte händelser mellan sig.

Web Locks kräver secure context, samma krav som geolocation och service workers. Saknas API:et läser sidan ändå, utan flik-lås.

### `js/offline-store.js`

`Alpine.store("offline")` håller två fält, och inget av dem kommer från ett nätanrop:

- `link` är `up` eller `down`, från `online` / `offline`. Det är bara om ett gränssnitt finns.
- `cache` är `installing` tills workern styr sidan, sedan `active`, eller `unavailable` om registreringen misslyckas.

Positionen väntar inte på workern och inte på att värden svarar. Cachen är en status, inte en grind för GPS. Storen anropar inte `fetch`.

### `js/components.js`

Komponenterna registreras med `Alpine.data` och används som `x-data="statusPlate"` och så vidare. De läser stores via `this.$store` och äger bara sitt eget DOM.

- `statusPlate` väljer statustext, spinner, koordinater, tidsstämpel, länk och cache. Prioritet: kontroll pågår, fel, hämtning, pollning, sparad position, tomt.
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
