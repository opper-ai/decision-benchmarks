// Written by scripts/clips.ts: the highlight of each Watch recording in public/clips (an MP4 and a GIF), and their
// sizes in bytes, by recording file.
export const CLIPS: Record<string, { file: string; mp4: number; gif: number }> = {
  "luna-vs-jev.fight.json.gz": {
    "file": "luna-vs-jev",
    "mp4": 2248500,
    "gif": 1466074
  },
  "jev-vs-payoff.fight.json.gz": {
    "file": "jev-vs-payoff",
    "mp4": 1930210,
    "gif": 1511317
  },
  "jev-vs-maximin.fight.json.gz": {
    "file": "jev-vs-maximin",
    "mp4": 1087596,
    "gif": 892279
  },
  "jev-vs-greedy.fight.json.gz": {
    "file": "jev-vs-greedy",
    "mp4": 1921047,
    "gif": 1326849
  }
};
