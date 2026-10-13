/** Opper brand palette (opper-website brand kit + platform tokens). */
export const NAVY = '#1B2E40';
export const INDIGO = '#3C3CAF';
export const CYAN = '#8CECF2';
export const PEACH = '#F9B58C';
export const STAGE = '#F7F9FB';
export const MUTED = '#5B6B7A';

/** Per side: `fill` is the brand colour drawn on the fighter, `deep` the darker shade for UI marks and charts. */
export const SIDES = [
  { fill: PEACH, deep: '#E07B45', ghost: '#FCE3D3' },
  { fill: CYAN, deep: '#1FA3B3', ghost: '#D5F7F9' },
] as const;

export const OUTCOME_COLORS: Record<string, string> = {
  hit: '#177D38',
  traded: '#9A5C12',
  punished: '#C2255C',
  blocked: '#7A8794',
  whiffed: '#B8C1CA',
  defended: '#2A66A8',
  neutral: '#E3E8EE',
};

export const DISPLAY_FONT = '"Caveat", "Comic Sans MS", cursive';
