# Credits

AI Hold'em is our own: written by Johnny Chadda (Opper) for this repository, AGPL-3.0-or-later like the kit (see
[LICENSE](LICENSE)). No-limit Texas Hold'em itself is a traditional game with no single author.

- Live tables deal from a secret 256-bit table key: every hand's deck is shuffled from the ChaCha20 keystream under it
  (D. J. Bernstein's cipher, RFC 8439, in plain TypeScript in `shared/rng.ts`). The benchmark's deals come from public
  seeds through mulberry32, by Tommy Ettinger (public domain), which also drives the bots' coins and every sampled
  run-out.
- The bots' preflop hand strength is Bill Chen's formula (the Chen score).
- The table's duplicate format, every deal played from every seat, follows duplicate poker and duplicate bridge.
- The avatars were generated through Opper's image API (`scripts/avatars.ts`). The sounds in `public/audio/` were
  generated through Opper's audio API (ElevenLabs' sound-effects model) by a one-off script that is not kept here.
- `public/poster.png` is a still of a curated replay's best moment (Opus 5.5's river bluff in Claude vs GPT), drawn by
  the page's `#/still/` route and made by `scripts/poster.ts` (see the README).
- Fonts in `public/fonts/`, each under the SIL Open Font License 1.1: Fraunces (The Fraunces Project Authors, see
  `fraunces-OFL.txt`), Wix Madefor Display and Wix Madefor Text (The Wix Madefor Project Authors, see `wix-madefor-OFL.txt`), JetBrains Mono
  (The JetBrains Mono Project Authors, see `jetbrains-mono-OFL.txt`) and Caveat (The Caveat Project Authors, see `caveat-OFL.txt`).
