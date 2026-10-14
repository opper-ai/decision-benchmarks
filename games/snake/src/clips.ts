// Written by scripts/clips.ts: the highlight of each Watch recording in public/clips (an MP4 and a GIF), and their
// sizes in bytes, by model.
export const CLIPS: Record<string, { file: string; mp4: number; gif: number }> = {
  "openai/gpt-6-luna-decisions": {
    "file": "gpt-6-luna-decisions",
    "mp4": 236251,
    "gif": 201583
  },
  "typesafe/jev-1.13.0": {
    "file": "jev-1.13.0",
    "mp4": 230957,
    "gif": 185076
  },
  "empiriolabs/aplomb-1": {
    "file": "aplomb-1",
    "mp4": 231348,
    "gif": 198127
  },
  "azure:global/microsoft-decision-1": {
    "file": "microsoft-decision-1",
    "mp4": 244585,
    "gif": 196560
  },
  "cloudflare:global/clef-flash": {
    "file": "clef-flash",
    "mp4": 156761,
    "gif": 199570
  },
  "sference/clef": {
    "file": "clef",
    "mp4": 131765,
    "gif": 164610
  },
  "opper/kev-4b": {
    "file": "kev-4b",
    "mp4": 161943,
    "gif": 179790
  },
  "berget/convaiinnovations/laya": {
    "file": "laya",
    "mp4": 54322,
    "gif": 68595
  }
};
