# offline-koordinater

POC för att hämta och lagra enhetens position offline.

Sajten är statisk HTML, CSS och JS utan byggsteg. En service worker cachelagrar alla filer vid första besöket och håller senaste position, pågående hämtning och om pollning är på.

## Köra

Service workers fungerar inte från `file://`. Starta en statisk server i repots rot:

```bash
python3 -m http.server 8080
```

Öppna `http://localhost:8080`. Första besöket måste ha nätverk så att cache fylls. Därefter fungerar sidorna offline.

## Flöde

1. Första besöket sparar hela sajten.
2. Stäng av nätverket.
3. På Start: **Hämta position**, bekräfta, och vänta in GPS. En indikator visas medan positionen hämtas.
4. Öppna **Om** med en vanlig sidladdning. Pågående hämtning eller senaste position visas där också.
5. Reglaget **Polla position** längst ned läser positionen löpande tills det stängs av.

Webbläsaren exponerar inte geolocation inuti en service worker. Workern avgör om enheten kan hämta position, lagrar träffen och ber den öppna sidan att läsa GPS så att en sidväxling kan ta över.
