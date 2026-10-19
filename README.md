# Gemini Live × Cartesia — ხმოვანი აგენტი ბრაუზერში

ბრაუზერში ელაპარაკები აგენტს: **Gemini Live** გისმენს, ხვდება როდის დაამთავრე და ფიქრობს, ხოლო **Cartesia Sonic** პასუხს შენთვის სასურველი ხმით ამბობს.
შეგიძლია აგენტს სიტყვა გააწყვეტინო, ზუსტად როგორც ადამიანს.

```
ბრაუზერი ── mic 16 kHz (echo cancellation) ──▶ Node სერვერი ──▶ Gemini Live (gemini-3.8-live)
   ▲                                              │  ისმენს · VAD · ფიქრობს → პასუხის ტექსტი
   └──────── ხმა 24 kHz ◀── Cartesia Sonic 3.6 ◀──┘  ტექსტი ნაწილ-ნაწილ → ხმა (continuations)
```

## გაშვება

```bash
npm install
```

```bash
cp .env.example .env
```

`.env`-ში ჩაწერე `GEMINI_API_KEY`, `CARTESIA_API_KEY` და `CARTESIA_VOICE_ID`. ხმას აარჩევ [play.cartesia.ai/voices](https://play.cartesia.ai/voices)-ზე.

```bash
npm run dev
```

გახსენი http://localhost:4000 და დააჭირე **დაწყება**-ს. ყურსასმენით უკეთ მუშაობს: ლეპტოპის დინამიკიდან ექო ზოგჯერ აგენტს საკუთარ თავს აწყვეტინებს.

## აგენტის მორგება

| რა | სად |
| --- | --- |
| ვინ არის აგენტი და რას აკეთებს | `prompts/system.md` |
| პირველი ფრაზა (ცარიელი = აგენტი შენ გელოდება) | `prompts/greeting.txt` |
| როგორ ილაპარაკოს, რომ TTS-მა ბუნებრივად ჟღერდეს | `prompts/voice-rules.md` (ყოველთვის ემატება) |
| ხმა, ენა, სიჩქარე, მოდელები, VAD | `.env` (იხ. `.env.example`) |

პრომპტის ფაილები ყოველ ახალ ზარზე თავიდან იკითხება, სერვერის რესტარტი არ სჭირდება.
UI-ში ⚙ პანელიდან შეგიძლია პრომპტი, მისალმება, ხმა და სიჩქარე მხოლოდ შენს ბრაუზერში შეცვალო.
სერვერზე ეს `ALLOW_CLIENT_OVERRIDES=false`-ით ითიშება.

სისტემურ ინსტრუქციას სერვერი ავტომატურად ამატებს ენის წესს: აგენტი ყოველთვის `CARTESIA_LANGUAGE` ენაზე პასუხობს, რადგან ხმა მხოლოდ ამ ენაზე ლაპარაკობს.

### მთავარი პარამეტრები

| ცვლადი | ნაგულისხმევი | რას აკეთებს |
| --- | --- | --- |
| `GEMINI_VAD_SILENCE_MS` | `600` | რამდენი ms სიჩუმის შემდეგ ჩაითვლება, რომ დაამთავრე. ნაკლები = უფრო სწრაფი, მეტი = ნაკლებად გაწყვეტინებს |
| `GEMINI_VAD_START_SENSITIVITY` | — | `LOW` = ხმაური და ექო ნაკლებად აწყვეტინებს აგენტს |
| `GEMINI_INPUT_LANGUAGE` | `CARTESIA_LANGUAGE` | შენი მეტყველების ენა ტრანსკრიპტისთვის; `auto` = ავტომატური ამოცნობა |
| `CARTESIA_SPEED` | `1.0` | 0.6–1.5 |
| `CARTESIA_MAX_BUFFER_DELAY_MS` | `0` | Cartesia-ს ბუფერი; 0, რადგან ტექსტს სერვერი თვითონ ჭრის |
| `BARGE_IN_MIN_CHARS` | `3` | სათადარიგო შეწყვეტა ტრანსკრიპტით (ძირითადი Gemini-ის VAD-ია) |

## როგორ მუშაობს

- **ტვინი — Gemini Live.** `gemini-3.8-live` მხოლოდ აუდიოს აბრუნებს, ამიტომ პასუხის ტექსტი მისი `outputTranscription`-იდან მოდის, Gemini-ის საკუთარი ხმა კი იგდება.
- **ხმა — Cartesia.** ზარზე ერთი WebSocket, ყოველ პასუხზე ერთი context. ტექსტი continuation-ებით ნაწილ-ნაწილ შედის, ამიტომ ინტონაცია ერთიანი რჩება.
- **პირველი ხმა სწრაფად.** პასუხის პირველი სრული სიტყვები Cartesia-ში მაშინვე იგზავნება. სანამ ისინი ჟღერს, წინადადების დანარჩენი ნაწილი ჩამოდის.
- **შეწყვეტინება (barge-in)** ~0.4–0.5 წამში ხდება: Gemini-ის `interrupted`, Gemini VAD-ის „ლაპარაკი დაიწყო“, ან ტრანსკრიპტი, სანამ აგენტის ხმა ისმის. სერვერი Cartesia-ს აჩერებს, ბრაუზერი ბუფერს მაშინვე ასუფთავებს.
- **გრძელი საუბარი.** Context compression და session resumption; Gemini-ის `goAway`-ზე სესია ჩუმად აღდგება ახალ კავშირზე.
- **Latency** ყოველ პასუხზე ჩანს UI-შიც და სერვერის ლოგშიც.

**გაზომილი** (`npm run smoke`): პირველი ხმა შენი ლაპარაკის დასრულებიდან ~1.1–1.8 წამში. აქედან Gemini ~1.2 წმ-ია (600 ms VAD-ის ჩათვლით), Cartesia კი ~130–150 ms. შეწყვეტინება ~0.4–0.5 წმ.

დეტალები და დიზაინის გადაწყვეტილებები: [docs/architecture.md](docs/architecture.md).

## ბრძანებები

| ბრძანება | რას აკეთებს |
| --- | --- |
| `npm run dev` | სერვერი + UI ერთ პორტზე (Vite HMR) |
| `npm run build` / `npm start` | production build და გაშვება |
| `npm test` | unit ტესტები (chunker, session, Gemini adapter, worklets) |
| `npm run smoke` | E2E ტესტი რეალურ Gemini + Cartesia-ზე. აგენტის ხმა `.smoke/*.wav`-ში ინახება |
| `npm run verify` | typecheck + lint + test + build |

## სტრუქტურა

```
prompts/                      system.md · greeting.txt · voice-rules.md
src/shared/protocol.ts        ბრაუზერი ↔ სერვერი მესიჯები
src/server/
  app.ts, index.ts            HTTP + WebSocket (/ws) + Vite / static
  config.ts, prompts.ts       .env-ის ვალიდაცია, სისტემური ინსტრუქცია
  browserSocket.ts            ბრაუზერის transport (binary აუდიო + JSON)
  createSession.ts            ზარის აწყობა: Gemini + Cartesia + session
  session/VoiceSession.ts     საუბრის რიგი, შეწყვეტინება, latency
  session/GeminiBrain.ts      Gemini Live: VAD, ტრანსკრიპტები, resumption
  session/CartesiaVoice.ts    Cartesia WS: context ყოველ პასუხზე
  session/SpeechChunker.ts    ტექსტი → სალაპარაკო ნაწილები
src/web/
  main.ts, VoiceClient.ts     UI და WebSocket კლიენტი
  audio/AudioEngine.ts        მიკროფონი + დაკვრა
  public/*-worklet.js         AudioWorklet-ები: 16 kHz capture, ring-buffer player
scripts/smoke.ts              E2E ტესტი
```

## შეზღუდვები

- Gemini-ის აუდიოს, რომელსაც ვაგდებთ, მაინც იხდი: Live მოდელებს მხოლოდ ტექსტის რეჟიმი არ აქვთ.
- შეწყვეტინების შემდეგ Gemini-მ არ იცის, პასუხის რომელი ნაწილი მოისმინე.
- ავტორიზაცია არ არის: სერვერი ლოკალური/შიდა გამოყენებისთვისაა.
