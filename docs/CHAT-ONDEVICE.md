# CHAT-ONDEVICE — chatt körs bara on-device (Apple Intelligence), annars ingen chatt alls

Beslut 2026-11-22: iOS-appen använder **bara** telefonens egen AI (Foundation Models / Apple
Intelligence, iOS 26+). Vid **första launch** görs en engångskontroll av enhet + Apple Intelligence;
sparas resultatet i UserDefaults. Saknas stöd → chatt-funktionen **döljs helt** i UI:t (ingen
Mistral-fallback i appen). Server-endpointen `/api/chat` (Mistral, nyckel i `.env`) finns kvar
för webb-prototypen och dev — nyckeln får aldrig in i appen.

## Varför inte nyckel i appen

Allt i appens binär kan extraheras — en Mistral-nyckel där skulle kunna missbrukas obegränsat
på din kostnad. On-device behövs ingen nyckel alls. Prompten i koden är då bara
beteendestyrning (inte en säkerhetsgräns) — OK eftersom det inte finns någon hemlighet att skydda.

## Ny fil: `Services/OnDeviceChat.swift`

```swift
import FoundationModels

enum OnDeviceChat {
    static let checkedKey = "svampradar.ondeviceChat.checked.v1"
    static let supportedKey = "svampradar.ondeviceChat.supported.v1"

    /// Engångskoll vid första launch (idempotent): sparar om enhet + Apple Intelligence stöds.
    static func bootstrapFirstLaunch() {
        if UserDefaults.standard.bool(forKey: checkedKey) { return }
        let (ok, reason) = availabilityNow()
        UserDefaults.standard.set(true, forKey: checkedKey)
        UserDefaults.standard.set(ok, forKey: supportedKey)
        print("[OnDeviceChat] first check: available=\(ok) reason=\(reason)")
    }

    /// true = chatt ska visas. Kör bootstrap automatiskt om den inte körts än.
    static var isSupported: Bool {
        bootstrapFirstLaunch()
        return UserDefaults.standard.bool(forKey: supportedKey)
    }

    static func availabilityNow() -> (Bool, String) {
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available: return (true, "available")
            case .unavailable(let reason): return (false, String(describing: reason))
            @unknown default: return (false, "unknown")
            }
        }
        return (false, "iOS < 26")
    }

    /// Ställ en fråga on-device. Kasta fel om ej stöds (ska inte hända när UI är gömd).
    @available(iOS 26.0, *)
    static func ask(question: String, species: String, place: String) async throws -> String {
        guard SystemLanguageModel.default.isAvailable else {
            throw OnDeviceChatError.notAvailable
        }
        let session = LanguageModelSession(instructions: """
            Du är Svampradars svampassistent. Svara ALLTID på svenska, kort och konkret.
            Svara bara om svenska matsvampar och svampställen i Sverige.
            Varna ALLTID tydligt när en ätlig art lätt förväxlas med en giftig.
            Användaren letar just nu efter: \(species). Plats: \(place).
            Ge aldrig medicinska råd; rekommendera alltid att dubbelkolla med fälthandbok.
            """)
        let response = try await session.respond(to: question)
        return response.content
    }
}

enum OnDeviceChatError: LocalizedError {
    case notAvailable
    var errorDescription: String? { "Apple Intelligence är inte tillgänglig på denna enhet." }
}
```

Krav: Xcode 26 (iOS 26 SDK). Deployment target kan vara lägre — `import FoundationModels` weak-linkas
automatiskt och alla användningar är skyddade med `if #available(iOS 26.0, *)`.

## Integration i Svampradar (Xcode-projektet, ligger utanför detta repo)

1. Skapa filen `Services/OnDeviceChat.swift` (innehåll ovan) — kör Mac-kommandot nedan.
2. I appens entry point (t.ex. `SvampradarApp.init` eller `ContentView.onAppear`):
   `OnDeviceChat.bootstrapFirstLaunch()`
3. Vid chatt-knappen/UI: omge med `if OnDeviceChat.isSupported { ... }` — annars syns ingen chatt alls.
4. Vid själva frågan, byt ut anropet mot `/api/chat` mot:

```swift
if #available(iOS 26.0, *) {
    let answer = try await OnDeviceChat.ask(question: text, species: selectedSpeciesName, place: placeName)
    // ev. streaming: for try await partial in session.streamResponse(to: text) { ... }
} else {
    // stöds inte — UI ska vara gömt här
}
```

Hitta var chatt-UI:t finns: `grep -rn "api/chat" /Users/stefanh/Documents/Svampradar/Svampradar --include="*.swift" | grep -v ".bak"`

## Mac-kommando (skapar filen)

```bash
zsh -lc '
APP_DIR="/Users/stefanh/Documents/Svampradar/Svampradar"
mkdir -p "$APP_DIR/Services"
python3 - <<'\''PY'\''
from pathlib import Path
swift = r'''PASTA IN OnDeviceChat.swift FRÅN DENNA DOC'''
p = Path("/Users/stefanh/Documents/Svampradar/Svampradar/Services/OnDeviceChat.swift")
p.write_text(swift, encoding="utf-8")
print("skrev", p, p.stat().st_size, "bytes")
PY
'
```

## Noter

- `availability` kan rapportera `.unavailable(.modelNotReady)` om modellens assets ännu inte
  laddats ner. Enligt beslutet ovan kollar vi bara första launch — vill du vara snällare kan du
  vid `.modelNotReady` låta `checkedKey` vara osatt så kontrollen görs om nästa launch.
- On-device-modellen har ingen webbåtkomst; kontext (art/plats/datum) skickas med i prompten.
- Chatten är då helt gratis och offline — serverkostnaden blir kvar bara för tiles/hotspots
  (se `docs/AUDIT.md` §3) och ev. betalningsvalidering.
