# offline-koordinater

Positionen är en modul som kan köras i bakgrunden på varje sida. Reglagen monteras bara där de ska synas, till exempel på en flik under Min sida. POC:n i den här repan är en statisk sajt som använder modulen så, och dessutom en service worker så att sidorna finns kvar utan publikt internet. Modulen själv registrerar ingen worker och anropar inget nät.

## Använda modulen i Vite

Kopiera in `js/coordinates/`. Vite buntar ES-modulerna som de är. Ingen byggkonfiguration behövs i den här repan, och inget av `sw.js` eller `js/offline-status.js` ska med om sajten redan har nät.

### Layouten, på varje sida

Anropa `startCoordinates()` en gång per sidladdning, i den gemensamma layouten. Det startar lagring, flik-lås och, om pollning redan är på, GPS-läsningen. Sidan behöver inga knappar för det.

```js
import { startCoordinates } from "./coordinates/index.js";
import "./coordinates/panel.css";

startCoordinates({
  requestAccessOnLoad: true,
});
```

CSS-filen behövs bara om någon sida ritar panelen eller avläsningen. Importen av JavaScript är ofarlig under SSR. Anropa `startCoordinates` i webbläsaren. Anropas den ändå utan `window` gör den ingenting och rör inte `localStorage`.

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

Montera panelen bara i vyn där reglagen ska ligga. Motorn fortsätter när vyn tas bort. Funktionen som `mountCoordinatesPanel` returnerar tar bort panelen, till exempel när en flik stängs i en SPA.

```js
import { mountCoordinatesPanel } from "./coordinates/index.js";

const unmount = mountCoordinatesPanel(document.querySelector("#position"));
```

Panelen ritar status, senaste träff, knappen **Hämta position**, reglaget **Polla position** och bekräftelsedialogen. Elementet måste finnas i dokumentet. Dialogen måste nå `getCurrentPosition` i samma tur som klicket, annars visar Safari ingen fråga. Panelen gör det redan.

Vue:

```js
import { mountCoordinatesPanel } from "./coordinates/index.js";

export default {
  mounted() {
    this.unmount = mountCoordinatesPanel(this.$refs.position);
  },
  beforeUnmount() {
    this.unmount?.();
  },
  template: `<div ref="position"></div>`,
};
```

React:

```jsx
import { useEffect, useRef } from "react";
import { mountCoordinatesPanel } from "./coordinates/index.js";

export function PositionTab() {
  const ref = useRef(null);
  useEffect(() => mountCoordinatesPanel(ref.current), []);
  return <div ref={ref} />;
}
```

### Bara visa läget

```js
import { mountCoordinatesReadout } from "./coordinates/index.js";

mountCoordinatesReadout(document.querySelector("#position"));
```

Avläsningen har status och senaste träff, inga reglage. POC:ns sida Annan sida är det här.

### Eget gränssnitt

```js
import { getCoordinates } from "./coordinates/index.js";

const coordinates = getCoordinates();
const stop = coordinates.subscribe((state) => {
  // state.longitude, state.latitude, state.updatedAt
  // state.polling, state.acquiring, state.error
});

coordinates.request("oneshot");
coordinates.request("poll");
coordinates.refreshNow();
coordinates.stopPolling();
```

`getCoordinates()` kräver att layouten redan har kallat `startCoordinates()`. `request` och `refreshNow` måste anropas synkront i klickhanteraren. En `await` före anropet gör att Safari inte visar platsfrågan.

`state.error` är `denied`, `blocked`, `unavailable`, `timeout`, `unsupported`, `insecure`, `policy` eller `null`.

### Lagring och flikar

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

Öppna `http://localhost:8080`. `js/app.js` är layouten: båda sidorna startar motorn, Min sida monterar panelen, Annan sida monterar avläsningen.

Första besöket måste nå värden så att cachen fylls. Därefter fungerar sidorna i en VPN-tunnel utan publikt internet, och med radiot avstängt.

## Tunnel utan publikt internet

Enheten kan ha wifi eller mobildata och ändå sakna det publika internet, för att trafiken går i en VPN-tunnel som inte släpper ut den. `navigator.onLine` är då sant: operativsystemet ser en länk. Anrop mot sajtens värd, och mot allt utanför tunneln, svart-hålas och hänger tills de får timeout.

Sidan startar inga egna nätanrop. Ingen värdprob. Statusraden i POC:n hör inte till modulen och visar två saker som går att veta utan att fråga nätet:

- **Länk** är bara gränssnittet. Uppe betyder wifi, mobilnät eller VPN-adapter, inte att internet fungerar och inte att värden svarar.
- **Offline-cache** är om workern styr sidan. Den kan vara aktiv både när länken är nere och när länken är uppe men värden inte svarar.

Workern svarar från precache utan att fråga nätet. En omladdning i tunneln väntar alltså inte på en värd som inte går att nå. Ett cache-miss får högst fyra sekunder mot nätet, sedan 503 eller den cachade sidan.

En meta-`Content-Security-Policy` låser skript, stil, bilder och `connect-src` till den egna värden (`'self'`), plus `data:` för ikonen. Modulen bygger inga uttryck med `eval`, så `'unsafe-eval'` ingår inte.

När sidan anropar Geolocation API kan Chrome på en dator själv skicka ett POST till `https://www.googleapis.com/geolocation/v1/geolocate`. Anropet görs av webbläsarprocessen, inte av sidans `fetch`, och en Content-Security-Policy når det inte. På Android frågar Chrome telefonens platstjänst. En GPS-träff kan komma även när Googles nätpositionering misslyckas, om exakt position och GPS är på.

Positionen väntar inte på workern och inte på att värden svarar. Modulen läser GPS lokalt.

## Prova

1. Första besöket sparar hela sajten. Statusraden ska visa att länken är uppe och att cachen är aktiv. Nätverksloggen från sidan ska inte innehålla `origin-probe`.
2. Stäng av nätverket och ladda om. Länken är nere, cachen är aktiv. Panelen finns kvar.
3. Med wifi eller VPN uppe men värden oåtkomlig: länken är fortfarande uppe, cachen är aktiv, sidan och senaste position finns kvar. Sidan gör ingen värdprob.
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

Träffen normaliseras (ändliga tal, lat inom ±90, long inom ±180) och skrivs till `localStorage` som JSON.

En hängande engångshämtning som fortfarande är markerad efter 120 sekunder blir `timeout` vid nästa sidladdning, om inget annat fel redan syns. Pollning får fortsätta.

Position läses med hög noggrannhet, alltså GPS på enheten. Wifi- och mastpositionering anropar ofta en tjänst på det publika internet.

## Offline-cachen i POC:n

`sw.js` installerar en precache av varje fil sajten behöver, tar över direkt (`skipWaiting` + `clients.claim`) och svarar på GET från samma origin med cache först. Saknas filen väntar workern högst fyra sekunder på värden. Därefter får en navigering `index.html` eller den kända sidan, annars 503. Workern tar inte emot meddelanden, lagrar ingen position och släpper inte igenom en prob mot värden.

När en fil läggs till, byter namn eller tas bort ska sökvägen in i `PRECACHE_URLS` och `CACHE_NAME` räknas upp i samma ändring.

Andra worker-förmågor hjälper inte positionen. Background Sync kan inte läsa GPS. Push har inget med en lokal position att göra. Workbox skulle bara kapsla in precachen, och POC:n har inget byggsteg. Sidan är ES-moduler, så en blandning av gammal och ny kod går sönder tyst. En versionsatt cache byts därför ut i ett svep när `CACHE_NAME` ändras, och bara när värden faktiskt nås.

## Filer

| Fil | Roll |
| --- | --- |
| `js/coordinates/index.js` | Det en Vite-app importerar |
| `js/coordinates/engine.js` | Bakgrundsmotor: GPS, tillstånd, `localStorage`, Web Lock |
| `js/coordinates/panel.js` | Panel och avläsning |
| `js/coordinates/status.js` | Texterna i panelen |
| `js/coordinates/panel.css` | Utseende för panelen. Variabler faller tillbaka om värden inte sätter `--ink`, `--sheet` och de andra |
| `js/app.js` | POC:ns layout. Startar motorn på varje sida och monterar det markup ber om |
| `js/offline-status.js` | POC:ns länk och cache. Inte en del av modulen |
| `sw.js` | POC:ns offline-cache |
| `index.html` | Min sida, med reglage |
| `about.html` | Annan sida, bara avläsning |

## Flöde

```text
layouten anropar startCoordinates() på varje sida
        │
        ├─ requestAccessOnLoad, om sammanhanget tillåter det
        │
        └─ pollning som redan är på tas över av den synliga sidan
                    │
                    ▼
Min sida monterar panelen
        │
        ▼
bekräftelse i panelen
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
