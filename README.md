# offline-koordinater

Positionen är en modul som kan köras i bakgrunden på varje sida. Den registrerar `Alpine.store("geo")` med Alpine Persist, så andra Alpine-komponenter läser samma läge via `$store.geo`. Reglagen är Alpine-komponenter och ligger bara där de ska synas, till exempel på en flik under Min sida. POC:n i den här repan är en statisk sajt som använder modulen så, och dessutom en service worker så att sidorna finns kvar utan publikt internet. Modulen själv registrerar ingen worker och anropar inget nät. Den tar inte med en egen Alpine. Sidan som använder den har redan Alpine och `@alpinejs/persist`.

## Använda modulen i Vite

Kopiera in `js/coordinates/`. Vite buntar ES-modulerna som de är. Använd Alpine och persist från projektet, inte från `vendor/` i den här repan. `vendor/` finns bara så att POC:n kan köras utan byggsteg. Ingenting av `sw.js` eller `js/offline-status.js` ska med om sajten redan har nät.

### Layouten, på varje sida

Anropa `startCoordinates()` en gång per sidladdning, i den gemensamma layouten, efter `Alpine.plugin(persist)` och före `Alpine.start()`. Det registrerar storen, lagringen och flik-låset. Är pollning redan på fortsätter GPS-läsningen. Sidan behöver inga knappar för det.

```js
import Alpine from "alpinejs";
import persist from "@alpinejs/persist";
import { startCoordinates } from "./coordinates/index.js";
import "./coordinates/panel.css";

window.Alpine = Alpine;
Alpine.plugin(persist);

startCoordinates({
  requestAccessOnLoad: true,
});

Alpine.start();
```

`window.Alpine = Alpine` gör samma instans tillgänglig för sidans övriga komponenter. `startCoordinates` använder `window.Alpine` om du inte skickar in instansen som `Alpine`. CSS-filen behövs bara om någon sida ritar panelen eller avläsningen. Importen av JavaScript är ofarlig under SSR. Anropa `startCoordinates` i webbläsaren. Anropas den ändå utan `window` gör den ingenting och rör inte `localStorage`.

`requestAccessOnLoad` frågar efter tillgång vid den här sidladdningen när sammanhanget tillåter det:

| Sammanhang | Vad som händer |
| --- | --- |
| Inget Geolocation API, sidan är inte `localhost` eller https, eller Permissions Policy spärrar `geolocation` | Inget anrop. Felet sparas och syns i panelen. |
| Tillståndet är redan nekat | Inget nytt anrop. Felet sparas. |
| Tillståndet är redan givet och en träff finns | Ingen ny GPS-läsning. Pollning som redan är på fortsätter ändå. |
| Tillståndet är givet men ingen användbar träff finns | En träff läses, även i Safari, utan att en fråga visas. |
| Frågan är inte avgjord, Chrome eller Firefox | Webbläsaren kan visa sin egen fråga utan ett klick. |
| Frågan är inte avgjord, Safari eller någon webbläsare på iPhone eller iPad | Ingenting. De visar platsfrågan bara i samma tryck som ett klick. Reglagen är vägen dit. |
| Pollning eller en hämtning pågår redan | Den lämnas ifred. |

Optionen är av som standard. POC:n slår på den om `<html>` har `data-request-access="true"`, eller om adressen har `?request-access`.

En väntande fråga ställs igen vid nästa sidladdning, tills webbläsaren har ett ja eller nej. Det är meningen när optionen är på på varje sida.

### Reglage på en sida

Lägg markupen bara i vyn där reglagen ska ligga, till exempel fliken Min sida. Storen fortsätter på de andra sidorna. Komponenten `coordinatesStatus` visar läget, `coordinatesControls` har knappen och reglaget, och `coordinatesConfirm` är bekräftelsedialogen.

```html
<section class="coordinates" x-data="coordinatesStatus" x-cloak
  x-bind:data-phase="view.phase" aria-label="Enhetens position">
  <p class="coordinates-status" aria-live="polite">
    <span class="coordinates-spinner" x-bind:hidden="!view.busy"></span>
    <span x-text="view.statusText"></span>
  </p>
  <dl class="coordinates-readout">
    <div>
      <dt>Position (long, lat)</dt>
      <dd x-text="view.positionText"></dd>
    </div>
    <div>
      <dt>Senast uppdaterad</dt>
      <dd x-text="view.updatedText"></dd>
    </div>
  </dl>
  <div class="coordinates-controls" x-data="coordinatesControls">
    <button type="button" x-on:click="ask()">Hämta position</button>
    <label class="coordinates-switch">
      <input type="checkbox" role="switch" x-ref="input" x-on:change="onChange($event)">
      <span>Polla position</span>
    </label>
  </div>
  <dialog class="coordinates-dialog" x-data="coordinatesConfirm">
    <p x-text="text"></p>
    <button type="button" x-on:click="cancel()">Avbryt</button>
    <button type="button" x-on:click="allow()">Tillåt</button>
  </dialog>
</section>
```

Tillåt anropar `$store.geo.request()` i samma tur som klicket. En `await` före det anropet gör att Safari inte visar platsfrågan.

### Bara visa läget

Utan `coordinatesControls` och `coordinatesConfirm` blir samma `coordinatesStatus` en avläsning. POC:ns sida Annan sida är det här. Vilken annan komponent som helst kan också läsa storen:

```html
<p x-text="$store.geo.latitude"></p>
<button type="button" x-on:click="$store.geo.refreshNow()">Hämta nu</button>
```

`request`, `refreshNow` och `stopPolling` sitter på `$store.geo`. `request("oneshot")` och `request("poll")` måste anropas synkront i klickhanteraren.

`$store.geo.error` är `denied`, `blocked`, `unavailable`, `timeout`, `unsupported`, `insecure`, `policy` eller `null`.

### Lagring

Alpine Persist skriver fälten. Nycklarna är samma som tidigare, så en sparad träff finns kvar.

### Flikar

| Nyckel | Innehåll |
| --- | --- |
| `ok.longitude`, `ok.latitude` | Senaste godkända koordinater |
| `ok.updatedAt` | Tidsstämpel från GPS-träffen, i millisekunder |
| `ok.polling` | Om löpande läsning är på |
| `ok.acquiring` | Om en hämtning pågår |
| `ok.acquiringSince` | När den pågående hämtningen började |
| `ok.acquireMode` | `oneshot`, `poll` eller `null` |
| `ok.error` | Felkoden ovan, eller `null` |

Prefixet `ok` är standard så att en tidigare träff i den här POC:n fortfarande läses. Byt det om nycklarna kan krocka:

```js
startCoordinates({
  requestAccessOnLoad: true,
  storagePrefix: "myapp-geo",
});
```

Flera flikar delar `localStorage`, men bara en anropar GPS. Den synliga sidan tar ett exklusivt Web Lock, `offline-koordinater-geo`. Låset släpps när sidan döljs, navigerar bort eller stänger av pollningen. Webbläsaren släpper det också om dokumentet försvinner. Nästa synliga sida läser `polling` och `acquireMode` och fortsätter. Saknas Web Locks läser sidan ändå, utan flik-lås.

`storagePrefix` och `lockName` kan bara sättas av det första anropet i dokumentet. Ett senare anrop med `requestAccessOnLoad: true` frågar ändå, en gång, om det första inte gjorde det.

## Köra POC:n

Service workers fungerar inte från `file://`. Starta en statisk server i repots rot:

```bash
python3 -m http.server 8080
```

Öppna `http://localhost:8080`. `js/app.js` är layouten: båda sidorna startar Alpine och `$store.geo`. Min sida har reglagen. Annan sida har bara avläsningen.

Första besöket måste nå värden så att cachen fylls. Därefter fungerar sidorna i en VPN-tunnel utan publikt internet, och med radiot avstängt.

## Tunnel utan publikt internet

Enheten kan ha wifi eller mobildata och ändå sakna det publika internet, för att trafiken går i en VPN-tunnel som inte släpper ut den. `navigator.onLine` är då sant: operativsystemet ser en länk. Anrop mot sajtens värd kan svart-hålas och hänga länge i stället för att fallera direkt.

Därför skiljer statusraden i POC:n på tre saker. Den raden hör inte till modulen.

- **Länk** är bara gränssnittet. Uppe betyder wifi, mobilnät eller VPN-adapter, inte att internet fungerar.
- **Värd** är om den här sajtens server svarar. Sidan frågar med `?origin-probe=1`, workern rör inte den förfrågan, och den avbryts efter 2,5 sekunder. Svaret sparas inte.
- **Offline-cache** är om workern styr sidan. Den kan vara aktiv både när länken är nere och när länken är uppe men värden inte svarar.

Workern svarar från precache utan att fråga nätet. En omladdning i tunneln väntar alltså inte på en värd som inte går att nå. Ett cache-miss får högst fyra sekunder mot nätet, sedan 503 eller den cachade sidan.

Positionen väntar inte på workern och inte på att värden svarar. Modulen läser GPS lokalt.

## Prova

1. Första besöket sparar hela sajten. Statusraden ska visa att länken är uppe, att värden nås och att cachen är aktiv.
2. Stäng av nätverket och ladda om. Länken är nere, värden nås inte, cachen är aktiv. Panelen finns kvar.
3. Med nätverk igång men värden blockerad (tunneln): länken är uppe, värden nås inte, sidan och senaste position finns kvar.
4. På Min sida: **Hämta position**, bekräfta, och vänta in GPS. Kommer ingen platsfråga, och inget läge, säger panelen att Platstjänster eller webbläsarens tillstånd saknas.
5. Öppna **Annan sida** med en vanlig sidladdning. Senaste position ligger kvar. Där finns inga reglage.
6. Reglaget **Polla position** på Min sida läser positionen löpande. Byt till Annan sida eller en annan flik: den synliga sidan tar över läsningen. Av, på Min sida, stänger av pollningen.

## Hur läsningen går till

Webbläsaren exponerar inte Geolocation API i en service worker. Där finns inte heller `localStorage`, och en behörighetsfråga kan inte visas därifrån. Därför äger modulen hela flödet, i dokumentet, och workern i POC:n gör bara filerna tillgängliga.

Ett tryck på Tillåt anropar `getCurrentPosition` i samma tur, innan något `await`. Safari på iPhone visar ingen platsfråga om anropet görs efter en behörighetskoll eller ett Web Lock, och felcallbacken uteblir ofta också.

I samma tur, utan att vänta, kollar modulen:

- finns `navigator.geolocation.getCurrentPosition`
- är sammanhanget secure (`localhost` eller https)
- tillåter Permissions Policy `geolocation`

Permissions API frågas parallellt och får högst 2,5 sekunder på sig. Hänger det, eller kastar det, stoppar det inte läsningen. Säger det `denied` visas det direkt. Stannar läget på `prompt` eller uteblir svaret, och ingen träff kommer inom 10 sekunder, sparas `blocked`. Texten säger att man ska svara om en fråga faktiskt visas, och annars slå på Platstjänster och tillåt webbläsaren. Anropet lämnas igång, så ett sent svar fortfarande kan räknas.

`watchPosition` startar inte i samma tryck. Det väntar tills engångsanropet fått svar, så ett tidigt fel från klockan inte kan avbryta frågan. En sida som tar över en redan igång pollning börjar bevaka direkt. Nekad, blockerad, saknad policy, osäker eller otillgänglig position är ett synligt fel. Ett fel från själva GPS-anropet som är nekat, blockerat, policy, osäkert eller en enhet utan API slår också av pollning.

Träffen normaliseras (ändliga tal, lat inom ±90, long inom ±180) och skrivs av Alpine Persist till `localStorage` som JSON.

En hängande engångshämtning som fortfarande är markerad efter 120 sekunder blir `timeout` vid nästa sidladdning, om inget annat fel redan syns. Pollning får fortsätta.

Position läses med hög noggrannhet, alltså GPS på enheten. Wifi- och mastpositionering anropar ofta en tjänst på det publika internet.

## Offline-cachen i POC:n

`sw.js` installerar en precache av varje fil sajten behöver, tar över direkt (`skipWaiting` + `clients.claim`) och svarar på GET från samma origin med cache först. Förfrågningar med `origin-probe` släpps igenom till nätet. Saknas filen väntar workern högst fyra sekunder på värden. Därefter får en navigering `index.html` eller den kända sidan, annars 503. Workern tar inte emot meddelanden och lagrar ingen position.

När en fil läggs till, byter namn eller tas bort ska sökvägen in i `PRECACHE_URLS` och `CACHE_NAME` räknas upp i samma ändring.

Andra worker-förmågor hjälper inte positionen. Background Sync kan inte läsa GPS. Push har inget med en lokal position att göra. Workbox skulle bara kapsla in precachen, och POC:n har inget byggsteg. Sidan är ES-moduler, så en blandning av gammal och ny kod går sönder tyst. En versionsatt cache byts därför ut i ett svep när `CACHE_NAME` ändras, och bara när värden faktiskt nås.

## Filer

| Fil | Roll |
| --- | --- |
| `js/coordinates/index.js` | Det en Vite-app importerar. Exporterar `startCoordinates` |
| `js/coordinates/engine.js` | `Alpine.store("geo")`, GPS, tillstånd, Alpine Persist, Web Lock |
| `js/coordinates/components.js` | `coordinatesStatus`, `coordinatesControls`, `coordinatesConfirm` |
| `js/coordinates/status.js` | Texterna i panelen |
| `js/coordinates/panel.css` | Utseende för panelen. Variabler faller tillbaka om värden inte sätter `--ink`, `--sheet` och de andra |
| `js/app.js` | POC:ns layout. Startar Alpine, persist och storen på varje sida |
| `vendor/` | Alpine och persist för POC:n. En Vite-app använder sina egna paket |
| `js/offline-status.js` | POC:ns länk, värd och cache. Inte en del av modulen |
| `sw.js` | POC:ns offline-cache |
| `index.html` | Min sida, med reglage |
| `about.html` | Annan sida, bara avläsning |

## Flöde

```text
layouten anropar startCoordinates() före Alpine.start()
        │
        ├─ Alpine.store("geo") med Alpine Persist
        │
        ├─ requestAccessOnLoad, om sammanhanget tillåter det
        │
        └─ pollning som redan är på tas över av den synliga sidan
                    │
                    ▼
Min sida har x-data för reglagen
        │
        ▼
bekräftelse i dialogen, $store.geo.request() i samma tryck
        │
        ▼
synliga spärrar: API, https, permissions policy
        │
        ├─ spärr → fel sparas i localStorage
        │
        └─ annars → getCurrentPosition i samma tryck
                    │
                    └─ träffen skrivs till localStorage
                              │
                              ▼
                        nästa dokument läser samma nycklar vid start

Web Lock väljer vilken synlig sida som får fortsätta läsa.
sw.js ligger vid sidan av det här och används bara av POC:n
```
