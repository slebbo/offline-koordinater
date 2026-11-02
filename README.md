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

Optionen är av som standard. POC:n slår på den om `<html>` har `data-request-access="true"`, eller om adressen har `?request-access`. Reglaget **Hämta vid sidladdning** är ett annat val: det läser en ny träff vid varje sidladdning även när en redan finns.

En väntande fråga ställs igen vid nästa sidladdning, tills webbläsaren har ett ja eller nej. Det är meningen när optionen är på på varje sida.

### Reglage på en sida

Montera panelen bara i vyn där reglagen ska ligga. Motorn fortsätter när vyn tas bort. Funktionen som `mountCoordinatesPanel` returnerar tar bort panelen, till exempel när en flik stängs i en SPA.

```js
import { mountCoordinatesPanel } from "./coordinates/index.js";

const unmount = mountCoordinatesPanel(document.querySelector("#position"));
```

Panelen ritar status, senaste träff, knappen **Hämta position**, reglagen **Polla position** och **Hämta vid sidladdning**, listan **Upplösning** och bekräftelsedialogen. Elementet måste finnas i dokumentet. Dialogen måste nå `getCurrentPosition` i samma tur som klicket, annars visar Safari ingen fråga. Panelen gör det redan. Upplösningen behöver ingen dialog: den sparas direkt och gäller nästa läsning.

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

En egen Alpine-vy, med global store och persist, beskrivs i avsnittet Alpine.

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
  // state.polling, state.readOnLoad, state.acquiring, state.error
});

coordinates.request("oneshot");
coordinates.request("poll");
coordinates.request("load");
coordinates.refreshNow();
coordinates.stopPolling();
coordinates.stopReadOnLoad();
coordinates.setPollInterval(15000);
```

`getCoordinates()` kräver att layouten redan har kallat `startCoordinates()`. `request` och `refreshNow` måste anropas synkront i klickhanteraren. En `await` före anropet gör att Safari inte visar platsfrågan. `setPollInterval` frågar inte om tillstånd och får anropas när som helst.

`state.readOnLoad` hämtar en ny position varje gång ett dokument anropar `startCoordinates()`, alltså vid en vanlig sidladdning. En vyväxling i samma dokument gör det inte. Läget sparas och gäller på nästa sida. Safari läser där utan ett nytt tryck när bekräftelsen redan gett tillstånd.

`state.pollIntervalMs` är millisekunder. Tillåtna värden är 1000, 5000, 15000, 30000, 60000, 300000, 900000 och 3600000. Andra tal snappar till närmaste. Saknas värdet är det 15 sekunder. 1000 följer enhetens egen takt. Övriga är minsta tid mellan läsningar.

`state.error` är `denied`, `blocked`, `unavailable`, `timeout`, `unsupported`, `insecure`, `policy` eller `null`.

### Lagring och flikar

| Nyckel | Innehåll |
| --- | --- |
| `ok.longitude`, `ok.latitude` | Senaste godkända koordinater |
| `ok.updatedAt` | Tidsstämpel från GPS-träffen, i millisekunder |
| `ok.polling` | Om löpande läsning är på |
| `ok.pollIntervalMs` | Upplösning i millisekunder. Standard 15000 |
| `ok.readOnLoad` | Om en ny position hämtas vid varje sidladdning |
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

Flera flikar delar `localStorage`, men bara en anropar GPS. Den synliga sidan tar ett exklusivt Web Lock, `offline-koordinater-geo`. Låset släpps när sidan döljs, navigerar bort eller stänger av pollningen. Webbläsaren släpper det också om dokumentet försvinner. Nästa synliga sida läser `polling`, `readOnLoad` och `acquireMode` och fortsätter. Saknas Web Locks läser sidan ändå, utan flik-lås.

`storagePrefix` och `lockName` kan bara sättas av det första anropet i dokumentet. Ett senare anrop med `requestAccessOnLoad: true` frågar ändå, en gång, om det första inte gjorde det.

### Alpine

GPS, flik-lås och nycklarna `ok.*` stannar i modulen. Alpine är lagret som gör samma fält globala: `Alpine.store("coordinates")` och `$store.coordinates` i vilken komponent som helst. `@alpinejs/persist` läser och skriver samma nycklar, så det blir en post per fält.

I Vite-appen:

```bash
npm install alpinejs @alpinejs/persist
```

Den här POC:n lämnar Alpine till appen som bäddar in modulen. Alpines vanliga bygge, paketet `alpinejs`, utvärderar uttryck med `new Function`. Har appen en Content-Security-Policy utan `'unsafe-eval'` importerar du `@alpinejs/csp`. Persist-pluginet är detsamma. Exemplen registrerar `Alpine.data` i JS-filer. Mallarna läser fält, anropar metoder och binder `hidden`.

`Alpine.plugin(persist)` ska köras innan storen skapas, annars finns inte `Alpine.$persist`. `startCoordinates()` ska köras innan storen anropar `getCoordinates()`.

```js
import Alpine from "alpinejs";
import persist from "@alpinejs/persist";
import { startCoordinates } from "./coordinates/index.js";
import { registerCoordinatesStore } from "./coordinates-store.js";
import { registerCoordinatesData } from "./coordinates-data.js";

startCoordinates({
  requestAccessOnLoad: true,
});

Alpine.plugin(persist);

// Dialog mode only. A reload should not reopen the dialog.
Alpine.store("ui", {
  mode: null,
  open(mode) {
    this.mode = mode;
  },
  close() {
    this.mode = null;
  },
});

registerCoordinatesStore(Alpine);
registerCoordinatesData(Alpine);
Alpine.start();
```

Byter layouten `storagePrefix` ska samma prefix in i `.as(...)` nedan. `ui` finns bara i minnet.

#### Store

```js
import { getCoordinates } from "./coordinates/index.js";

const FIELDS = [
  "longitude",
  "latitude",
  "updatedAt",
  "polling",
  "pollIntervalMs",
  "readOnLoad",
  "acquiring",
  "acquiringSince",
  "acquireMode",
  "error",
];

export function registerCoordinatesStore(Alpine) {
  const coordinates = getCoordinates();
  const prefix = "ok";

  Alpine.store("coordinates", {
    longitude: Alpine.$persist(null).as(`${prefix}.longitude`),
    latitude: Alpine.$persist(null).as(`${prefix}.latitude`),
    updatedAt: Alpine.$persist(null).as(`${prefix}.updatedAt`),
    polling: Alpine.$persist(false).as(`${prefix}.polling`),
    pollIntervalMs: Alpine.$persist(15000).as(`${prefix}.pollIntervalMs`),
    readOnLoad: Alpine.$persist(false).as(`${prefix}.readOnLoad`),
    acquiring: Alpine.$persist(false).as(`${prefix}.acquiring`),
    acquiringSince: Alpine.$persist(null).as(`${prefix}.acquiringSince`),
    acquireMode: Alpine.$persist(null).as(`${prefix}.acquireMode`),
    error: Alpine.$persist(null).as(`${prefix}.error`),

    request(mode) {
      coordinates.request(mode);
    },
    refreshNow() {
      coordinates.refreshNow();
    },
    stopPolling() {
      coordinates.stopPolling();
    },
    stopReadOnLoad() {
      coordinates.stopReadOnLoad();
    },
    setPollInterval(ms) {
      coordinates.setPollInterval(ms);
    },
  });

  // Same-document writes do not emit a storage event. Copy the module
  // snapshot into the store. Skip equal values so Persist does not write
  // the key again and bounce the other tab.
  coordinates.subscribe((state) => {
    const store = Alpine.store("coordinates");
    for (const field of FIELDS) {
      if (Object.is(store[field], state[field])) continue;
      store[field] = state[field];
    }
  });
}
```

Persist fyller storen när den skapas, innan `Alpine.start()` ritar. En sida utan reglage visar alltså senaste träff direkt. Prenumerationen håller storen ikapp när modulen får en ny träff i samma dokument. Andra flikar får modulens `storage`-händelse, som i sin tur uppdaterar deras store.

Storens metoder anropar modulen och är vanliga funktioner. `request` och `refreshNow` måste nå `getCurrentPosition` i samma tur som klicket, annars visar Safari ingen platsfråga.

Vilken vy som helst läser samma global. Registrera `Alpine.data` före `Alpine.start()`:

```html
<p x-data="positionLabel" x-text="label"></p>
```

```js
Alpine.data("positionLabel", () => ({
  get label() {
    const { longitude, latitude } = this.$store.coordinates;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return "Ingen position ännu";
    return `${longitude.toFixed(6)}, ${latitude.toFixed(6)}`;
  },
}));
```

Utanför en komponent:

```js
const coordinates = Alpine.store("coordinates");
coordinates.latitude;
coordinates.longitude;
```

`coordinates.request("oneshot")` hör hemma i klickhanteraren, inte i en fri funktion som anropas efter en `await`.

#### Komponenter

`mountCoordinatesPanel` ritar modulens egen panel. Alpine-komponenterna är vyn när reglagen ska ligga i appens mall. Layouten har redan kallat `startCoordinates()`. Länka `js/coordinates/panel.css` om klasserna ska se ut som i POC:n. `[x-cloak] { display: none !important; }` döljer fallback-texten tills Alpine har läst `localStorage`.

Texterna kommer från `describeCoordinates` i `js/coordinates/status.js`.

```js
import { describeCoordinates, pollIntervalCadence } from "./coordinates/status.js";

const ONESHOT_DIALOG =
  "Får enheten hämta position en gång? Träffen sparas i webbläsaren. Du kan byta sida medan hämtningen pågår.";

export function registerCoordinatesData(Alpine) {
  Alpine.data("coordinatesReadout", coordinatesReadout);
  Alpine.data("fetchPosition", fetchPosition);
  Alpine.data("pollSwitch", pollSwitch);
  Alpine.data("loadSwitch", loadSwitch);
  Alpine.data("pollInterval", pollInterval);
  Alpine.data("confirmDialog", confirmDialog);
}

function coordinatesReadout() {
  return {
    get view() {
      return describeCoordinates(this.$store.coordinates);
    },
    get spinnerHidden() {
      return !this.view.busy;
    },
    get busyValue() {
      return this.view.busy ? "true" : "false";
    },
  };
}

function fetchPosition() {
  return {
    ask() {
      const coordinates = this.$store.coordinates;
      if (coordinates.polling) {
        coordinates.refreshNow();
        return;
      }
      this.$store.ui.open("oneshot");
    },
  };
}

function pollSwitch() {
  return {
    init() {
      this.$refs.input.checked = Boolean(this.$store.coordinates.polling);
      this.$watch("$store.coordinates.polling", (value) => {
        this.$refs.input.checked = Boolean(value);
      });
    },
    onChange(event) {
      if (event.target.checked) {
        event.target.checked = false;
        this.$store.ui.open("poll");
        return;
      }
      this.$store.coordinates.stopPolling();
    },
  };
}

function loadSwitch() {
  return {
    init() {
      this.$refs.input.checked = Boolean(this.$store.coordinates.readOnLoad);
      this.$watch("$store.coordinates.readOnLoad", (value) => {
        this.$refs.input.checked = Boolean(value);
      });
    },
    onChange(event) {
      if (event.target.checked) {
        event.target.checked = false;
        this.$store.ui.open("load");
        return;
      }
      this.$store.coordinates.stopReadOnLoad();
    },
  };
}

function pollInterval() {
  return {
    init() {
      const sync = (value) => {
        this.$refs.input.value = String(value);
      };
      sync(this.$store.coordinates.pollIntervalMs);
      this.$watch("$store.coordinates.pollIntervalMs", sync);
    },
    onChange(event) {
      this.$store.coordinates.setPollInterval(Number(event.target.value));
    },
  };
}

function confirmDialog() {
  return {
    init() {
      const dialog = this.$el;
      this.$watch("$store.ui.mode", (mode) => {
        if (mode && !dialog.open) dialog.showModal();
        if (!mode && dialog.open) dialog.close();
      });
      dialog.addEventListener("close", () => {
        if (this.$store.ui.mode) this.$store.ui.close();
      });
    },
    get text() {
      const mode = this.$store.ui.mode;
      if (mode === "oneshot") return ONESHOT_DIALOG;
      if (mode === "poll") {
        const cadence = pollIntervalCadence(this.$store.coordinates.pollIntervalMs);
        return `Får enheten hämta position ${cadence}? Reglaget stänger av pollningen, även om du har bytt sida.`;
      }
      if (mode === "load") {
        return "Får enheten hämta position varje gång en sida öppnas? Reglaget stänger av det, även om du har bytt sida.";
      }
      return "";
    },
    allow() {
      const mode = this.$store.ui.mode;
      // Reach getCurrentPosition in this turn, before the dialog closes.
      if (mode === "poll" || mode === "oneshot" || mode === "load") this.$store.coordinates.request(mode);
      this.$store.ui.close();
    },
    cancel() {
      this.$store.ui.close();
    },
  };
}
```

```html
<section
  class="coordinates"
  x-data="coordinatesReadout"
  x-cloak
  x-bind:data-phase="view.phase"
  x-bind:aria-busy="busyValue"
  aria-label="Enhetens position"
>
  <p class="coordinates-status">
    <span class="coordinates-spinner" x-bind:hidden="spinnerHidden"></span>
    <span class="coordinates-status-text" x-text="view.statusText">Ingen hämtning pågår.</span>
  </p>
  <dl class="coordinates-readout">
    <div>
      <dt>Position (long, lat)</dt>
      <dd class="coordinates-position" x-text="view.positionText" x-bind:data-empty="view.positionEmpty">Ingen position ännu</dd>
    </div>
    <div>
      <dt>Senast uppdaterad</dt>
      <dd class="coordinates-updated" x-text="view.updatedText" x-bind:data-empty="view.updatedEmpty">Inte uppdaterad</dd>
    </div>
  </dl>
  <div class="coordinates-controls">
    <button class="coordinates-action" type="button" x-data="fetchPosition" x-on:click="ask">Hämta position</button>
    <div x-data="pollSwitch">
      <label class="coordinates-switch">
        <input class="coordinates-switch-input" type="checkbox" role="switch" x-ref="input" x-on:change="onChange($event)">
        <span class="coordinates-track" aria-hidden="true"><span class="coordinates-thumb"></span></span>
        <span>Polla position</span>
      </label>
    </div>
    <div x-data="loadSwitch">
      <label class="coordinates-switch">
        <input class="coordinates-switch-input" type="checkbox" role="switch" x-ref="input" x-on:change="onChange($event)">
        <span class="coordinates-track" aria-hidden="true"><span class="coordinates-thumb"></span></span>
        <span>Hämta vid sidladdning</span>
      </label>
    </div>
    <label class="coordinates-interval" x-data="pollInterval">
      <span>Upplösning</span>
      <select class="coordinates-interval-input" x-ref="input" x-on:change="onChange($event)">
        <option value="1000">1 sekund (enhetens takt)</option>
        <option value="5000">5 sekunder</option>
        <option value="15000">15 sekunder</option>
        <option value="30000">30 sekunder</option>
        <option value="60000">1 minut</option>
        <option value="300000">5 minuter</option>
        <option value="900000">15 minuter</option>
        <option value="3600000">1 timme</option>
      </select>
    </label>
  </div>
</section>

<dialog class="coordinates-dialog" x-data="confirmDialog">
  <h2 class="coordinates-dialog-title">Bekräfta position</h2>
  <p class="coordinates-dialog-text" x-text="text"></p>
  <div class="coordinates-dialog-actions">
    <button type="button" x-on:click="cancel">Avbryt</button>
    <button class="coordinates-action" type="button" x-on:click="allow">Tillåt</button>
  </div>
</dialog>
```

Låt poll-reglaget och sidladdnings-reglaget vara egna checkboxar. `polling` sätts i `request("poll")` och `readOnLoad` i `request("load")`, först när dialogen fått ett ja. `x-model` på flaggan skulle spara den innan dess. Upplösningen är en vanlig lista: `setPollInterval` snappar värdet och sparar det utan dialog. Etiketter för valen finns i `pollIntervalOptionLabel` i `status.js`. Avläsning utan reglage är `coordinatesReadout` ensam. `error` är samma koder som i avsnittet Eget gränssnitt.

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
6. Reglaget **Polla position** på Min sida läser positionen med vald **Upplösning**. Standard är 15 sekunder. 1 sekund följer enhetens egen takt, ofta ungefär en gång i sekunden. Byt till Annan sida eller en annan flik: den synliga sidan tar över läsningen. Av, på Min sida, stänger av pollningen.
7. Reglaget **Hämta vid sidladdning** läser en ny position varje gång en sida öppnas, även Annan sida, även när en träff redan finns. Av lämnar den sparade träffen kvar till nästa manuella hämtning.

## Hur läsningen går till

Webbläsaren exponerar inte Geolocation API i en service worker. Där finns inte heller `localStorage`, och en behörighetsfråga kan inte visas därifrån. Därför äger modulen hela flödet, i dokumentet, och workern i POC:n gör bara filerna tillgängliga.

Ett tryck på Tillåt anropar `getCurrentPosition` i samma tur, innan något `await`. Safari på iPhone visar ingen platsfråga om anropet görs efter en behörighetskoll eller ett Web Lock, och felcallbacken uteblir ofta också.

I samma tur, utan att vänta, kollar modulen:

- finns `navigator.geolocation.getCurrentPosition`
- är sammanhanget secure (`localhost` eller https)
- tillåter Permissions Policy `geolocation`

Permissions API frågas parallellt och får högst 2,5 sekunder på sig. Hänger det, eller kastar det, stoppar det inte läsningen. Säger det `denied` visas det direkt. Stannar läget på `prompt` eller uteblir svaret, och ingen träff kommer inom 10 sekunder, sparas `blocked`. Texten säger att man ska svara om en fråga faktiskt visas, och annars slå på Platstjänster och tillåt webbläsaren. Anropet lämnas igång, så ett sent svar fortfarande kan räknas.

`watchPosition` startar inte i samma tryck. Det väntar tills engångsanropet fått svar, så ett tidigt fel från klockan inte kan avbryta frågan. En sida som tar över en redan igång pollning på 1 sekund börjar bevaka direkt. Nekad, blockerad, saknad policy, osäker eller otillgänglig position är ett synligt fel. Ett fel från själva GPS-anropet som är nekat, blockerat, policy, osäkert eller en enhet utan API slår också av pollning.

Geolocation API har inget intervall. Upplösningen 1 sekund är därför enhetens egen takt: `watchPosition` med hög noggrannhet, som ofta levererar en träff ungefär en gång i sekunden. `maximumAge` på 5 sekunder tillåter en cachad träff och sätter inte takten.

Grövre upplösning anropar `getCurrentPosition` en gång per intervall. Nästa läsning tidigast när intervallet har gått sedan den förra började. Tar själva läsningen längre tid börjar nästa när den pågående är klar. Ett fel som inte stänger av pollningen väntar ett helt intervall innan nästa försök. Listan kan ändras medan pollning är på. Valet ligger i `ok.pollIntervalMs` och följer med till nästa sida. Standard är 15 sekunder. Tillåtna värden är 1 sekund, 5 sekunder, 15 sekunder, 30 sekunder, 1 minut, 5 minuter, 15 minuter och 1 timme.

`readOnLoad` läser en gång per dokument, även när en träff redan ligger sparad. Det startar i `startCoordinates()`, så det är en sidladdning och inte ett routbyte i samma dokument. Bekräftelsen på reglaget är trycket som får visa platsfrågan. Senare sidor läser utan nytt tryck när tillståndet redan är givet. En nekad, blockerad, osäker eller otillgänglig position stänger av läget. Pollning och sidladdning kan vara på samtidigt: sidan läser direkt och fortsätter sedan med upplösningen.

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
| `js/coordinates/interval.js` | Tillåtna upplösningar |
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
